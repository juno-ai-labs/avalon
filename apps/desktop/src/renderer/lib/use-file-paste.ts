import { useCallback } from 'react';

/**
 * Chromium hands a bitmap that was never a file on disk the generic name
 * `image.png`, while a file copied out of a file manager keeps its real one.
 * The distinction is what separates "the clipboard holds a picture" from "the
 * clipboard holds a picture *of* the text that was copied".
 */
const SYNTHESIZED_IMAGE_NAME = /^image\.[a-z0-9]+$/iu;

function isSynthesizedImage(file: File): boolean {
  return file.name.length === 0 || SYNTHESIZED_IMAGE_NAME.test(file.name);
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
 * synthesized image is dropped whenever the clipboard also carries text, while
 * a real file's own name proves it was not a rendering and it attaches either
 * way.
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
    const carried = clipboard.getData('text/plain').trim().length > 0
      ? files.filter((file) => !isSynthesizedImage(file))
      : files;
    if (carried.length === 0) return;
    // Taking the files means the composer keeps whatever text is already in it.
    event.preventDefault();
    const at = new Date();
    onFiles(carried.map((file) => isSynthesizedImage(file)
      ? new File([file], pastedImageName(file, at), { type: file.type, lastModified: file.lastModified })
      : file));
  }, [disabled, onFiles]);
}
