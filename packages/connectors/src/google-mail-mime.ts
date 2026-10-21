/** MIME composition is shared by Gmail sends and drafts; reply headers stay owned by the caller. */
export function serializeRichEmail(headers: string[], input: {
  body: string;
  htmlBody?: string | undefined;
  attachments?: Array<{ filename: string; mimeType: string; content: string; contentId?: string | undefined }>;
}): string {
  const encode = (value: string) => {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  };
  const wrap = (value: string) => value.match(/.{1,76}/gu)?.join("\r\n") ?? ""; // RFC 2045 base64 line length.
  const text = (mime: string, body: string) => `Content-Type: ${mime}; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap(encode(body))}`;
  // Boundaries are generated after receipt admission, never caller-authored.
  const alternative = `rally_alt_${crypto.randomUUID()}`;
  const mixed = `rally_mixed_${crypto.randomUUID()}`;
  const content = input.htmlBody === undefined ? text("text/plain", input.body) :
    `Content-Type: multipart/alternative; boundary="${alternative}"\r\n\r\n--${alternative}\r\n${text("text/plain", input.body)}\r\n--${alternative}\r\n${text("text/html", input.htmlBody)}\r\n--${alternative}--`;
  if (!input.attachments?.length) return `${headers.join("\r\n")}\r\n${content}`;
  const files = input.attachments.map((attachment) => {
    // RFC 2231 filename* handles Unicode and quotes without header injection.
    const filename = encodeURIComponent(attachment.filename).replace(/['()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    return `Content-Type: ${attachment.mimeType}\r\nContent-Disposition: ${attachment.contentId ? "inline" : "attachment"}; filename*=UTF-8''${filename}\r\n${attachment.contentId ? `Content-ID: <${attachment.contentId}>\r\n` : ""}Content-Transfer-Encoding: base64\r\n\r\n${wrap(attachment.content)}`;
  });
  return `${headers.join("\r\n")}\r\nContent-Type: multipart/mixed; boundary="${mixed}"\r\n\r\n--${mixed}\r\n${[content, ...files].join(`\r\n--${mixed}\r\n`)}\r\n--${mixed}--`;
}
