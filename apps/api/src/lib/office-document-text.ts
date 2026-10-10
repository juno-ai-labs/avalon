import type { StoredDocumentTextReader } from "@rally/connectors";
import { unzipSync } from "fflate";

/**
 * Office Open XML (DOCX, PPTX, XLSX) to model-readable text.
 *
 * One converter for every place an Office file reaches the model: an uploaded
 * attachment's derivative and a file read from a provider's storage, such as
 * Google Drive, are the same bytes and must read the same way. The converter
 * is pure — it takes bytes the caller has already authorized and fetched, and
 * owns only the archive and XML guards that make an untrusted file safe to
 * expand inside an isolate. Connectors reach it through
 * `officeDocumentTextReader`, which the registry hands to an adapter that
 * stores files.
 */

/**
 * The largest source file the converter is offered. Shared with the attachment
 * derivative's own source ceiling, which set this number first.
 */
export const OFFICE_DOCUMENT_MAX_SOURCE_BYTES = 8 * 1_024 * 1_024;
const MAX_EXPANDED_OFFICE_BYTES = 12 * 1_024 * 1_024;
const MAX_OFFICE_XML_BYTES = 3 * 1_024 * 1_024;

export type OfficeDocumentFormat = "docx" | "pptx" | "xlsx";

export interface OfficeDocumentText {
  text: string;
  modelMimeType: "text/markdown" | "text/plain";
  metadata: {
    extractionMethod: OfficeDocumentFormat;
    sheetNames?: string[];
    slideCount?: number;
    omissions: string[];
  };
}

/** A conversion refusal whose `code` names what was wrong with the file. */
export class OfficeDocumentConversionError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const OFFICE_DOCUMENT_MIME_TYPES: Record<OfficeDocumentFormat, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/**
 * The Office format a file is, from its declared MIME type, or from its
 * extension when the declared type says nothing (`application/octet-stream`).
 */
export function officeDocumentFormat(mimeType: string | null, fileName: string): OfficeDocumentFormat | null {
  const mime = mimeType?.trim().toLowerCase() ?? "";
  for (const format of ["docx", "pptx", "xlsx"] as const) {
    if (mime === OFFICE_DOCUMENT_MIME_TYPES[format]) return format;
    if (genericMime(mime) && new RegExp(`\\.${format}$`, "iu").test(fileName)) return format;
  }
  return null;
}

/** The converter as a connector's stored-document reader. */
export const officeDocumentTextReader: StoredDocumentTextReader = {
  maxSourceBytes: OFFICE_DOCUMENT_MAX_SOURCE_BYTES,
  reads: (mimeType, fileName) => officeDocumentFormat(mimeType, fileName) !== null,
  read(bytes, mimeType, fileName) {
    const format = officeDocumentFormat(mimeType, fileName);
    if (!format) return { ok: false, code: "resource_format_unsupported" };
    try {
      return { ok: true, text: convertOfficeDocument(bytes, format).text };
    } catch (error) {
      if (error instanceof OfficeDocumentConversionError) return { ok: false, code: error.code };
      throw error;
    }
  },
};

export function convertOfficeDocument(bytes: Uint8Array, format: OfficeDocumentFormat): OfficeDocumentText {
  if (format === "docx") return convertDocx(bytes);
  if (format === "pptx") return convertPptx(bytes);
  return convertXlsx(bytes);
}

function convertDocx(bytes: Uint8Array): OfficeDocumentText {
  const entries = readOfficeArchive(bytes, (name) => /^word\/(?:document\.xml|_rels\/document\.xml\.rels|header\d+\.xml|footer\d+\.xml|footnotes\.xml|endnotes\.xml)$/u.test(name));
  const document = requiredXml(entries, "word/document.xml");
  const relationships = parseRelationships(entries["word/_rels/document.xml.rels"]);
  const sections: string[] = [renderWordBody(document, relationships)];
  appendNamedOfficeParts(sections, entries, /^word\/header(\d+)\.xml$/u, "Header");
  appendNamedOfficeParts(sections, entries, /^word\/footer(\d+)\.xml$/u, "Footer");
  appendSingleOfficePart(sections, entries, "word/footnotes.xml", "Footnotes");
  appendSingleOfficePart(sections, entries, "word/endnotes.xml", "Endnotes");
  return {
    text: sections.filter(Boolean).join("\n\n").trim(),
    modelMimeType: "text/markdown",
    metadata: { extractionMethod: "docx", omissions: ["embedded objects and tracked-change markup are not rendered"] },
  };
}

function renderWordBody(xml: string, relationships: Map<string, string>): string {
  const blocks: string[] = [];
  const body = /<w:body\b[^>]*>([\s\S]*?)<\/w:body>/u.exec(xml)?.[1] ?? xml;
  const blockPattern = /<w:(p|tbl)\b[^>]*>[\s\S]*?<\/w:\1>/gu;
  for (const match of body.matchAll(blockPattern)) {
    const block = match[0];
    if (match[1] === "tbl") {
      const table = renderWordTable(block);
      if (table) blocks.push(table);
      continue;
    }
    const paragraph = renderWordParagraph(block, relationships);
    if (paragraph) blocks.push(paragraph);
  }
  return blocks.join("\n\n");
}

function renderWordParagraph(xml: string, relationships: Map<string, string>): string {
  let text = xmlTextRuns(xml);
  for (const hyperlink of xml.matchAll(/<w:hyperlink\b([^>]*)>([\s\S]*?)<\/w:hyperlink>/gu)) {
    const label = xmlTextRuns(hyperlink[2] ?? "");
    const id = attribute(hyperlink[1] ?? "", "r:id");
    const target = id ? relationships.get(id) : undefined;
    if (label && target) text = text.replace(label, `[${label}](${escapeMarkdownUrl(target)})`);
  }
  if (!text) return "";
  const style = /<w:pStyle\b[^>]*(?:w:)?val="([^"]+)"/u.exec(xml)?.[1] ?? "";
  const heading = /^Heading([1-6])$/iu.exec(style)?.[1];
  if (heading) return `${"#".repeat(Number(heading))} ${text}`;
  if (/<w:numPr\b/u.test(xml)) return `- ${text}`;
  return text;
}

function renderWordTable(xml: string): string {
  const rows = [...xml.matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/gu)].map((row) =>
    [...(row[1] ?? "").matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/gu)].map((cell) => xmlTextRuns(cell[1] ?? "")),
  ).filter((row) => row.length > 0);
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => [...row, ...Array<string>(width - row.length).fill("")]);
  return [markdownRow(normalized[0] ?? []), markdownRow(Array<string>(width).fill("---")), ...normalized.slice(1).map(markdownRow)].join("\n");
}

function convertPptx(bytes: Uint8Array): OfficeDocumentText {
  const entries = readOfficeArchive(bytes, (name) => /^ppt\/(?:slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/u.test(name));
  const slides = Object.entries(entries)
    .filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/u.test(name))
    .sort(([left], [right]) => numericXmlOrder(left) - numericXmlOrder(right));
  if (slides.length === 0) throw new OfficeDocumentConversionError("invalid_office_archive");
  const rendered = slides.map(([name, xmlBytes]) => {
    const number = numericXmlOrder(name);
    const body = renderPresentationXml(decodeOfficeXml(xmlBytes));
    const notesBytes = entries[`ppt/notesSlides/notesSlide${number}.xml`];
    const notes = notesBytes ? renderPresentationXml(decodeOfficeXml(notesBytes)) : "";
    return `# Slide ${number}\n\n${body}${notes ? `\n\n## Speaker notes\n\n${notes}` : ""}`;
  });
  return {
    text: rendered.join("\n\n"),
    modelMimeType: "text/markdown",
    metadata: { extractionMethod: "pptx", slideCount: slides.length, omissions: ["charts and embedded media are represented only by available text"] },
  };
}

function renderPresentationXml(xml: string): string {
  const tables = [...xml.matchAll(/<a:tbl\b[^>]*>([\s\S]*?)<\/a:tbl>/gu)].map((match) => {
    const rows = [...(match[1] ?? "").matchAll(/<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/gu)].map((row) =>
      [...(row[1] ?? "").matchAll(/<a:tc\b[^>]*>([\s\S]*?)<\/a:tc>/gu)].map((cell) => xmlTextRuns(cell[1] ?? "", "a")),
    );
    if (rows.length === 0) return "";
    const width = Math.max(...rows.map((row) => row.length));
    return [markdownRow(rows[0] ?? []), markdownRow(Array<string>(width).fill("---")), ...rows.slice(1).map(markdownRow)].join("\n");
  }).filter(Boolean);
  const withoutTables = xml.replace(/<a:tbl\b[^>]*>[\s\S]*?<\/a:tbl>/gu, "");
  const paragraphs = [...withoutTables.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/gu)]
    .map((match) => xmlTextRuns(match[1] ?? "", "a")).filter(Boolean);
  return [...paragraphs, ...tables].join("\n\n");
}

function convertXlsx(bytes: Uint8Array): OfficeDocumentText {
  const entries = readOfficeArchive(bytes, (name) => name === "xl/workbook.xml"
    || name === "xl/_rels/workbook.xml.rels"
    || name === "xl/sharedStrings.xml"
    || /^xl\/worksheets\/sheet\d+\.xml$/u.test(name));
  const workbook = requiredXml(entries, "xl/workbook.xml");
  const relationships = parseRelationships(entries["xl/_rels/workbook.xml.rels"]);
  const shared = entries["xl/sharedStrings.xml"] ? sharedStrings(decodeOfficeXml(entries["xl/sharedStrings.xml"]!)) : [];
  const sheets = [...workbook.matchAll(/<sheet\b([^>]*)\/?\s*>/gu)].map((match, index) => ({
    name: decodeXml(attribute(match[1] ?? "", "name") ?? `Sheet ${index + 1}`),
    target: relationships.get(attribute(match[1] ?? "", "r:id") ?? "") ?? `worksheets/sheet${index + 1}.xml`,
  }));
  const fallbackSheets = sheets.length > 0 ? sheets : Object.keys(entries)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/u.test(name))
    .sort((left, right) => numericXmlOrder(left) - numericXmlOrder(right))
    .map((target, index) => ({ name: `Sheet ${index + 1}`, target: target.replace(/^xl\//u, "") }));
  if (fallbackSheets.length === 0) throw new OfficeDocumentConversionError("invalid_office_archive");
  const rendered = fallbackSheets.map((sheet) => {
    const target = normalizeXlsxTarget(sheet.target);
    const xmlBytes = entries[target];
    if (!xmlBytes) throw new OfficeDocumentConversionError("invalid_office_archive");
    const xml = decodeOfficeXml(xmlBytes);
    const cells = [...xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gu)].map((match) => {
      const attributes = match[1] ?? "";
      const body = match[2] ?? "";
      const ref = attribute(attributes, "r") ?? "?";
      const type = attribute(attributes, "t");
      const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/u.exec(body)?.[1]
        ?? /<t\b[^>]*>([\s\S]*?)<\/t>/u.exec(body)?.[1]
        ?? "";
      const display = type === "s" ? (shared[Number(raw)] ?? raw) : decodeXml(raw);
      const formula = /<f\b[^>]*>([\s\S]*?)<\/f>/u.exec(body)?.[1];
      return `${ref}: ${display}${formula ? ` (formula: ${decodeXml(formula)})` : ""}`;
    });
    return `# Sheet: ${sheet.name}\n\n${cells.join("\n")}`;
  });
  return {
    text: rendered.join("\n\n"),
    modelMimeType: "text/plain",
    metadata: { extractionMethod: "xlsx", sheetNames: fallbackSheets.map((sheet) => sheet.name), omissions: ["formatting and chart geometry are not rendered"] },
  };
}

/**
 * The shared-string table, one entry per `<si>`. A cell's `t="s"` value is an
 * index into this table, so the entries must line up with `<si>` exactly: a
 * rich-text string is several `<r><t>` runs inside one `<si>` and is one entry,
 * and phonetic guide text (`<rPh>`) is annotation, not part of the value.
 */
function sharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gu)].map((item) =>
    [...(item[1] ?? "").replace(/<rPh\b[^>]*>[\s\S]*?<\/rPh>/gu, "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gu)]
      .map((run) => decodeXml(run[1] ?? ""))
      .join(""),
  );
}

function readOfficeArchive(
  bytes: Uint8Array,
  accept: (name: string) => boolean,
): Record<string, Uint8Array> {
  if (
    bytes.byteLength >= 8
    && bytes[0] === 0xd0
    && bytes[1] === 0xcf
    && bytes[2] === 0x11
    && bytes[3] === 0xe0
    && bytes[4] === 0xa1
    && bytes[5] === 0xb1
    && bytes[6] === 0x1a
    && bytes[7] === 0xe1
  ) {
    throw new OfficeDocumentConversionError("office_encryption_unsupported");
  }
  let expanded = 0;
  try {
    return unzipSync(bytes, {
      filter(entry) {
        if (unsafeArchivePath(entry.name) || !accept(entry.name)) return false;
        if (entry.originalSize > MAX_OFFICE_XML_BYTES) throw new OfficeDocumentConversionError("office_xml_too_large");
        expanded += entry.originalSize;
        if (expanded > MAX_EXPANDED_OFFICE_BYTES) throw new OfficeDocumentConversionError("office_archive_too_large");
        return true;
      },
    });
  } catch (error) {
    if (error instanceof OfficeDocumentConversionError) throw error;
    throw new OfficeDocumentConversionError("invalid_office_archive");
  }
}

function requiredXml(entries: Record<string, Uint8Array>, name: string): string {
  const bytes = entries[name];
  if (!bytes) throw new OfficeDocumentConversionError("invalid_office_archive");
  return decodeOfficeXml(bytes);
}

function decodeOfficeXml(bytes: Uint8Array): string {
  try {
    const xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) throw new OfficeDocumentConversionError("office_xml_entities_forbidden");
    return xml;
  } catch (error) {
    if (error instanceof OfficeDocumentConversionError) throw error;
    throw new OfficeDocumentConversionError("invalid_office_xml");
  }
}

function parseRelationships(bytes: Uint8Array | undefined): Map<string, string> {
  const relationships = new Map<string, string>();
  if (!bytes) return relationships;
  const xml = decodeOfficeXml(bytes);
  for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?\s*>/gu)) {
    const id = attribute(match[1] ?? "", "Id");
    const target = attribute(match[1] ?? "", "Target");
    if (id && target) relationships.set(id, decodeXml(target));
  }
  return relationships;
}

function appendNamedOfficeParts(
  sections: string[], entries: Record<string, Uint8Array>, pattern: RegExp, label: string,
): void {
  for (const [name, bytes] of Object.entries(entries)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    const number = pattern.exec(name)?.[1];
    pattern.lastIndex = 0;
    if (!number) continue;
    const text = xmlTextRuns(decodeOfficeXml(bytes));
    if (text) sections.push(`## ${label} ${number}\n\n${text}`);
  }
}

function appendSingleOfficePart(
  sections: string[], entries: Record<string, Uint8Array>, name: string, label: string,
): void {
  const bytes = entries[name];
  if (!bytes) return;
  const text = xmlTextRuns(decodeOfficeXml(bytes));
  if (text) sections.push(`## ${label}\n\n${text}`);
}

function xmlTextRuns(xml: string, prefix = "w"): string {
  return [...xml.matchAll(new RegExp(`<${prefix}:t\\b[^>]*>([\\s\\S]*?)<\\/${prefix}:t>`, "gu"))]
    .map((match) => decodeXml(match[1] ?? ""))
    .join("")
    .trim();
}

function attribute(attributes: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|\\s)${escaped}="([^"]*)"`, "u").exec(attributes)?.[1] ?? null;
}

function markdownRow(cells: string[]): string {
  return `| ${cells.map((cell) => cell.replace(/\|/gu, "\\|").replace(/\s+/gu, " ").trim()).join(" | ")} |`;
}

function normalizeXlsxTarget(target: string): string {
  const clean = target.replace(/^\/+|\.\//gu, "");
  return clean.startsWith("xl/") ? clean : `xl/${clean}`;
}

function unsafeArchivePath(name: string): boolean {
  return name.startsWith("/") || name.includes("\\") || name.split("/").includes("..");
}

function numericXmlOrder(value: string): number {
  return Number(/(\d+)\.xml$/u.exec(value)?.[1] ?? Number.MAX_SAFE_INTEGER);
}

function genericMime(mime: string): boolean {
  return mime === "" || mime === "application/octet-stream" || mime === "binary/octet-stream";
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&quot;/gu, "\"")
    .replace(/&apos;/gu, "'").replace(/&amp;/gu, "&")
    .replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function escapeMarkdownUrl(value: string): string {
  return value.replace(/[()\s]/gu, (character) => encodeURIComponent(character));
}
