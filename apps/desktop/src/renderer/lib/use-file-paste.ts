import { useCallback, useEffect, useRef } from 'react';
import { LONG_PASTE_CHARACTERS, pastedTextFile } from './pasted-text';

/**
 * Chromium hands a bitmap that was never a file on disk the generic name
 * `image.png`. A real file can be called that too, so the name is only half the
 * signal for telling a synthesized picture from a copied one — `describesFiles`
 * supplies the other half.
 */
const GENERIC_IMAGE_NAME = /^image\.[a-z0-9]+$/iu;
const BARE_EXTENSION = /^[a-z0-9]+$/iu;
/** MIME subtypes whose spelling is not usable as a file extension. */
const EXTENSION_ALIASES: Record<string, string> = { 'svg+xml': 'svg', jpeg: 'jpg' };

/** Only an image can be a bitmap the clipboard synthesized; a nameless blob of some other type is a file. */
function isSynthesizedImage(file: File): boolean {
  return file.type.startsWith('image/')
    && (file.name.length === 0 || GENERIC_IMAGE_NAME.test(file.name));
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

function timestamp(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
    + ` at ${pad(at.getHours())}.${pad(at.getMinutes())}.${pad(at.getSeconds())}`;
}

function imageExtension(file: File): string {
  const named = file.name.includes('.') ? file.name.split('.').at(-1)! : '';
  if (BARE_EXTENSION.test(named)) return named.toLocaleLowerCase();
  const subtype = file.type.slice('image/'.length).toLocaleLowerCase();
  return EXTENSION_ALIASES[subtype] ?? (BARE_EXTENSION.test(subtype) ? subtype : 'png');
}

/**
 * Every synthesized clipboard image carries the same name, so a message holding
 * three pasted screenshots would show three tiles no one could tell apart. A
 * timestamp restores the distinction the clipboard threw away, and an ordinal
 * carries it through images that share one second — several in a single paste,
 * or two pastes in quick succession.
 */
function pastedImageName(file: File, stamp: string, ordinal: number): string {
  return `Pasted image ${stamp}${ordinal > 1 ? ` (${ordinal})` : ''}.${imageExtension(file)}`;
}

/** Both a React synthetic paste and a DOM one satisfy this. */
interface PasteEventLike {
  clipboardData: DataTransfer | null;
  preventDefault: () => void;
}

function claimPaste(
  event: PasteEventLike,
  onFiles: (files: File[]) => void,
  nextOrdinal: (stamp: string) => number,
  attachLongText: boolean,
): void {
  const clipboard = event.clipboardData;
  if (!clipboard) return;
  const files = Array.from(clipboard.files);
  const text = clipboard.getData('text/plain');
  // A path naming the files it arrived with is the system describing its own
  // clipboard, so it is not text anyone chose to copy.
  const fromDisk = files.length > 0 && describesFiles(text, files);
  const copied = fromDisk ? '' : text.trim();
  const carried = copied.length > 0 ? files.filter((file) => !isSynthesizedImage(file)) : files;
  const longText = attachLongText && copied.length >= LONG_PASTE_CHARACTERS;
  if (carried.length === 0 && !longText) return;
  // Copied text still pastes at the caret alongside its files unless it is long
  // enough to travel as a file itself; only a paste with nothing left to insert
  // is taken over outright.
  if (copied.length === 0 || longText) event.preventDefault();
  const stamp = timestamp(new Date());
  onFiles([
    ...carried.map((file) => !fromDisk && isSynthesizedImage(file)
      ? new File([file], pastedImageName(file, stamp, nextOrdinal(stamp)), {
        type: file.type,
        lastModified: file.lastModified,
      })
      : file),
    ...(longText ? [pastedTextFile(text, stamp, nextOrdinal(stamp))] : []),
  ]);
}

/** Keeps pastes that land in the same second apart without a shared clock. */
function useNameSequence(): (stamp: string) => number {
  const sequence = useRef({ stamp: '', used: 0 });
  return useCallback((stamp: string): number => {
    sequence.current = stamp === sequence.current.stamp
      ? { stamp, used: sequence.current.used + 1 }
      : { stamp, used: 1 };
    return sequence.current.used;
  }, []);
}

/**
 * Turns a clipboard carrying files into attachments, so a screenshot reaches a
 * work stream by ⌘V rather than by way of a saved file and the paperclip.
 *
 * The handler only claims what it is taking over: a clipboard with no files is
 * left to paste as text as before. Rich text copied out of a spreadsheet
 * arrives as text *plus* a rendering of that text, and there the text is what
 * was copied — so a generically named image is dropped whenever the clipboard
 * carries text a person actually copied. A file's own name and a path
 * describing it are each enough to prove it was not such a rendering, and it
 * attaches either way, with any copied text still pasting beside it.
 *
 * Copied text at or past `LONG_PASTE_CHARACTERS` attaches as a file of its
 * detected type instead of filling the field; see `pasted-text.ts`.
 */
export function useFilePaste(
  onFiles: (files: File[]) => void,
  disabled = false,
  /** False once the message holds all the files it can, so long text still pastes rather than vanishing. */
  roomForText = true,
): (event: React.ClipboardEvent<HTMLElement>) => void {
  const nextOrdinal = useNameSequence();
  return useCallback((event: React.ClipboardEvent<HTMLElement>): void => {
    if (disabled) return;
    claimPaste(event, onFiles, nextOrdinal, roomForText);
  }, [disabled, nextOrdinal, onFiles, roomForText]);
}

/** A text surface handles its own paste, and a dialog owns everything inside it. */
function handledElsewhere(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable
    || ['INPUT', 'TEXTAREA'].includes(target.tagName)
    || target.closest('[role="dialog"], [role="alertdialog"]') !== null;
}

/**
 * The same behavior for a paste that lands outside any text surface. Focus sits
 * on the document until something takes it, and only one of the composers
 * autofocuses, so a screenshot pasted straight after a screen opens would
 * otherwise go nowhere — while the same screenshot dragged onto the same screen
 * attaches. Anything with its own paste behavior is left alone.
 */
export function useWindowFilePaste(onFiles: (files: File[]) => void, disabled = false): void {
  const nextOrdinal = useNameSequence();
  const latest = useRef(onFiles);
  latest.current = onFiles;
  useEffect(() => {
    if (disabled) return;
    const listener = (event: ClipboardEvent): void => {
      if (event.defaultPrevented || handledElsewhere(event.target)) return;
      // Text with no field to land in is left alone, however long.
      claimPaste(event, latest.current, nextOrdinal, false);
    };
    window.addEventListener('paste', listener);
    return () => window.removeEventListener('paste', listener);
  }, [disabled, nextOrdinal]);
}
