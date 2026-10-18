/**
 * Long pasted text becomes an attachment rather than a wall of text in the
 * composer. The client only marks the file; the API decides its type and
 * name (`services/pasted-text-service.ts`) while the tile shows a skeleton.
 */

/**
 * How long a paste has to be, in UTF-16 code units, before it attaches instead
 * of landing at the caret. A product choice rather than a derived bound: it is
 * where a paste stops being a message and starts being a document.
 */
export const LONG_PASTE_CHARACTERS = 5_000;

/**
 * Files the upload hands to the API to type and name. A WeakSet rather than a
 * field on the file, so every surface that hands files to the attachment hook
 * keeps its signature. The draft cache records the mark and restores it onto
 * the rebuilt `File`, so switching away and back keeps the paste a paste.
 */
const pastedText = new WeakSet<File>();

export function isPastedText(file: File): boolean {
  return pastedText.has(file);
}

export function markPastedText(file: File): File {
  pastedText.add(file);
  return file;
}

/** The attachment a long paste becomes, under a stand-in name the API replaces. */
export function pastedTextFile(text: string, stamp: string, ordinal: number): File {
  return markPastedText(new File([text], `Pasted text ${stamp}${ordinal > 1 ? ` (${ordinal})` : ''}.txt`, { type: 'text/plain' }));
}
