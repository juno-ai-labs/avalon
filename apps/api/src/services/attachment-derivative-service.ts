import { ATTACHMENT_CONVERTER_TIMEOUT_MS, ATTACHMENT_PROCESSING_LEASE_MS, classifyAttachmentKind } from "@rally/contracts";
import { unzipSync } from "fflate";
import { releaseStagedResourceObject } from "./resource-object-cleanup";

export const ATTACHMENT_TEXT_EXTRACTOR_VERSION = "attachment-text-v2";

// Local conversion is an isolate-safe fast path. Provider-backed PDF OCR and
// the document summarizer remain separate calls; no single conversion is
// allowed to materialize the former 50 MiB/20M-character envelope in memory.
const MAX_SOURCE_BYTES = 8 * 1_024 * 1_024;
const MAX_EXPANDED_OFFICE_BYTES = 12 * 1_024 * 1_024;
const MAX_OFFICE_XML_BYTES = 3 * 1_024 * 1_024;
const MAX_DERIVATIVE_CHARACTERS = 2_000_000;
const MAX_PDF_PAGES = 200;

export interface AttachmentPdfText {
  pageCount: number;
  pages: string[];
}

export interface AttachmentOcrText {
  pages: string[];
  method: "provider_ocr";
}

export interface BuildAttachmentDerivativeInput {
  bytes: Uint8Array;
  fileName: string;
  mimeType: string | null;
  pdfExtractor?: (bytes: Uint8Array) => Promise<AttachmentPdfText>;
  ocr?: (bytes: Uint8Array, pageCount: number) => Promise<AttachmentOcrText>;
  signal?: AbortSignal;
  /** Test seam and emergency lower bound; production uses 30 seconds. */
  timeoutMs?: number;
}

export interface DerivativeMetadata {
  extractionMethod: "utf8" | "docx" | "pptx" | "xlsx" | "pdf_text" | "provider_ocr";
  pageCount?: number;
  sheetNames?: string[];
  slideCount?: number;
  omissions: string[];
}

export type AttachmentDerivativeResult =
  | {
      status: "ready";
      text: string;
      modelMimeType: "text/markdown" | "text/plain";
      extractorVersion: string;
      metadata: DerivativeMetadata;
    }
  | {
      status: "failed" | "unsupported";
      errorCode: string;
    };

export interface AuthorizedDerivativeResource {
  id: string;
  workspaceId: string;
  fileName: string;
  mimeType: string | null;
  contentRef: string | null;
  contentSha256: string | null;
  modelContentRef: string | null;
  modelMimeType: string | null;
  modelContentSha256: string | null;
  modelContentStatus: "pending" | "processing" | "ready" | "failed" | "unsupported" | null;
  modelContentExtractorVersion: string | null;
  modelContentCharacterCount: number | null;
  modelContentClaimedAt: string | null;
  modelContentClaimId: string | null;
  modelContentErrorCode?: string | null;
}

export type MaterializedAttachmentDerivative =
  | {
      status: "ready";
      contentRef: string;
      modelMimeType: string;
      sha256: string;
      extractorVersion: string;
      totalCharacters: number;
    }
  | { status: "processing"; retryAfterMs: number }
  | { status: "failed" | "unsupported"; errorCode: string };

export interface MaterializeAttachmentDerivativeOptions {
  pdfExtractor?: BuildAttachmentDerivativeInput["pdfExtractor"];
  ocr?: BuildAttachmentDerivativeInput["ocr"];
  signal?: AbortSignal;
  now?: () => Date;
  /** Content-free phase telemetry; callback failures never affect conversion. */
  onPhase?: (event: AttachmentDerivativePhaseEvent) => void;
}

export interface AttachmentDerivativePhaseEvent {
  phase: "source_read" | "claim" | "convert" | "publish";
  outcome: "ready" | "failed" | "unsupported" | "processing";
  durationMs: number;
  errorCode?: string;
}

interface ConvertedText {
  text: string;
  modelMimeType: "text/markdown" | "text/plain";
  metadata: DerivativeMetadata;
}

class ConversionFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/**
 * Converts already-authorized source bytes into reusable model text. This
 * function deliberately performs no workspace or relationship authorization.
 */
export async function buildAttachmentDerivative(
  input: BuildAttachmentDerivativeInput,
): Promise<AttachmentDerivativeResult> {
  if (input.bytes.byteLength === 0) return { status: "failed", errorCode: "empty_source" };
  if (input.bytes.byteLength > MAX_SOURCE_BYTES) return { status: "failed", errorCode: "source_too_large" };
  if (input.signal?.aborted) return { status: "failed", errorCode: "conversion_aborted" };

  try {
    const converted = await withTimeout(
      () => convertAttachment(input),
      input.timeoutMs ?? ATTACHMENT_CONVERTER_TIMEOUT_MS,
      input.signal,
    );
    if (!converted) return { status: "unsupported", errorCode: "resource_format_unsupported" };
    if (converted.text.length > MAX_DERIVATIVE_CHARACTERS) {
      return { status: "failed", errorCode: "derivative_too_large" };
    }
    return {
      status: "ready",
      ...converted,
      extractorVersion: ATTACHMENT_TEXT_EXTRACTOR_VERSION,
    };
  } catch (error) {
    if (error instanceof ConversionFailure) return { status: "failed", errorCode: error.code };
    return { status: "failed", errorCode: "conversion_failed" };
  }
}

/**
 * Materializes a reusable text derivative after the caller has authorized the
 * resource. WorkspaceDO owns the claim/current pointer; R2 objects become
 * visible to readers only after the final conditional row update succeeds.
 */
export async function materializeAttachmentDerivative(
  database: D1Database,
  payloads: R2Bucket,
  resource: AuthorizedDerivativeResource,
  options: MaterializeAttachmentDerivativeOptions = {},
): Promise<MaterializedAttachmentDerivative> {
  const now = (options.now ?? (() => new Date()))();
  const at = now.toISOString();
  const staleBefore = new Date(now.getTime() - ATTACHMENT_PROCESSING_LEASE_MS).toISOString();
  const claimId = crypto.randomUUID();
  if (!resource.contentRef) return updateTerminalState(database, resource, "failed", "source_unavailable", options);
  if (isReadyCurrentVersion(resource)) {
    return {
      status: "ready",
      contentRef: resource.modelContentRef!,
      modelMimeType: resource.modelMimeType!,
      sha256: resource.modelContentSha256!,
      extractorVersion: ATTACHMENT_TEXT_EXTRACTOR_VERSION,
      totalCharacters: resource.modelContentCharacterCount!,
    };
  }
  if ((resource.modelContentStatus === "failed" || resource.modelContentStatus === "unsupported")
    && resource.modelContentExtractorVersion === ATTACHMENT_TEXT_EXTRACTOR_VERSION) {
    return {
      status: resource.modelContentStatus,
      errorCode: resource.modelContentErrorCode ?? (resource.modelContentStatus === "unsupported"
        ? "resource_format_unsupported"
        : "conversion_failed"),
    };
  }
  if (resource.modelContentStatus === "processing"
    && resource.modelContentExtractorVersion === ATTACHMENT_TEXT_EXTRACTOR_VERSION
    && resource.modelContentClaimedAt !== null
    && resource.modelContentClaimId !== null
    && resource.modelContentClaimedAt > staleBefore) {
    return { status: "processing", retryAfterMs: 1_000 };
  }

  const sourceReadStartedAt = Date.now();
  const object = await payloads.get(resource.contentRef);
  if (!object) {
    emitDerivativePhase(options, sourceReadStartedAt, "source_read", "failed", "source_unavailable");
    return updateTerminalState(database, resource, "failed", "source_unavailable", options);
  }
  if (object.size > MAX_SOURCE_BYTES) {
    emitDerivativePhase(options, sourceReadStartedAt, "source_read", "failed", "source_too_large");
    return updateTerminalState(database, resource, "failed", "source_too_large", options);
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  const sourceSha256 = resource.contentSha256 ?? await sha256Hex(bytes);
  if (!resource.contentSha256) {
    const hashUpdate = await database.prepare(
      `UPDATE resources SET content_sha256 = ?, updated_at = ?
       WHERE workspace_id = ? AND id = ? AND content_ref = ? AND content_sha256 IS NULL`,
    ).bind(sourceSha256, at, resource.workspaceId, resource.id, resource.contentRef).run();
    if ((hashUpdate.meta.changes ?? 0) === 0) {
      emitDerivativePhase(options, sourceReadStartedAt, "source_read", "processing");
      return { status: "processing", retryAfterMs: 250 };
    }
  }
  emitDerivativePhase(options, sourceReadStartedAt, "source_read", "ready");

  const claimStartedAt = Date.now();
  const claim = await database.prepare(
    `UPDATE resources
        SET model_content_status = 'processing', model_content_extractor_version = ?,
            model_content_claimed_at = ?, model_content_claim_id = ?,
            model_content_error_code = NULL, updated_at = ?
      WHERE workspace_id = ? AND id = ? AND content_ref = ? AND content_sha256 = ?
        AND (model_content_status IS NOT 'processing'
          OR model_content_extractor_version IS NOT ?
          OR model_content_claimed_at IS NULL
          OR model_content_claim_id IS NULL
          OR model_content_claimed_at <= ?)`,
  ).bind(
    ATTACHMENT_TEXT_EXTRACTOR_VERSION, at, claimId, at, resource.workspaceId, resource.id, resource.contentRef,
    sourceSha256, ATTACHMENT_TEXT_EXTRACTOR_VERSION, staleBefore,
  ).run();
  if ((claim.meta.changes ?? 0) === 0) {
    emitDerivativePhase(options, claimStartedAt, "claim", "processing");
    return { status: "processing", retryAfterMs: 1_000 };
  }
  emitDerivativePhase(options, claimStartedAt, "claim", "ready");

  const convertStartedAt = Date.now();
  const converted = await buildAttachmentDerivative({
    bytes,
    fileName: resource.fileName,
    mimeType: resource.mimeType,
    ...(options.pdfExtractor ? { pdfExtractor: options.pdfExtractor } : {}),
    ...(options.ocr ? { ocr: options.ocr } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  emitDerivativePhase(
    options,
    convertStartedAt,
    "convert",
    converted.status,
    converted.status === "ready" ? undefined : converted.errorCode,
  );
  if (converted.status !== "ready") {
    if (converted.status === "failed" && converted.errorCode === "conversion_aborted") {
      await releaseDerivativeClaim(database, resource, options, claimId);
      return { status: "processing", retryAfterMs: 250 };
    }
    return updateTerminalState(
      database,
      { ...resource, contentSha256: sourceSha256 },
      converted.status,
      converted.errorCode,
      options,
      claimId,
    );
  }

  const prefix = derivativeObjectPrefix(resource.id, sourceSha256, converted.extractorVersion, crypto.randomUUID());
  const contentRef = `${prefix}/content.${converted.modelMimeType === "text/markdown" ? "md" : "txt"}`;
  const contentBytes = new TextEncoder().encode(converted.text);
  const derivativeSha256 = await sha256Hex(contentBytes);
  const publishStartedAt = Date.now();
  // Register the unique generation key before the R2 write. A failed
  // write, stale publisher, or failed WorkspaceDO publication remains
  // recoverable by the regional cleanup worker; a successful active pointer
  // cancels the object-local outbox row.
  await database.prepare(
    `INSERT OR IGNORE INTO resource_object_deletion_outbox
      (object_ref, workspace_id, resource_id, object_kind, cleanup_eligible, created_at, updated_at)
     VALUES (?, ?, ?, 'derivative', 0, ?, ?)`,
  ).bind(contentRef, resource.workspaceId, resource.id, at, at).run();
  try {
    await payloads.put(contentRef, exactArrayBuffer(contentBytes), {
      httpMetadata: { contentType: `${converted.modelMimeType}; charset=utf-8` },
      customMetadata: { originalResourceId: resource.id, sourceSha256, extractorVersion: converted.extractorVersion, sha256: derivativeSha256 },
    });
  } catch (error) {
    await releaseStagedResourceObject(database, resource.workspaceId, contentRef);
    throw error;
  }
  try {
    const result = await database.prepare(
      `UPDATE resources
          SET model_content_ref = ?, model_mime_type = ?, model_content_sha256 = ?,
              model_metadata_json = ?, model_content_status = 'ready',
              model_content_extractor_version = ?, model_content_character_count = ?,
              model_content_extracted_at = ?, model_content_claimed_at = NULL,
              model_content_claim_id = NULL, model_content_error_code = NULL, updated_at = ?
        WHERE workspace_id = ? AND id = ? AND content_ref = ? AND content_sha256 = ?
          AND model_content_status = 'processing' AND model_content_extractor_version = ?
          AND model_content_claim_id = ?`,
    ).bind(
      contentRef, converted.modelMimeType, derivativeSha256,
      JSON.stringify(converted.metadata), converted.extractorVersion,
      converted.text.length, at, at, resource.workspaceId, resource.id, resource.contentRef,
      sourceSha256, converted.extractorVersion, claimId,
    ).run();
    if ((result.meta.changes ?? 0) === 0) {
      await releaseStagedResourceObject(database, resource.workspaceId, contentRef);
      emitDerivativePhase(options, publishStartedAt, "publish", "processing");
      return { status: "processing", retryAfterMs: 250 };
    }
  } catch (error) {
    // An RPC failure cannot say whether WorkspaceDO committed the pointer.
    // Leave the object staged so a committed pointer never loses its bytes.
    emitDerivativePhase(options, publishStartedAt, "publish", "failed", "publication_failed");
    throw error;
  }
  emitDerivativePhase(options, publishStartedAt, "publish", "ready");
  return {
    status: "ready", contentRef, modelMimeType: converted.modelMimeType,
    sha256: derivativeSha256, extractorVersion: converted.extractorVersion,
    totalCharacters: converted.text.length,
  };
}

function emitDerivativePhase(
  options: MaterializeAttachmentDerivativeOptions,
  startedAt: number,
  phase: AttachmentDerivativePhaseEvent["phase"],
  outcome: AttachmentDerivativePhaseEvent["outcome"],
  errorCode?: string,
): void {
  try {
    options.onPhase?.({
      phase,
      outcome,
      durationMs: Math.max(0, Date.now() - startedAt),
      ...(errorCode ? { errorCode } : {}),
    });
  } catch {
    // Observability is intentionally outside the materialization outcome.
  }
}

async function releaseDerivativeClaim(
  database: D1Database,
  resource: AuthorizedDerivativeResource,
  options: MaterializeAttachmentDerivativeOptions,
  claimId: string,
): Promise<void> {
  const at = (options.now ?? (() => new Date()))().toISOString();
  await database.prepare(
    `UPDATE resources
        SET model_content_status = 'pending', model_content_claimed_at = NULL,
            model_content_claim_id = NULL, model_content_error_code = NULL, updated_at = ?
      WHERE workspace_id = ? AND id = ? AND content_ref IS ?
        AND model_content_status = 'processing' AND model_content_claim_id = ?`,
  ).bind(at, resource.workspaceId, resource.id, resource.contentRef, claimId).run();
}

/**
 * Bounded scanned-PDF fallback shared by model tools and person-facing previews.
 * Workers AI returns one ordered Markdown document rather than page boundaries,
 * so the known page cardinality is preserved while the unavailable boundaries
 * remain explicit empty entries.
 */
export async function ocrPdfWithWorkersAi(
  ai: Ai,
  title: string,
  bytes: Uint8Array,
  pageCount: number,
  signal: AbortSignal,
): Promise<AttachmentOcrText> {
  if (signal.aborted) throw signal.reason;
  const response = await ai.toMarkdown({
    name: title.toLowerCase().endsWith(".pdf") ? title : `${title}.pdf`,
    blob: new Blob([exactArrayBuffer(bytes)], { type: "application/pdf" }),
  }, {
    conversionOptions: {
      output: { format: "text" },
      pdf: { images: { convert: true, maxConvertedImages: Math.min(pageCount, MAX_PDF_PAGES) } },
    },
  });
  if (signal.aborted) throw signal.reason;
  if (response.format === "error" || response.data.trim().length === 0) {
    throw new Error("pdf_ocr_failed");
  }
  return {
    pages: [response.data, ...Array.from({ length: Math.max(0, pageCount - 1) }, () => "")],
    method: "provider_ocr",
  };
}

export function derivativeObjectPrefix(resourceId: string, sourceSha256: string, extractorVersion: string, generation = "current"): string {
  const safeVersion = extractorVersion.replace(/[^a-zA-Z0-9._-]/gu, "_").slice(0, 100);
  const safeGeneration = generation.replace(/[^a-zA-Z0-9._-]/gu, "_").slice(0, 100);
  return `model-derivatives/${resourceId}/${sourceSha256}/${safeVersion}/${safeGeneration}`;
}

async function convertAttachment(input: BuildAttachmentDerivativeInput): Promise<ConvertedText | null> {
  const mime = input.mimeType?.trim().toLowerCase() ?? "";
  const kind = classifyAttachmentKind({ mimeType: mime, fileName: input.fileName });
  if (kind === "pdf" && isPdf(mime, input.fileName)) return convertPdf(input);
  if (kind === "document" && isDocx(mime, input.fileName)) return convertDocx(input.bytes);
  if (kind === "presentation" && isPptx(mime, input.fileName)) return convertPptx(input.bytes);
  if (kind === "spreadsheet" && isXlsx(mime, input.fileName)) return convertXlsx(input.bytes);
  if (isPlainText(mime, input.fileName)) {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
    } catch {
      throw new ConversionFailure("invalid_utf8");
    }
    return {
      text,
      modelMimeType: mime === "text/markdown" || /\.md(?:own)?$/iu.test(input.fileName) ? "text/markdown" : "text/plain",
      metadata: { extractionMethod: "utf8", omissions: [] },
    };
  }
  return null;
}

function convertDocx(bytes: Uint8Array): ConvertedText {
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

function convertPptx(bytes: Uint8Array): ConvertedText {
  const entries = readOfficeArchive(bytes, (name) => /^ppt\/(?:slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/u.test(name));
  const slides = Object.entries(entries)
    .filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/u.test(name))
    .sort(([left], [right]) => numericXmlOrder(left) - numericXmlOrder(right));
  if (slides.length === 0) throw new ConversionFailure("invalid_office_archive");
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

function convertXlsx(bytes: Uint8Array): ConvertedText {
  const entries = readOfficeArchive(bytes, (name) => name === "xl/workbook.xml"
    || name === "xl/_rels/workbook.xml.rels"
    || name === "xl/sharedStrings.xml"
    || /^xl\/worksheets\/sheet\d+\.xml$/u.test(name));
  const workbook = requiredXml(entries, "xl/workbook.xml");
  const relationships = parseRelationships(entries["xl/_rels/workbook.xml.rels"]);
  const shared = entries["xl/sharedStrings.xml"] ? xmlTagValues(decodeOfficeXml(entries["xl/sharedStrings.xml"]!), "t") : [];
  const sheets = [...workbook.matchAll(/<sheet\b([^>]*)\/?\s*>/gu)].map((match, index) => ({
    name: decodeXml(attribute(match[1] ?? "", "name") ?? `Sheet ${index + 1}`),
    target: relationships.get(attribute(match[1] ?? "", "r:id") ?? "") ?? `worksheets/sheet${index + 1}.xml`,
  }));
  const fallbackSheets = sheets.length > 0 ? sheets : Object.keys(entries)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/u.test(name))
    .sort((left, right) => numericXmlOrder(left) - numericXmlOrder(right))
    .map((target, index) => ({ name: `Sheet ${index + 1}`, target: target.replace(/^xl\//u, "") }));
  if (fallbackSheets.length === 0) throw new ConversionFailure("invalid_office_archive");
  const rendered = fallbackSheets.map((sheet) => {
    const target = normalizeXlsxTarget(sheet.target);
    const xmlBytes = entries[target];
    if (!xmlBytes) throw new ConversionFailure("invalid_office_archive");
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

async function convertPdf(input: BuildAttachmentDerivativeInput): Promise<ConvertedText> {
  // PDF.js may transfer and detach the supplied ArrayBuffer. OCR needs the
  // original bytes after text-layer detection, so extraction receives its own
  // bounded copy rather than consuming the only source buffer.
  const extracted = await (input.pdfExtractor ?? defaultPdfExtractor)(input.bytes.slice());
  assertPageCount(extracted.pageCount);
  if (extracted.pages.length !== extracted.pageCount) throw new ConversionFailure("pdf_page_count_mismatch");
  const visibleCharacters = extracted.pages.reduce((sum, page) => sum + page.replace(/\s/gu, "").length, 0);
  if (visibleCharacters >= Math.max(5, extracted.pageCount * 5)) {
    return {
      text: renderPdfPages(extracted.pages),
      modelMimeType: "text/markdown",
      metadata: { extractionMethod: "pdf_text", pageCount: extracted.pageCount, omissions: [] },
    };
  }
  if (!input.ocr) throw new ConversionFailure("pdf_ocr_required");
  let ocr: AttachmentOcrText;
  try {
    ocr = await input.ocr(input.bytes, extracted.pageCount);
  } catch (error) {
    if (error instanceof ConversionFailure) throw error;
    throw new ConversionFailure("pdf_ocr_failed");
  }
  if (ocr.pages.length !== extracted.pageCount || ocr.pages.every((page) => page.trim().length === 0)) {
    throw new ConversionFailure("pdf_ocr_incomplete");
  }
  return {
    text: renderPdfPages(ocr.pages),
    modelMimeType: "text/markdown",
    metadata: { extractionMethod: ocr.method, pageCount: extracted.pageCount, omissions: ["OCR may not preserve visual layout exactly"] },
  };
}

async function defaultPdfExtractor(bytes: Uint8Array): Promise<AttachmentPdfText> {
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(bytes);
    try {
      assertPageCount(pdf.numPages);
      const result = await extractText(pdf, { mergePages: false });
      return { pageCount: result.totalPages, pages: result.text };
    } finally {
      await pdf.cleanup();
    }
  } catch (error) {
    if (error instanceof ConversionFailure) throw error;
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    throw new ConversionFailure(message.includes("password") ? "pdf_encrypted" : "invalid_pdf");
  }
}

function readOfficeArchive(bytes: Uint8Array, accept: (name: string) => boolean): Record<string, Uint8Array> {
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
    throw new ConversionFailure("office_encryption_unsupported");
  }
  let expanded = 0;
  try {
    return unzipSync(bytes, {
      filter(entry) {
        if (unsafeArchivePath(entry.name) || !accept(entry.name)) return false;
        if (entry.originalSize > MAX_OFFICE_XML_BYTES) throw new ConversionFailure("office_xml_too_large");
        expanded += entry.originalSize;
        if (expanded > MAX_EXPANDED_OFFICE_BYTES) throw new ConversionFailure("office_archive_too_large");
        return true;
      },
    });
  } catch (error) {
    if (error instanceof ConversionFailure) throw error;
    throw new ConversionFailure("invalid_office_archive");
  }
}

function requiredXml(entries: Record<string, Uint8Array>, name: string): string {
  const bytes = entries[name];
  if (!bytes) throw new ConversionFailure("invalid_office_archive");
  return decodeOfficeXml(bytes);
}

function decodeOfficeXml(bytes: Uint8Array): string {
  try {
    const xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) throw new ConversionFailure("office_xml_entities_forbidden");
    return xml;
  } catch (error) {
    if (error instanceof ConversionFailure) throw error;
    throw new ConversionFailure("invalid_office_xml");
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

function xmlTagValues(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gu"))]
    .map((match) => decodeXml((match[1] ?? "").replace(/<[^>]+>/gu, "")));
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

function renderPdfPages(pages: string[]): string {
  return pages.map((page, index) => `# Page ${index + 1}\n\n${page.trim()}`).join("\n\n");
}

function assertPageCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new ConversionFailure("invalid_pdf");
  if (value > MAX_PDF_PAGES) throw new ConversionFailure("pdf_page_limit_exceeded");
}

function unsafeArchivePath(name: string): boolean {
  return name.startsWith("/") || name.includes("\\") || name.split("/").includes("..");
}

function numericXmlOrder(value: string): number {
  return Number(/(\d+)\.xml$/u.exec(value)?.[1] ?? Number.MAX_SAFE_INTEGER);
}

function isPlainText(mime: string, fileName: string): boolean {
  return mime.startsWith("text/")
    || ["application/json", "application/xml", "application/yaml", "application/x-yaml", "application/csv"].includes(mime)
    || (genericMime(mime) && /\.(?:txt|md|markdown|csv|tsv|json|jsonl|xml|yaml|yml|html|htm|log|sql|js|jsx|ts|tsx|css|py|rb|go|rs|java|c|cc|cpp|h|hpp)$/iu.test(fileName));
}

function isDocx(mime: string, fileName: string): boolean {
  return mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || (genericMime(mime) && /\.docx$/iu.test(fileName));
}

function isPptx(mime: string, fileName: string): boolean {
  return mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation" || (genericMime(mime) && /\.pptx$/iu.test(fileName));
}

function isXlsx(mime: string, fileName: string): boolean {
  return mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" || (genericMime(mime) && /\.xlsx$/iu.test(fileName));
}

function isPdf(mime: string, fileName: string): boolean {
  return mime === "application/pdf" || (genericMime(mime) && /\.pdf$/iu.test(fileName));
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

function isReadyCurrentVersion(resource: AuthorizedDerivativeResource): boolean {
  return resource.modelContentStatus === "ready"
    && resource.modelContentExtractorVersion === ATTACHMENT_TEXT_EXTRACTOR_VERSION
    && Boolean(resource.modelContentRef)
    && Boolean(resource.modelMimeType)
    && Boolean(resource.modelContentSha256)
    && Number.isSafeInteger(resource.modelContentCharacterCount)
    && (resource.modelContentCharacterCount ?? -1) >= 0;
}

async function updateTerminalState(
  database: D1Database,
  resource: AuthorizedDerivativeResource,
  status: "failed" | "unsupported",
  errorCode: string,
  options: MaterializeAttachmentDerivativeOptions,
  claimId?: string,
): Promise<MaterializedAttachmentDerivative> {
  const boundedCode = /^[a-z0-9_]{1,80}$/u.test(errorCode) ? errorCode : "conversion_failed";
  const at = (options.now ?? (() => new Date()))().toISOString();
  const claimPredicate = claimId
    ? "AND model_content_status = 'processing' AND model_content_claim_id = ?"
    : "AND model_content_status IS NOT 'ready'";
  const statement = database.prepare(
    `UPDATE resources
        SET model_content_status = ?, model_content_extractor_version = ?,
            model_content_error_code = ?, model_content_extracted_at = ?,
            model_content_claimed_at = NULL, model_content_claim_id = NULL, updated_at = ?
      WHERE workspace_id = ? AND id = ? AND content_ref IS ? ${claimPredicate}`,
  );
  await (claimId
    ? statement.bind(status, ATTACHMENT_TEXT_EXTRACTOR_VERSION, boundedCode, at, at, resource.workspaceId, resource.id, resource.contentRef, claimId)
    : statement.bind(status, ATTACHMENT_TEXT_EXTRACTOR_VERSION, boundedCode, at, at, resource.workspaceId, resource.id, resource.contentRef)
  ).run();
  return { status, errorCode: boundedCode };
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", exactArrayBuffer(bytes));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function withTimeout<T>(factory: () => Promise<T>, timeoutMs: number, signal: AbortSignal | undefined): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new ConversionFailure("conversion_timeout")), timeoutMs);
    if (signal) {
      abortListener = () => reject(new ConversionFailure("conversion_aborted"));
      signal.addEventListener("abort", abortListener, { once: true });
    }
  });
  try {
    // Install abort/deadline handling before converter invocation. Provider
    // parsers are asynchronous; local Office work is independently constrained
    // by the small compressed/expanded/XML ceilings above.
    return await Promise.race([Promise.resolve().then(factory), timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
  }
}
