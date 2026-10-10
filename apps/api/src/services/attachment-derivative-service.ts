import { ATTACHMENT_CONVERTER_TIMEOUT_MS, ATTACHMENT_PROCESSING_LEASE_MS, classifyAttachmentKind } from "@rally/contracts";
import {
  convertOfficeDocument,
  officeDocumentFormat,
  OfficeDocumentConversionError as ConversionFailure,
} from "../lib/office-document-text";
import { putStagedResourceObject, releaseStagedResourceObject } from "./resource-object-cleanup";
import { runtimeDeferral } from "../lib/defer";
import { emitInferenceUsage } from "./usage-metering";

export const ATTACHMENT_TEXT_EXTRACTOR_VERSION = "attachment-text-v3";

// Local conversion is an isolate-safe fast path. Provider-backed PDF OCR and
// the document summarizer remain separate calls; no single conversion is
// allowed to materialize the former 50 MiB/20M-character envelope in memory.
const MAX_SOURCE_BYTES = 8 * 1_024 * 1_024;
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
  await putStagedResourceObject({
    database,
    payloads,
    objectRef: contentRef,
    workspaceId: resource.workspaceId,
    resourceId: resource.id,
    objectKind: "derivative",
    value: exactArrayBuffer(contentBytes),
    options: {
      httpMetadata: { contentType: `${converted.modelMimeType}; charset=utf-8` },
      customMetadata: { originalResourceId: resource.id, sourceSha256, extractorVersion: converted.extractorVersion, sha256: derivativeSha256 },
    },
    at,
  });
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
      await releaseStagedResourceObject(database, resource.workspaceId, contentRef)
        .catch(() => undefined);
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
  metering: { env: Parameters<typeof emitInferenceUsage>[0]; workspaceId: string; resourceId: string },
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
  // Metered once the provider has answered, since that is the call that cost
  // something; a call that threw or was never made is not. Workers AI returns
  // no price for a conversion, so it is metered as unpriced until a rate card
  // exists (docs/usage-metering.md). Each conversion is a separate call, so
  // each gets its own event ID.
  emitInferenceUsage(metering.env, runtimeDeferral, {
    eventId: `ocr:${metering.resourceId}:${crypto.randomUUID()}`,
    workspaceId: metering.workspaceId,
    activity: "document_ocr",
    costCents: undefined,
    model: null,
    refs: {},
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

const OFFICE_ATTACHMENT_KIND = {
  docx: "document",
  pptx: "presentation",
  xlsx: "spreadsheet",
} as const;

async function convertAttachment(input: BuildAttachmentDerivativeInput): Promise<ConvertedText | null> {
  const mime = input.mimeType?.trim().toLowerCase() ?? "";
  const kind = classifyAttachmentKind({ mimeType: mime, fileName: input.fileName });
  if (kind === "pdf" && isPdf(mime, input.fileName)) return convertPdf(input);
  const office = officeDocumentFormat(mime, input.fileName);
  if (office && kind === OFFICE_ATTACHMENT_KIND[office]) return convertOfficeDocument(input.bytes, office);
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

async function convertPdf(input: BuildAttachmentDerivativeInput): Promise<ConvertedText> {
  // PDF.js may transfer and detach the supplied ArrayBuffer. OCR needs the
  // original bytes after text-layer detection, so extraction receives its own
  // bounded copy rather than consuming the only source buffer.
  if (!input.pdfExtractor) throw new ConversionFailure("pdf_processor_unavailable");
  let extracted: AttachmentPdfText;
  try {
    extracted = await input.pdfExtractor(input.bytes.slice());
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    throw new ConversionFailure(message === "pdf_encrypted" ? "pdf_encrypted" : "invalid_pdf");
  }
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

function renderPdfPages(pages: string[]): string {
  return pages.map((page, index) => `# Page ${index + 1}\n\n${page.trim()}`).join("\n\n");
}

function assertPageCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new ConversionFailure("invalid_pdf");
  if (value > MAX_PDF_PAGES) throw new ConversionFailure("pdf_page_limit_exceeded");
}

function isPlainText(mime: string, fileName: string): boolean {
  return mime.startsWith("text/")
    || ["application/json", "application/xml", "application/yaml", "application/x-yaml", "application/csv"].includes(mime)
    || (genericMime(mime) && /\.(?:txt|md|markdown|csv|tsv|json|jsonl|xml|yaml|yml|html|htm|log|sql|js|jsx|ts|tsx|css|py|rb|go|rs|java|c|cc|cpp|h|hpp)$/iu.test(fileName));
}

function isPdf(mime: string, fileName: string): boolean {
  return mime === "application/pdf" || (genericMime(mime) && /\.pdf$/iu.test(fileName));
}

function genericMime(mime: string): boolean {
  return mime === "" || mime === "application/octet-stream" || mime === "binary/octet-stream";
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
