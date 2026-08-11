import { useCallback } from 'react';

/**
 * Chromium hands a bitmap that was never a file on disk the generic name
 * `image.png`. A real file can be called that too, so the name is only half the
 * signal for telling a synthesized picture from a copied one — `describesFiles`
 * supplies the other half.
 */
const SYNTHESIZED_IMAGE_NAME = /^image\.[a-z0-9]+$/iu;

function isGenericImageName(file: File): boolean {
  return file.name.length === 0 || SYNTHESIZED_IMAGE_NAME.test(file.name);
}

function basename(line: string): string {
  const path = line.startsWith('file://') ? decodeURIComponent(line.slice('file://'.length)) : line;
  return path.split(/[/\\]/u).at(-1) ?? path;
}

/**
 * A file manager copies a file by putting the file *and* its path on the
 * clipboard, and that path is the system describing what it just handed over
 * rather than text a person chose to copy. Recognizing it is what lets a real
 * `image.png` on disk keep both its attachment and its name, since the name
 * alone cannot tell it apart from a bitmap the clipboard synthesized.
 */
function describesFiles(text: string, files: File[]): boolean {
  const names = new Set(files.map((file) => file.name));
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  return lines.length > 0 && lines.every((line) => names.has(basename(line)));
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Every synthesized clipboard image carries the same name, so a message holding
 * three pasted screenshots would show three tiles no one could tell apart. A
 * timestamp restores the distinction the clipboard threw away.
 */
function pastedImageName(file: File, at: Date): string {
  const extension = file.name.includes('.')
    ? file.name.split('.').at(-1)!
    : (file.type.split('/').at(-1) || 'png');
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
    + ` at ${pad(at.getHours())}.${pad(at.getMinutes())}.${pad(at.getSeconds())}`;
  return `Pasted image ${stamp}.${extension}`;
}

/**
 * Turns a clipboard carrying files into attachments, so a screenshot reaches a
 * work stream by ⌘V rather than by way of a saved file and the paperclip.
 *
 * The handler runs on the text surface itself and only claims a paste it is
 * taking over: a clipboard with no files is left to paste as text as before.
 * Rich text copied out of a spreadsheet or a document arrives as text *plus* a
 * rendering of that text, and there the text is what was copied — so a
 * generically named image is dropped whenever the clipboard carries text a
 * person actually copied. A file's own name and a path describing it are each
 * enough to prove it was not such a rendering, and it attaches either way.
 */
export function useFilePaste(
  onFiles: (files: File[]) => void,
  disabled = false,
): (event: React.ClipboardEvent<HTMLElement>) => void {
  return useCallback((event: React.ClipboardEvent<HTMLElement>): void => {
    if (disabled) return;
    const clipboard = event.clipboardData;
    const files = clipboard ? Array.from(clipboard.files) : [];
    if (files.length === 0) return;
    const text = clipboard.getData('text/plain');
    const fromDisk = describesFiles(text, files);
    const carried = !fromDisk && text.trim().length > 0
      ? files.filter((file) => !isGenericImageName(file))
      : files;
    if (carried.length === 0) return;
    // Taking the files means the composer keeps whatever text is already in it.
    event.preventDefault();
    const at = new Date();
    onFiles(carried.map((file) => !fromDisk && isGenericImageName(file)
      ? new File([file], pastedImageName(file, at), { type: file.type, lastModified: file.lastModified })
      : file));
  }, [disabled, onFiles]);
}
