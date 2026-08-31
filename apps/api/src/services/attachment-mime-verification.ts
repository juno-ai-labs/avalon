const GENERIC_MIME = "application/octet-stream";

const TEXTUAL_APPLICATION_MIME_TYPES = new Set([
  "application/graphql",
  "application/javascript",
  "application/json",
  "application/sql",
  "application/toml",
  "application/x-httpd-php",
  "application/x-javascript",
  "application/x-ndjson",
  "application/x-sh",
  "application/xhtml+xml",
  "application/xml",
  "application/yaml",
]);

const EXTENSION_TEXT_MIME_TYPES: Record<string, string> = {
  csv: "text/csv",
  graphql: "application/graphql",
  htm: "text/html",
  html: "text/html",
  js: "application/javascript",
  json: "application/json",
  jsonl: "application/x-ndjson",
  md: "text/markdown",
  mdown: "text/markdown",
  mdx: "text/markdown",
  sql: "application/sql",
  toml: "application/toml",
  ts: "text/plain",
  txt: "text/plain",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
};

/**
 * Return a server-verified canonical MIME. Client multipart metadata is only a
 * hint: binary parser selection requires a matching signature/OOXML structure,
 * and all text candidates must be valid UTF-8.
 */
export function verifyAttachmentMimeType(
  bytes: Uint8Array,
  fileName: string,
  declaredMimeType: string | null | undefined,
): string {
  if (hasPrefix(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (hasPrefix(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (hasAscii(bytes, 0, "GIF87a") || hasAscii(bytes, 0, "GIF89a")) return "image/gif";
  if (hasAscii(bytes, 0, "RIFF") && hasAscii(bytes, 8, "WEBP")) return "image/webp";
  if (hasPrefix(bytes, [0x49, 0x49, 0x2a, 0x00]) || hasPrefix(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return "image/tiff";
  if (hasAscii(bytes, 0, "ID3") || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)) return "audio/mpeg";
  if (hasAscii(bytes, 4, "ftyp") && /^(?:heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1)$/u.test(ascii(bytes, 8, 4))) {
    return "image/heif";
  }

  const officeMime = sniffOoxmlMime(bytes);
  if (officeMime) return officeMime;

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return GENERIC_MIME;
  }
  const extension = safeExtension(fileName);
  const extensionMime = extension ? EXTENSION_TEXT_MIME_TYPES[extension] : undefined;
  if (extensionMime) return extensionMime;
  const declared = canonicalDeclaredMime(declaredMimeType);
  if (declared.startsWith("text/") || TEXTUAL_APPLICATION_MIME_TYPES.has(declared)
    || declared.endsWith("+json") || declared.endsWith("+xml")) {
    return declared;
  }
  return "text/plain";
}

function sniffOoxmlMime(bytes: Uint8Array): string | null {
  if (!hasPrefix(bytes, [0x50, 0x4b, 0x03, 0x04])) return null;
  const names = zipCentralDirectoryNames(bytes);
  if (!names) return null;
  if (names.has("word/document.xml")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (names.has("ppt/presentation.xml")) {
    return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  }
  if (names.has("xl/workbook.xml")) {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  return null;
}

function zipCentralDirectoryNames(bytes: Uint8Array): Set<string> | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimum = Math.max(0, bytes.byteLength - 65_557);
  let eocd = -1;
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0 || eocd + 22 > bytes.byteLength) return null;
  const entryCount = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (entryCount > 10_000 || directorySize > 8 * 1_024 * 1_024
    || directoryOffset + directorySize > bytes.byteLength) return null;
  const names = new Set<string>();
  let offset = directoryOffset;
  for (let entry = 0; entry < entryCount; entry += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) return null;
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (nameLength > 1_024 || end > bytes.byteLength) return null;
    names.add(new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(offset + 46, offset + 46 + nameLength)));
    offset = end;
  }
  return names;
}

function canonicalDeclaredMime(value: string | null | undefined): string {
  const mime = (value ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mime) ? mime : GENERIC_MIME;
}

function safeExtension(fileName: string): string | null {
  const match = /\.([a-z0-9]{1,12})$/iu.exec(fileName.trim());
  return match?.[1]?.toLowerCase() ?? null;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return new TextDecoder("ascii").decode(bytes.subarray(start, start + length));
}

function hasAscii(bytes: Uint8Array, start: number, value: string): boolean {
  return ascii(bytes, start, value.length) === value;
}

function hasPrefix(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}
