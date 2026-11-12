/** Shared header encoding for published and attached files. */
function safeFilename(value: string): string {
  return value.replace(/[\r\n"\\]/gu, "_").slice(0, 180) || "attachment";
}

export function contentDisposition(disposition: "attachment" | "inline", fileName: string): string {
  const safe = safeFilename(fileName);
  const asciiFallback = safe.replace(/[^\x20-\x7e]/gu, "_");
  const encoded = encodeURIComponent(safe)
    .replace(/[!'()*]/gu, (character) => `%${character.codePointAt(0)!.toString(16).toUpperCase()}`);
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}
