import type { HarnessTool, ModelMessageContentPart } from "@avalon/agent-harness";
import {
  ATTACHMENT_LIST_RESOURCES_DESCRIPTION,
  AttachmentListResourcesArgumentsSchema,
  AttachmentReadResourceArgumentsSchema,
  AttachmentSearchResourceArgumentsSchema,
  AttachmentSummarizeResourceArgumentsSchema,
  AttachmentViewResourceArgumentsSchema,
  WorkstreamListResourcesOutputSchema,
  WorkstreamReadResourceOutputSchema,
  WorkstreamSearchResourceOutputSchema,
  WorkstreamSummarizeResourceOutputSchema,
  WorkstreamViewResourceOutputSchema,
  classifyAttachmentKind,
  type AttachmentKind,
  type ContentMode,
  type WorkstreamWorkflowInput,
} from "@avalon/contracts";
import { z } from "zod";
import type { Env } from "../env";
import { AttachmentCursorError, openAttachmentCursor, sealAttachmentCursor } from "../lib/attachment-cursor";
import {
  materializeAttachmentDerivative,
  type AuthorizedDerivativeResource,
  type DerivativeIndex,
  type MaterializedAttachmentDerivative,
} from "./attachment-derivative-service";
import { loadModelImageForTool, modelImageDataUri } from "./attachment-model-content";
import {
  createAttachmentSummaryRunner,
  type AttachmentSummaryDraft,
  type AttachmentSummaryRunner,
} from "./attachment-summary-service";
import {
  executionPrincipalKey,
  loadVisibleWorkstreamResources,
  type VisibleWorkstreamResourceRow,
} from "./workstream-resource-visibility";

const LIST_CURSOR_PURPOSE = "workstream-list-resources";
const READ_CURSOR_PURPOSE = "workstream-read-resource";
const CURSOR_TTL_MS = 60 * 60_000;
const DEFAULT_LIST_LIMIT = 25;
const DEFAULT_READ_CHARACTERS = 12_000;
const MAXIMUM_READ_CHARACTERS = 24_000;
const DEFAULT_SEARCH_LIMIT = 5;
const DEFAULT_PASSAGE_CHARACTERS = 3_000;
const MAXIMUM_SEARCH_RESULT_CHARACTERS = 20_000;
const DEFAULT_IMAGE_MAX_DIMENSION = 1_536;
const DEFAULT_SUMMARY_CHARACTERS = 12_000;

export interface WorkstreamAttachmentToolOptions {
  summarizeDerivative?: AttachmentSummaryRunner;
}

const ListCursorStateSchema = z.object({
  fingerprint: z.string().min(1).max(100),
  attachmentKind: z.enum(["image", "markdown", "pdf", "document", "spreadsheet", "presentation", "text", "other"]).nullable(),
  limit: z.number().int().min(1).max(50),
  nextIndex: z.number().int().nonnegative(),
  asOf: z.string().datetime({ offset: true }),
}).strict();

const ReadCursorStateSchema = z.object({
  resourceId: z.string().uuid(),
  sha256: z.string().min(1).max(128),
  extractorVersion: z.string().min(1).max(160),
  start: z.number().int().nonnegative(),
  pageSize: z.number().int().min(1).max(MAXIMUM_READ_CHARACTERS),
}).strict();

const DerivativeIndexSchema = z.object({
  offsetUnit: z.literal("utf16"),
  totalCharacters: z.number().int().nonnegative(),
  chunks: z.array(z.object({
    ordinal: z.number().int().nonnegative(),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    sectionLabel: z.string().nullable(),
    terms: z.array(z.string()).max(64),
  }).strict()).max(5_000),
}).strict();

class AttachmentOperationError extends Error {
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "AttachmentOperationError";
  }
}

export function createWorkstreamAttachmentTools(
  env: Env,
  input: WorkstreamWorkflowInput,
  options: WorkstreamAttachmentToolOptions = {},
): HarnessTool[] {
  const summarizeDerivative = options.summarizeDerivative ?? createAttachmentSummaryRunner(env);
  return [
    {
      definition: {
        name: "list_resources",
        description: ATTACHMENT_LIST_RESOURCES_DESCRIPTION,
        capability: "workstream.resources.list",
        mode: "read",
        idempotency: "safe",
        inputSchema: z.toJSONSchema(AttachmentListResourcesArgumentsSchema) as Record<string, unknown>,
      },
      execute: async (raw) => {
        const args = AttachmentListResourcesArgumentsSchema.parse(raw);
        const visible = await loadVisibleWorkstreamResources(env.DB, {
          workspaceId: input.workspaceId,
          workstreamId: input.workstreamId,
          principal: input.executionPrincipal,
        });
        let attachmentKind: AttachmentKind | null;
        let limit: number;
        let start: number;
        let asOf: string;
        if ("cursor" in args) {
          const state = await openCursorState(env, input, args.cursor, LIST_CURSOR_PURPOSE, ListCursorStateSchema);
          if (state.fingerprint !== visible.fingerprint) {
            throw attachmentError("invalid_cursor", "The resource inventory changed; restart the list from its first page");
          }
          attachmentKind = state.attachmentKind;
          limit = state.limit;
          start = state.nextIndex;
          asOf = state.asOf;
        } else {
          attachmentKind = args.attachmentKind ?? null;
          limit = args.limit ?? DEFAULT_LIST_LIMIT;
          start = 0;
          asOf = new Date().toISOString();
        }
        const matching = visible.rows.filter((row) => !attachmentKind || rowKind(row) === attachmentKind);
        const page = matching.slice(start, start + limit);
        const nextIndex = start + page.length;
        const nextCursor = nextIndex < matching.length
          ? await sealCursorState(env, input, LIST_CURSOR_PURPOSE, {
              fingerprint: visible.fingerprint, attachmentKind, limit, nextIndex, asOf,
            })
          : null;
        const output = WorkstreamListResourcesOutputSchema.parse({
          workstreamId: input.workstreamId,
          asOf,
          totalVisibleResources: visible.rows.length,
          totalMatchingResources: matching.length,
          filters: { attachmentKind },
          items: page.map(resourceListItem),
          nextCursor,
        });
        return { output, summary: `Listed ${page.length} of ${matching.length} matching work-stream resources` };
      },
    },
    {
      definition: {
        name: "read_resource",
        description: [
          "Read one bounded page from a visible text, Markdown, PDF, document, spreadsheet, or presentation derivative.",
          "Start with resourceId and optional startCharacter. Continue with a returned cursor by itself.",
          "Use charactersBefore and charactersAfter to tell whether the page covers the whole resource.",
        ].join(" "),
        capability: "workstream.resources.read",
        mode: "read",
        idempotency: "safe",
        inputSchema: z.toJSONSchema(AttachmentReadResourceArgumentsSchema) as Record<string, unknown>,
      },
      execute: async (raw, context) => {
        const args = AttachmentReadResourceArgumentsSchema.parse(raw);
        let resourceId: string;
        let start: number;
        let pageSize = DEFAULT_READ_CHARACTERS;
        let cursorVersion: { sha256: string; extractorVersion: string } | null = null;
        if ("cursor" in args) {
          const state = await openCursorState(env, input, args.cursor, READ_CURSOR_PURPOSE, ReadCursorStateSchema);
          resourceId = state.resourceId;
          start = state.start;
          pageSize = state.pageSize;
          cursorVersion = { sha256: state.sha256, extractorVersion: state.extractorVersion };
        } else {
          resourceId = args.resourceId;
          start = args.startCharacter ?? 0;
        }
        const row = await requireVisibleResource(env, input, resourceId);
        assertReadableKind(row, "workstream_read_resource");
        const ready = await ensureReadyTextDerivative(env, row, context.signal);
        if (cursorVersion && (cursorVersion.sha256 !== ready.sha256 || cursorVersion.extractorVersion !== ready.extractorVersion)) {
          throw attachmentError("resource_version_changed", "The resource changed; restart the read from its resource ID");
        }
        const object = await env.PAYLOADS.get(ready.contentRef);
        if (!object) throw attachmentError("resource_conversion_failed", "The selected derivative is unavailable");
        const text = await object.text();
        if (text.length !== ready.totalCharacters) {
          throw attachmentError("resource_version_changed", "The selected derivative length no longer matches its version");
        }
        if (start > text.length) throw attachmentError("invalid_cursor", "The requested character position is outside this resource");
        const end = Math.min(text.length, start + pageSize);
        const version = { sha256: ready.sha256, extractorVersion: ready.extractorVersion };
        const previousStart = Math.max(0, start - pageSize);
        const previousCursor = start > 0
          ? await sealReadCursor(env, input, resourceId, version, previousStart, pageSize)
          : null;
        const nextCursor = end < text.length
          ? await sealReadCursor(env, input, resourceId, version, end, pageSize)
          : null;
        const output = WorkstreamReadResourceOutputSchema.parse({
          resourceId,
          title: row.title,
          sourceMimeType: row.mime_type,
          modelMimeType: ready.modelMimeType,
          version,
          range: { start, end },
          totalCharacters: text.length,
          charactersBefore: start,
          charactersReturned: end - start,
          charactersAfter: text.length - end,
          text: text.slice(start, end),
          previousCursor,
          nextCursor,
        });
        return { output, summary: `Read ${end - start} characters from ${row.title}` };
      },
    },
    {
      definition: {
        name: "search_resource",
        description: "Search one visible text, Markdown, PDF, document, spreadsheet, or presentation derivative. Results are bounded passages from this resource only; use each readCursor to inspect its surrounding text.",
        capability: "workstream.resources.search",
        mode: "read",
        idempotency: "safe",
        inputSchema: z.toJSONSchema(AttachmentSearchResourceArgumentsSchema) as Record<string, unknown>,
      },
      execute: async (raw, context) => {
        const args = AttachmentSearchResourceArgumentsSchema.parse(raw);
        const row = await requireVisibleResource(env, input, args.resourceId);
        assertReadableKind(row, "workstream_search_resource");
        const ready = await ensureReadyTextDerivative(env, row, context.signal);
        const [contentObject, indexObject] = await Promise.all([
          env.PAYLOADS.get(ready.contentRef),
          env.PAYLOADS.get(ready.indexRef),
        ]);
        if (!contentObject || !indexObject) throw attachmentError("resource_conversion_failed", "The selected derivative or index is unavailable");
        const [text, indexText] = await Promise.all([contentObject.text(), indexObject.text()]);
        let indexValue: unknown;
        try {
          indexValue = JSON.parse(indexText);
        } catch {
          throw attachmentError("resource_conversion_failed", "The selected derivative index is invalid");
        }
        const parsedIndex = DerivativeIndexSchema.safeParse(indexValue);
        if (!parsedIndex.success) {
          throw attachmentError("resource_conversion_failed", "The selected derivative index is invalid");
        }
        const index = parsedIndex.data as DerivativeIndex;
        if (index.totalCharacters !== text.length || index.totalCharacters !== ready.totalCharacters) {
          throw attachmentError("resource_version_changed", "The selected derivative and index no longer match");
        }
        const queryTerms = normalizedTerms(args.query);
        const ranked = index.chunks.map((chunk) => ({
          chunk,
          score: queryTerms.reduce((score, term) => score + chunk.terms.filter((candidate) => candidate.includes(term)).length, 0),
        })).filter((candidate) => candidate.score > 0)
          .sort((left, right) => right.score - left.score || left.chunk.start - right.chunk.start);
        const limit = args.limit ?? DEFAULT_SEARCH_LIMIT;
        const maxPassageCharacters = args.maxPassageCharacters ?? DEFAULT_PASSAGE_CHARACTERS;
        const selected = ranked.slice(0, limit);
        let returnedCharacters = 0;
        const passages = [];
        const version = { sha256: ready.sha256, extractorVersion: ready.extractorVersion };
        for (const candidate of selected) {
          const remaining = MAXIMUM_SEARCH_RESULT_CHARACTERS - returnedCharacters;
          if (remaining <= 0) break;
          const passageLength = Math.min(maxPassageCharacters, remaining);
          const range = passageRange(text, candidate.chunk.start, candidate.chunk.end, passageLength, args.query);
          const passageText = text.slice(range.start, range.end);
          passages.push({
            rank: passages.length + 1,
            sectionLabel: candidate.chunk.sectionLabel,
            range,
            text: passageText,
            readCursor: await sealReadCursor(env, input, row.id, version, range.start, DEFAULT_READ_CHARACTERS),
          });
          returnedCharacters += passageText.length;
        }
        const output = WorkstreamSearchResourceOutputSchema.parse({
          resourceId: row.id,
          title: row.title,
          sourceMimeType: row.mime_type,
          modelMimeType: ready.modelMimeType,
          version,
          query: args.query,
          totalMatches: ranked.length,
          returnedMatches: passages.length,
          passages,
          truncated: ranked.length > passages.length,
        });
        return { output, summary: `Found ${ranked.length} matching passages in ${row.title}` };
      },
    },
    {
      definition: {
        name: "view_resource",
        description: "View one through eight visible image resources. The JSON result identifies ordered visual parts; readable text, Markdown, PDFs, documents, spreadsheets, and presentations self-heal with an exact workstream_read_resource suggestion.",
        capability: "workstream.resources.view",
        mode: "read",
        idempotency: "safe",
        inputSchema: z.toJSONSchema(AttachmentViewResourceArgumentsSchema) as Record<string, unknown>,
      },
      execute: async (raw) => {
        const args = AttachmentViewResourceArgumentsSchema.parse(raw);
        const visible = await loadVisibleWorkstreamResources(env.DB, {
          workspaceId: input.workspaceId,
          workstreamId: input.workstreamId,
          principal: input.executionPrincipal,
        });
        const maxDimension = args.maxDimension ?? DEFAULT_IMAGE_MAX_DIMENSION;
        const contentParts: ModelMessageContentPart[] = [];
        const items = [];
        for (const resourceId of args.resourceIds) {
          const row = visible.rows.find((candidate) => candidate.id === resourceId);
          if (!row) {
            items.push(skippedViewItem(resourceId, "Unavailable", null, "resource_not_found", "The resource was not found"));
            continue;
          }
          const kind = rowKind(row);
          if (kind !== "image") {
            if (contentMode(row, kind) === "unsupported") {
              items.push(skippedViewItem(row.id, row.title, row.mime_type, "resource_format_unsupported", "This resource format is unsupported"));
              continue;
            }
            const suggestedCall = readSuggestion(row.id);
            items.push(skippedViewItem(
              row.id,
              row.title,
              row.mime_type,
              "resource_tool_mismatch",
              `workstream_view_resource cannot handle ${row.mime_type ?? kind} resources; call workstream_read_resource with the supplied arguments instead.`,
              suggestedCall,
            ));
            continue;
          }
          try {
            const image = await loadModelImageForTool(env.PAYLOADS, {
              id: row.id,
              fileName: row.title,
              mimeType: row.mime_type ?? "image/*",
              contentRef: row.content_ref,
              modelContentRef: row.model_content_ref,
              modelMimeType: row.model_mime_type,
              modelContentSha256: row.model_content_sha256,
              modelMetadataJson: row.model_metadata_json,
            }, { database: env.DB, images: env.IMAGES, maxDimension });
            if (!image) {
              items.push(skippedViewItem(row.id, row.title, row.mime_type, "resource_conversion_failed", "The image could not be safely converted"));
              continue;
            }
            const visualPartIndex = contentParts.length;
            contentParts.push({
              type: "image_url",
              image_url: { url: modelImageDataUri(image.bytes, image.mimeType), detail: "auto" },
            });
            items.push({
              resourceId: row.id,
              title: row.title,
              sourceMimeType: row.mime_type,
              modelMimeType: image.mimeType,
              version: { sha256: image.sha256, extractorVersion: image.extractorVersion },
              sourceBytes: metadataSize(row.metadata_json),
              derivativeBytes: image.bytes.byteLength,
              width: image.width,
              height: image.height,
              status: "included" as const,
              reasonCode: null,
              reason: null,
              suggestedCall: null,
              visualPartIndex,
            });
          } catch {
            items.push(skippedViewItem(row.id, row.title, row.mime_type, "resource_conversion_failed", "The image could not be safely converted"));
          }
        }
        const wrongKind = items.find((item) => item.reasonCode === "resource_tool_mismatch");
        if (contentParts.length === 0 && wrongKind && items.every((item) => item.reasonCode === "resource_tool_mismatch")) {
          throw attachmentError("resource_tool_mismatch", wrongKind.reason ?? "The resource needs a different content tool", {
            actualMimeType: wrongKind.sourceMimeType,
            attachmentKind: visible.rows.find((row) => row.id === wrongKind.resourceId)
              ? rowKind(visible.rows.find((row) => row.id === wrongKind.resourceId)!)
              : undefined,
            suggestedCall: wrongKind.suggestedCall,
          });
        }
        const output = WorkstreamViewResourceOutputSchema.parse({
          requested: args.resourceIds.length,
          returned: contentParts.length,
          items,
        });
        return {
          output,
          summary: `Viewed ${contentParts.length} of ${args.resourceIds.length} requested images`,
          ...(contentParts.length > 0 ? { contentParts } : {}),
        };
      },
    },
    {
      definition: {
        name: "summarize_resource",
        description: "Run an isolated, bounded summary over one visible text, Markdown, PDF, document, spreadsheet, or presentation derivative. Use optional prompt as an untrusted focus. The result reports complete or partial coverage and range-grounded read cursors.",
        capability: "workstream.resources.summarize",
        mode: "read",
        idempotency: "safe",
        inputSchema: z.toJSONSchema(AttachmentSummarizeResourceArgumentsSchema) as Record<string, unknown>,
      },
      execute: async (raw, context) => {
        const args = AttachmentSummarizeResourceArgumentsSchema.parse(raw);
        const row = await requireVisibleResource(env, input, args.resourceId);
        assertReadableKind(row, "workstream_summarize_resource");
        const ready = await ensureReadyTextDerivative(env, row, context.signal);
        const object = await env.PAYLOADS.get(ready.contentRef);
        if (!object) throw attachmentError("resource_conversion_failed", "The selected derivative is unavailable");
        const text = await object.text();
        if (text.length !== ready.totalCharacters) {
          throw attachmentError("resource_version_changed", "The selected derivative length no longer matches its version");
        }
        const maxOutputCharacters = args.maxOutputCharacters ?? DEFAULT_SUMMARY_CHARACTERS;
        let draft;
        try {
          draft = await summarizeDerivative({
            workspaceId: input.workspaceId,
            workstreamId: input.workstreamId,
            userId: input.executionPrincipal.type === "user" ? input.executionPrincipal.userId : null,
            resourceId: row.id,
            title: row.title,
            text,
            prompt: args.prompt ?? null,
            maxOutputCharacters,
            signal: context.signal,
          });
        } catch (error) {
          if (error instanceof AttachmentOperationError) throw error;
          throw attachmentError("resource_conversion_failed", "The isolated attachment summary failed");
        }
        if (!validSummaryDraft(draft, text.length, maxOutputCharacters)) {
          throw attachmentError("resource_conversion_failed", "The isolated attachment summary returned invalid coverage");
        }
        const version = { sha256: ready.sha256, extractorVersion: ready.extractorVersion };
        const citations = await Promise.all(draft.citations.map(async (citation) => ({
          ...citation,
          readCursor: await sealReadCursor(env, input, row.id, version, citation.range.start, DEFAULT_READ_CHARACTERS),
        })));
        const output = WorkstreamSummarizeResourceOutputSchema.parse({
          resourceId: row.id,
          title: row.title,
          sourceMimeType: row.mime_type,
          modelMimeType: ready.modelMimeType,
          version,
          prompt: args.prompt ?? null,
          outline: draft.outline,
          summary: draft.summary,
          citations,
          coverage: {
            ...draft.coverage,
            totalCharacters: text.length,
          },
        });
        return { output, summary: `Summarized ${draft.coverage.consideredCharacters} characters from ${row.title}` };
      },
    },
  ];
}

/** Recreate only ephemeral visual parts from a JSON-only completed receipt. */
export async function rehydrateWorkstreamViewReceipt(
  env: Env,
  input: WorkstreamWorkflowInput,
  rawInput: unknown,
  rawOutput: unknown,
): Promise<ModelMessageContentPart[]> {
  const parsedInput = AttachmentViewResourceArgumentsSchema.safeParse(rawInput);
  const parsedOutput = WorkstreamViewResourceOutputSchema.safeParse(rawOutput);
  if (!parsedInput.success || !parsedOutput.success || parsedOutput.data.returned === 0) return [];
  const visible = await loadVisibleWorkstreamResources(env.DB, {
    workspaceId: input.workspaceId,
    workstreamId: input.workstreamId,
    principal: input.executionPrincipal,
  });
  const included = parsedOutput.data.items
    .filter((item) => item.status === "included")
    .sort((left, right) => (left.visualPartIndex ?? 0) - (right.visualPartIndex ?? 0));
  const parts: ModelMessageContentPart[] = [];
  for (const item of included) {
    const row = visible.rows.find((candidate) => candidate.id === item.resourceId);
    if (!row || rowKind(row) !== "image" || !item.version) return [];
    const image = await loadModelImageForTool(env.PAYLOADS, {
      id: row.id,
      fileName: row.title,
      mimeType: row.mime_type ?? "image/*",
      contentRef: row.content_ref,
      modelContentRef: row.model_content_ref,
      modelMimeType: row.model_mime_type,
      modelContentSha256: row.model_content_sha256,
      modelMetadataJson: row.model_metadata_json,
    }, {
      database: env.DB,
      images: env.IMAGES,
      maxDimension: parsedInput.data.maxDimension ?? DEFAULT_IMAGE_MAX_DIMENSION,
    });
    if (!image || image.sha256 !== item.version.sha256 || image.extractorVersion !== item.version.extractorVersion) return [];
    parts.push({ type: "image_url", image_url: { url: modelImageDataUri(image.bytes, image.mimeType), detail: "auto" } });
  }
  return parts.length === parsedOutput.data.returned ? parts : [];
}

function readSuggestion(resourceId: string) {
  return { tool: "workstream_read_resource" as const, arguments: { resourceId } };
}

function skippedViewItem(
  resourceId: string,
  title: string,
  sourceMimeType: string | null,
  reasonCode: "resource_not_found" | "resource_processing" | "resource_conversion_failed" | "resource_format_unsupported" | "resource_tool_mismatch",
  reason: string,
  suggestedCall: ReturnType<typeof readSuggestion> | null = null,
) {
  return {
    resourceId,
    title,
    sourceMimeType,
    modelMimeType: null,
    version: null,
    sourceBytes: 0,
    derivativeBytes: null,
    width: null,
    height: null,
    status: "skipped" as const,
    reasonCode,
    reason,
    suggestedCall,
    visualPartIndex: null,
  };
}

function validSummaryDraft(
  draft: AttachmentSummaryDraft,
  totalCharacters: number,
  maxOutputCharacters: number,
): boolean {
  const ranges = [
    ...draft.outline.map((item) => item.range),
    ...draft.citations.map((item) => item.range),
  ];
  const authoredCharacters = draft.summary.length
    + draft.outline.reduce((total, item) => total + item.heading.length, 0)
    + draft.citations.reduce((total, item) => total + item.label.length, 0)
    + draft.coverage.limitations.reduce((total, item) => total + item.length, 0);
  return draft.outline.length <= 50
    && draft.citations.length <= 50
    && draft.coverage.limitations.length <= 20
    && draft.coverage.consideredCharacters <= totalCharacters
    && (draft.coverage.status === "complete") === (draft.coverage.consideredCharacters === totalCharacters)
    && ranges.every((range) => range.start >= 0 && range.end >= range.start && range.end <= totalCharacters)
    && authoredCharacters <= maxOutputCharacters;
}

async function requireVisibleResource(
  env: Env,
  input: WorkstreamWorkflowInput,
  resourceId: string,
): Promise<VisibleWorkstreamResourceRow> {
  const visible = await loadVisibleWorkstreamResources(env.DB, {
    workspaceId: input.workspaceId,
    workstreamId: input.workstreamId,
    principal: input.executionPrincipal,
  });
  const row = visible.rows.find((candidate) => candidate.id === resourceId);
  if (!row) throw attachmentError("resource_not_found", "The resource was not found");
  return row;
}

function assertReadableKind(row: VisibleWorkstreamResourceRow, calledTool: string): void {
  const kind = rowKind(row);
  if (kind !== "image") return;
  throw attachmentError(
    "resource_tool_mismatch",
    `${calledTool} cannot handle ${row.mime_type ?? "image"} resources; call workstream_view_resource with the supplied arguments instead.`,
    {
      actualMimeType: row.mime_type,
      attachmentKind: kind,
      suggestedCall: { tool: "workstream_view_resource", arguments: { resourceIds: [row.id] } },
    },
  );
}

async function ensureReadyTextDerivative(
  env: Env,
  row: VisibleWorkstreamResourceRow,
  signal: AbortSignal,
): Promise<Extract<MaterializedAttachmentDerivative, { status: "ready" }>> {
  const result = await materializeAttachmentDerivative(env.DB, env.PAYLOADS, authorizedDerivativeResource(row), { signal });
  if (result.status === "ready") return result;
  if (result.status === "processing") {
    throw attachmentError("resource_processing", "The resource is still being converted", { retryAfterMs: result.retryAfterMs });
  }
  throw attachmentError(
    result.status === "unsupported" ? "resource_format_unsupported" : "resource_conversion_failed",
    result.status === "unsupported" ? "This resource format is unsupported" : "The resource could not be converted",
    { reason: result.errorCode },
  );
}

function authorizedDerivativeResource(row: VisibleWorkstreamResourceRow): AuthorizedDerivativeResource {
  return {
    id: row.id,
    fileName: row.title,
    mimeType: row.mime_type,
    contentRef: row.content_ref,
    contentSha256: row.content_sha256,
    modelContentRef: row.model_content_ref,
    modelMimeType: row.model_mime_type,
    modelContentSha256: row.model_content_sha256,
    modelIndexRef: row.model_index_ref,
    modelContentStatus: row.model_content_status,
    modelContentExtractorVersion: row.model_content_extractor_version,
    modelContentCharacterCount: row.model_content_character_count,
  };
}

function resourceListItem(row: VisibleWorkstreamResourceRow) {
  const attachmentKind = rowKind(row);
  return {
    resourceId: row.id,
    title: row.title,
    fileName: row.title,
    resourceType: row.resource_type,
    provider: row.provider,
    mimeType: row.mime_type,
    sizeBytes: metadataSize(row.metadata_json),
    relationshipType: row.relationship_type,
    attachedAt: row.attached_at,
    messageAttachment: row.message_attachment === 1,
    attachmentKind,
    contentMode: contentMode(row, attachmentKind),
    derivativeStatus: row.model_content_status,
  };
}

function rowKind(row: VisibleWorkstreamResourceRow): AttachmentKind {
  return classifyAttachmentKind({ mimeType: row.mime_type, fileName: row.title });
}

function contentMode(row: VisibleWorkstreamResourceRow, kind: AttachmentKind): ContentMode {
  if (kind === "image") return "view";
  if (kind !== "other" || (row.model_content_status === "ready" && row.model_mime_type?.startsWith("text/"))) return "read";
  return "unsupported";
}

function metadataSize(value: string): number {
  try {
    const parsed = JSON.parse(value) as { size?: unknown };
    const size = Number(parsed.size ?? 0);
    return Number.isSafeInteger(size) && size >= 0 ? size : 0;
  } catch {
    return 0;
  }
}

async function sealCursorState(
  env: Env,
  input: WorkstreamWorkflowInput,
  purpose: string,
  state: Record<string, unknown>,
): Promise<string> {
  return sealAttachmentCursor(env.SESSION_SIGNING_KEY, {
    purpose,
    principal: executionPrincipalKey(input.executionPrincipal),
    scopeId: input.workstreamId,
    expiresAt: Date.now() + CURSOR_TTL_MS,
    state,
  });
}

async function openCursorState<T>(
  env: Env,
  input: WorkstreamWorkflowInput,
  cursor: string,
  purpose: string,
  schema: z.ZodType<T>,
): Promise<T> {
  try {
    const payload = await openAttachmentCursor(env.SESSION_SIGNING_KEY, cursor, {
      purpose,
      principal: executionPrincipalKey(input.executionPrincipal),
      scopeId: input.workstreamId,
    });
    return schema.parse(payload.state);
  } catch (error) {
    if (error instanceof AttachmentCursorError) throw attachmentError(error.code, error.message);
    throw attachmentError("invalid_cursor", "Attachment cursor is invalid");
  }
}

async function sealReadCursor(
  env: Env,
  input: WorkstreamWorkflowInput,
  resourceId: string,
  version: { sha256: string; extractorVersion: string },
  start: number,
  pageSize: number,
): Promise<string> {
  return sealCursorState(env, input, READ_CURSOR_PURPOSE, { resourceId, ...version, start, pageSize });
}

function normalizedTerms(value: string): string[] {
  return [...new Set(value.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])];
}

function passageRange(
  text: string,
  chunkStart: number,
  chunkEnd: number,
  maximumLength: number,
  query: string,
): { start: number; end: number } {
  const chunkText = text.slice(chunkStart, chunkEnd);
  const match = chunkText.toLocaleLowerCase("en-US").indexOf(query.toLocaleLowerCase("en-US"));
  const center = match >= 0 ? chunkStart + match : chunkStart;
  let start = Math.max(chunkStart, center - Math.floor(maximumLength / 3));
  let end = Math.min(text.length, Math.max(chunkEnd, start + maximumLength));
  if (end - start > maximumLength) end = start + maximumLength;
  if (end - start < maximumLength) start = Math.max(0, end - maximumLength);
  return { start, end };
}

function attachmentError(code: string, message: string, details?: Record<string, unknown>): AttachmentOperationError {
  return new AttachmentOperationError(code, message, details);
}
