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
  type SuggestedAttachmentToolCall,
  type WorkstreamWorkflowInput,
} from "@avalon/contracts";
import { z } from "zod";
import { extractText, getDocumentProxy } from "unpdf";
import type { Env } from "../env";
import { AttachmentCursorError, openAttachmentCursor, sealAttachmentCursor } from "../lib/attachment-cursor";
import {
  materializeAttachmentDerivative,
  type AuthorizedDerivativeResource,
  type DerivativeIndex,
  type MaterializedAttachmentDerivative,
} from "./attachment-derivative-service";
import {
  loadModelImageForTool,
  MAX_TOTAL_MODEL_IMAGE_BYTES,
  modelImageDataUri,
} from "./attachment-model-content";
import {
  createAttachmentSummaryRunner,
  type AttachmentSummaryDraft,
  type AttachmentSummaryRunner,
} from "./attachment-summary-service";
import {
  executionPrincipalKey,
  loadVisibleWorkstreamResourcePage,
  loadVisibleWorkstreamResourcesByIds,
  WorkstreamResourceInventoryChangedError,
  type VisibleWorkstreamResourceSet,
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
const MAX_DERIVATIVE_OBJECT_BYTES = 8 * 1024 * 1024;
const MAX_INDEX_OBJECT_BYTES = 2 * 1024 * 1024;

export interface WorkstreamAttachmentToolOptions {
  summarizeDerivative?: AttachmentSummaryRunner;
  /** Reuse the derivative/tool implementation behind a separately authorized scope. */
  loadVisibleResources?: () => Promise<VisibleWorkstreamResourceSet>;
  cursorNamespace?: "workstream" | "automation-draft";
  modelToolPrefix?: "workstream" | "automation";
  capabilityPrefix?: string;
}

const ListCursorStateSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("database"),
    fingerprint: z.string().min(1).max(100),
    attachmentKind: z.enum(["image", "markdown", "pdf", "document", "spreadsheet", "presentation", "text", "other"]).nullable(),
    limit: z.number().int().min(1).max(50),
    afterAttachedAt: z.string().datetime({ offset: true }),
    afterResourceId: z.string().uuid(),
    asOf: z.string().datetime({ offset: true }),
  }).strict(),
  z.object({
    mode: z.literal("in_memory"),
    fingerprint: z.string().min(1).max(100),
    attachmentKind: z.enum(["image", "markdown", "pdf", "document", "spreadsheet", "presentation", "text", "other"]).nullable(),
    limit: z.number().int().min(1).max(50),
    nextIndex: z.number().int().nonnegative(),
    asOf: z.string().datetime({ offset: true }),
  }).strict(),
]);

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
  }).strict()).max(500),
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
  const modelToolPrefix = options.modelToolPrefix ?? "workstream";
  const capabilityPrefix = options.capabilityPrefix ?? "workstream.resources";
  const modelToolName = (name: string) => `${modelToolPrefix}_${name}`;
  return [
    {
      definition: {
        name: "list_resources",
        description: options.modelToolPrefix === "automation"
          ? ATTACHMENT_LIST_RESOURCES_DESCRIPTION.replace("this work stream", "this automation draft's frozen attachment set")
          : ATTACHMENT_LIST_RESOURCES_DESCRIPTION,
        capability: `${capabilityPrefix}.list`,
        mode: "read",
        idempotency: "safe",
        inputSchema: z.toJSONSchema(AttachmentListResourcesArgumentsSchema) as Record<string, unknown>,
      },
      execute: async (raw) => {
        const args = AttachmentListResourcesArgumentsSchema.parse(raw);
        const state = "cursor" in args
          ? await openCursorState(env, input, options, args.cursor, LIST_CURSOR_PURPOSE, ListCursorStateSchema)
          : null;
        const attachmentKind = state?.attachmentKind ?? ("attachmentKind" in args ? args.attachmentKind ?? null : null);
        const limit = state?.limit ?? ("limit" in args ? args.limit ?? DEFAULT_LIST_LIMIT : DEFAULT_LIST_LIMIT);
        const asOf = state?.asOf ?? new Date().toISOString();
        if (options.loadVisibleResources) {
          if (state && state.mode !== "in_memory") {
            throw attachmentError("invalid_cursor", "This resource cursor belongs to another resource scope");
          }
          const visible = await options.loadVisibleResources();
          if (state && state.fingerprint !== visible.fingerprint) {
            throw attachmentError("invalid_cursor", "The resource inventory changed; restart the list from its first page");
          }
          const matching = visible.rows.filter((row) => !attachmentKind || rowKind(row) === attachmentKind);
          const start = state?.nextIndex ?? 0;
          const page = matching.slice(start, start + limit);
          const nextIndex = start + page.length;
          const nextCursor = nextIndex < matching.length
            ? await sealCursorState(env, input, options, LIST_CURSOR_PURPOSE, {
                mode: "in_memory", fingerprint: visible.fingerprint, attachmentKind, limit, nextIndex, asOf,
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
        }
        if (state && state.mode !== "database") {
          throw attachmentError("invalid_cursor", "This resource cursor belongs to another resource scope");
        }
        let result;
        try {
          result = await loadVisibleWorkstreamResourcePage(env.DB, {
            workspaceId: input.workspaceId,
            workstreamId: input.workstreamId,
            principal: input.executionPrincipal,
            attachmentKind,
            limit,
            ...(state ? { expectedFingerprint: state.fingerprint } : {}),
            after: state ? { attachedAt: state.afterAttachedAt, resourceId: state.afterResourceId } : null,
          });
        } catch (error) {
          if (error instanceof WorkstreamResourceInventoryChangedError) {
            throw attachmentError("invalid_cursor", "The resource inventory changed; restart the list from its first page");
          }
          throw error;
        }
        const last = result.rows.at(-1);
        const nextCursor = result.hasMore && last
          ? await sealCursorState(env, input, options, LIST_CURSOR_PURPOSE, {
              mode: "database",
              fingerprint: result.fingerprint,
              attachmentKind,
              limit,
              afterAttachedAt: last.attached_at,
              afterResourceId: last.id,
              asOf,
            })
          : null;
        const output = WorkstreamListResourcesOutputSchema.parse({
          workstreamId: input.workstreamId,
          asOf,
          totalVisibleResources: result.totalVisibleResources,
          totalMatchingResources: result.totalMatchingResources,
          filters: { attachmentKind },
          items: result.rows.map(resourceListItem),
          nextCursor,
        });
        return {
          output,
          summary: `Listed ${result.rows.length} of ${result.totalMatchingResources} matching work-stream resources`,
        };
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
        capability: `${capabilityPrefix}.read`,
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
          const state = await openCursorState(env, input, options, args.cursor, READ_CURSOR_PURPOSE, ReadCursorStateSchema);
          resourceId = state.resourceId;
          start = state.start;
          pageSize = state.pageSize;
          cursorVersion = { sha256: state.sha256, extractorVersion: state.extractorVersion };
        } else {
          resourceId = args.resourceId;
          start = args.startCharacter ?? 0;
        }
        const row = await requireVisibleResource(env, input, options, resourceId);
        assertReadableKind(row, modelToolName("read_resource"), modelToolPrefix);
        const ready = await ensureReadyTextDerivative(env, row, context.signal);
        if (cursorVersion && (cursorVersion.sha256 !== ready.sha256 || cursorVersion.extractorVersion !== ready.extractorVersion)) {
          throw attachmentError("resource_version_changed", "The resource changed; restart the read from its resource ID");
        }
        const object = await env.PAYLOADS.get(ready.contentRef);
        if (!object) throw attachmentError("resource_conversion_failed", "The selected derivative is unavailable");
        if (object.size > MAX_DERIVATIVE_OBJECT_BYTES) {
          throw attachmentError("resource_conversion_failed", "The selected derivative exceeds the readable size limit");
        }
        const text = await object.text();
        if (text.length !== ready.totalCharacters) {
          throw attachmentError("resource_version_changed", "The selected derivative length no longer matches its version");
        }
        if (start > text.length) throw attachmentError("invalid_cursor", "The requested character position is outside this resource");
        start = safeUtf16Start(text, start);
        const end = safeUtf16End(text, Math.min(text.length, start + pageSize));
        const version = { sha256: ready.sha256, extractorVersion: ready.extractorVersion };
        const previousStart = Math.max(0, start - pageSize);
        const previousCursor = start > 0
          ? await sealReadCursor(env, input, options, resourceId, version, previousStart, pageSize)
          : null;
        const nextCursor = end < text.length
          ? await sealReadCursor(env, input, options, resourceId, version, end, pageSize)
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
        capability: `${capabilityPrefix}.search`,
        mode: "read",
        idempotency: "safe",
        inputSchema: z.toJSONSchema(AttachmentSearchResourceArgumentsSchema) as Record<string, unknown>,
      },
      execute: async (raw, context) => {
        const args = AttachmentSearchResourceArgumentsSchema.parse(raw);
        const row = await requireVisibleResource(env, input, options, args.resourceId);
        assertReadableKind(row, modelToolName("search_resource"), modelToolPrefix);
        const ready = await ensureReadyTextDerivative(env, row, context.signal);
        const [contentObject, indexObject] = await Promise.all([
          env.PAYLOADS.get(ready.contentRef),
          env.PAYLOADS.get(ready.indexRef),
        ]);
        if (!contentObject || !indexObject) throw attachmentError("resource_conversion_failed", "The selected derivative or index is unavailable");
        if (contentObject.size > MAX_DERIVATIVE_OBJECT_BYTES || indexObject.size > MAX_INDEX_OBJECT_BYTES) {
          throw attachmentError("resource_conversion_failed", "The selected derivative or index exceeds its readable size limit");
        }
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
        const ranked = index.chunks.map((chunk) => {
          const chunkText = text.slice(chunk.start, chunk.end).toLocaleLowerCase("en-US");
          return {
            chunk,
            score: queryTerms.reduce((score, term) => score + (chunkText.includes(term) ? 1 : 0), 0),
          };
        }).filter((candidate) => candidate.score > 0)
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
            readCursor: await sealReadCursor(env, input, options, row.id, version, range.start, DEFAULT_READ_CHARACTERS),
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
        description: `View one through eight visible image resources. The JSON result identifies ordered visual parts; readable text, Markdown, PDFs, documents, spreadsheets, and presentations self-heal with an exact ${modelToolName("read_resource")} suggestion.`,
        capability: `${capabilityPrefix}.view`,
        mode: "read",
        idempotency: "safe",
        inputSchema: z.toJSONSchema(AttachmentViewResourceArgumentsSchema) as Record<string, unknown>,
      },
      execute: async (raw) => {
        const args = AttachmentViewResourceArgumentsSchema.parse(raw);
        const visibleRows = await loadScopedResourceRows(env, input, options, args.resourceIds);
        const maxDimension = args.maxDimension ?? DEFAULT_IMAGE_MAX_DIMENSION;
        const contentParts: ModelMessageContentPart[] = [];
        let deliveredImageBytes = 0;
        const items = [];
        for (const resourceId of args.resourceIds) {
          const row = visibleRows.find((candidate) => candidate.id === resourceId);
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
            const suggestedCall = readSuggestion(row.id, modelToolPrefix);
            items.push(skippedViewItem(
              row.id,
              row.title,
              row.mime_type,
              "resource_tool_mismatch",
              `${modelToolName("view_resource")} cannot handle ${row.mime_type ?? kind} resources; call ${modelToolName("read_resource")} with the supplied arguments instead.`,
              suggestedCall,
            ));
            continue;
          }
          try {
            const image = await loadModelImageForTool(env.PAYLOADS, {
              id: row.id,
              workspaceId: row.workspace_id,
              fileName: row.title,
              mimeType: row.mime_type ?? "image/*",
              contentRef: row.content_ref,
              contentSha256: row.content_sha256,
              modelContentRef: row.model_content_ref,
              modelMimeType: row.model_mime_type,
              modelContentSha256: row.model_content_sha256,
              modelMetadataJson: row.model_metadata_json,
            }, {
              database: env.DB,
              images: env.IMAGES,
              maxDimension,
              maxBytes: MAX_TOTAL_MODEL_IMAGE_BYTES - deliveredImageBytes,
            });
            if (!image) {
              items.push(skippedViewItem(row.id, row.title, row.mime_type, "resource_conversion_failed", "The image could not be safely converted"));
              continue;
            }
            deliveredImageBytes += image.bytes.byteLength;
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
            attachmentKind: visibleRows.find((row) => row.id === wrongKind.resourceId)
              ? rowKind(visibleRows.find((row) => row.id === wrongKind.resourceId)!)
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
        capability: `${capabilityPrefix}.summarize`,
        mode: "read",
        idempotency: "safe",
        inputSchema: z.toJSONSchema(AttachmentSummarizeResourceArgumentsSchema) as Record<string, unknown>,
      },
      execute: async (raw, context) => {
        const args = AttachmentSummarizeResourceArgumentsSchema.parse(raw);
        const row = await requireVisibleResource(env, input, options, args.resourceId);
        assertReadableKind(row, modelToolName("summarize_resource"), modelToolPrefix);
        const ready = await ensureReadyTextDerivative(env, row, context.signal);
        const object = await env.PAYLOADS.get(ready.contentRef);
        if (!object) throw attachmentError("resource_conversion_failed", "The selected derivative is unavailable");
        if (object.size > MAX_DERIVATIVE_OBJECT_BYTES) {
          throw attachmentError("resource_conversion_failed", "The selected derivative exceeds the readable size limit");
        }
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
          readCursor: await sealReadCursor(env, input, options, row.id, version, citation.range.start, DEFAULT_READ_CHARACTERS),
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
  input: Pick<WorkstreamWorkflowInput, "workspaceId" | "workstreamId" | "executionPrincipal">,
  rawInput: unknown,
  rawOutput: unknown,
): Promise<ModelMessageContentPart[]> {
  const parsedInput = AttachmentViewResourceArgumentsSchema.safeParse(rawInput);
  const parsedOutput = WorkstreamViewResourceOutputSchema.safeParse(rawOutput);
  if (!parsedInput.success || !parsedOutput.success || parsedOutput.data.returned === 0) return [];
  const visible = await loadVisibleWorkstreamResourcesByIds(env.DB, {
    workspaceId: input.workspaceId,
    workstreamId: input.workstreamId,
    principal: input.executionPrincipal,
    resourceIds: parsedInput.data.resourceIds,
  });
  const included = parsedOutput.data.items
    .filter((item) => item.status === "included")
    .sort((left, right) => (left.visualPartIndex ?? 0) - (right.visualPartIndex ?? 0));
  const parts: ModelMessageContentPart[] = [];
  let deliveredImageBytes = 0;
  for (const item of included) {
    const row = visible.find((candidate) => candidate.id === item.resourceId);
    if (!row || rowKind(row) !== "image" || !item.version) return [];
    const image = await loadModelImageForTool(env.PAYLOADS, {
      id: row.id,
      workspaceId: row.workspace_id,
      fileName: row.title,
      mimeType: row.mime_type ?? "image/*",
      contentRef: row.content_ref,
      contentSha256: row.content_sha256,
      modelContentRef: row.model_content_ref,
      modelMimeType: row.model_mime_type,
      modelContentSha256: row.model_content_sha256,
      modelMetadataJson: row.model_metadata_json,
    }, {
      database: env.DB,
      images: env.IMAGES,
      maxDimension: parsedInput.data.maxDimension ?? DEFAULT_IMAGE_MAX_DIMENSION,
      maxBytes: MAX_TOTAL_MODEL_IMAGE_BYTES - deliveredImageBytes,
    });
    if (!image || image.sha256 !== item.version.sha256 || image.extractorVersion !== item.version.extractorVersion) return [];
    deliveredImageBytes += image.bytes.byteLength;
    parts.push({ type: "image_url", image_url: { url: modelImageDataUri(image.bytes, image.mimeType), detail: "auto" } });
  }
  return parts.length === parsedOutput.data.returned ? parts : [];
}

function readSuggestion(
  resourceId: string,
  modelToolPrefix: "workstream" | "automation" = "workstream",
): SuggestedAttachmentToolCall {
  return modelToolPrefix === "automation"
    ? { tool: "automation_read_resource", arguments: { resourceId } }
    : { tool: "workstream_read_resource", arguments: { resourceId } };
}

function skippedViewItem(
  resourceId: string,
  title: string,
  sourceMimeType: string | null,
  reasonCode: "resource_not_found" | "resource_processing" | "resource_conversion_failed" | "resource_format_unsupported" | "resource_tool_mismatch",
  reason: string,
  suggestedCall: SuggestedAttachmentToolCall | null = null,
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
  options: WorkstreamAttachmentToolOptions,
  resourceId: string,
): Promise<VisibleWorkstreamResourceRow> {
  const rows = await loadScopedResourceRows(env, input, options, [resourceId]);
  const row = rows.find((candidate) => candidate.id === resourceId);
  if (!row) throw attachmentError("resource_not_found", "The resource was not found");
  return row;
}

function assertReadableKind(
  row: VisibleWorkstreamResourceRow,
  calledTool: string,
  modelToolPrefix: "workstream" | "automation",
): void {
  const kind = rowKind(row);
  if (kind !== "image") return;
  throw attachmentError(
    "resource_tool_mismatch",
    `${calledTool} cannot handle ${row.mime_type ?? "image"} resources; call ${modelToolPrefix}_view_resource with the supplied arguments instead.`,
    {
      actualMimeType: row.mime_type,
      attachmentKind: kind,
      suggestedCall: modelToolPrefix === "automation"
        ? { tool: "automation_view_resource", arguments: { resourceIds: [row.id] } }
        : { tool: "workstream_view_resource", arguments: { resourceIds: [row.id] } },
    },
  );
}

async function ensureReadyTextDerivative(
  env: Env,
  row: VisibleWorkstreamResourceRow,
  signal: AbortSignal,
): Promise<Extract<MaterializedAttachmentDerivative, { status: "ready" }>> {
  const result = await materializeAttachmentDerivative(env.DB, env.PAYLOADS, authorizedDerivativeResource(row), {
    signal,
    pdfExtractor: extractPdfText,
    ocr: (bytes, pageCount) => ocrPdfWithWorkersAi(env.AI, row.title, bytes, pageCount, signal),
  });
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

async function ocrPdfWithWorkersAi(
  ai: Ai,
  title: string,
  bytes: Uint8Array,
  pageCount: number,
  signal: AbortSignal,
) {
  if (signal.aborted) throw signal.reason;
  const response = await ai.toMarkdown({
    name: title.toLowerCase().endsWith(".pdf") ? title : `${title}.pdf`,
    blob: new Blob([exactArrayBuffer(bytes)], { type: "application/pdf" }),
  }, {
    conversionOptions: {
      output: { format: "text" },
      pdf: { images: { convert: true, maxConvertedImages: Math.min(pageCount, 200) } },
    },
  });
  if (signal.aborted) throw signal.reason;
  if (response.format === "error" || response.data.trim().length === 0) {
    throw new Error("pdf_ocr_failed");
  }
  // Workers AI returns one ordered document string. Preserve the known page
  // cardinality while making unavailable exact OCR page boundaries explicit.
  return {
    pages: [response.data, ...Array.from({ length: Math.max(0, pageCount - 1) }, () => "")],
    method: "provider_ocr" as const,
  };
}

async function extractPdfText(bytes: Uint8Array) {
  const pdf = await getDocumentProxy(bytes);
  if (pdf.numPages > 200) return { pageCount: pdf.numPages, pages: [] };
  const extracted = await extractText(pdf);
  return { pageCount: extracted.totalPages, pages: Array.isArray(extracted.text) ? extracted.text : [extracted.text] };
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function authorizedDerivativeResource(row: VisibleWorkstreamResourceRow): AuthorizedDerivativeResource {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
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
    modelContentClaimedAt: row.model_content_claimed_at,
    modelContentClaimId: row.model_content_claim_id,
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
  options: WorkstreamAttachmentToolOptions,
  purpose: string,
  state: Record<string, unknown>,
): Promise<string> {
  return sealAttachmentCursor(env.SESSION_SIGNING_KEY, {
    purpose: scopedCursorPurpose(options, purpose),
    principal: executionPrincipalKey(input.executionPrincipal),
    scopeId: input.workstreamId,
    expiresAt: Date.now() + CURSOR_TTL_MS,
    state,
  });
}

async function openCursorState<T>(
  env: Env,
  input: WorkstreamWorkflowInput,
  options: WorkstreamAttachmentToolOptions,
  cursor: string,
  purpose: string,
  schema: z.ZodType<T>,
): Promise<T> {
  try {
    const payload = await openAttachmentCursor(env.SESSION_SIGNING_KEY, cursor, {
      purpose: scopedCursorPurpose(options, purpose),
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
  options: WorkstreamAttachmentToolOptions,
  resourceId: string,
  version: { sha256: string; extractorVersion: string },
  start: number,
  pageSize: number,
): Promise<string> {
  return sealCursorState(env, input, options, READ_CURSOR_PURPOSE, { resourceId, ...version, start, pageSize });
}

async function loadScopedResourceRows(
  env: Env,
  input: WorkstreamWorkflowInput,
  options: WorkstreamAttachmentToolOptions,
  resourceIds: readonly string[],
): Promise<VisibleWorkstreamResourceRow[]> {
  if (options.loadVisibleResources) {
    const visible = await options.loadVisibleResources();
    const requested = new Set(resourceIds);
    return visible.rows.filter((row) => requested.has(row.id));
  }
  return loadVisibleWorkstreamResourcesByIds(env.DB, {
    workspaceId: input.workspaceId,
    workstreamId: input.workstreamId,
    principal: input.executionPrincipal,
    resourceIds,
  });
}

function scopedCursorPurpose(options: WorkstreamAttachmentToolOptions, purpose: string): string {
  return options.cursorNamespace === "automation-draft"
    ? purpose.replace(/^workstream-/u, "automation-draft-")
    : purpose;
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
  return { start: safeUtf16Start(text, start), end: safeUtf16End(text, end) };
}

function safeUtf16Start(text: string, offset: number): number {
  return offset > 0 && offset < text.length
    && isLowSurrogate(text.charCodeAt(offset))
    && isHighSurrogate(text.charCodeAt(offset - 1))
    ? offset - 1
    : offset;
}

function safeUtf16End(text: string, offset: number): number {
  return offset > 0 && offset < text.length
    && isHighSurrogate(text.charCodeAt(offset - 1))
    && isLowSurrogate(text.charCodeAt(offset))
    ? offset - 1
    : offset;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

function attachmentError(code: string, message: string, details?: Record<string, unknown>): AttachmentOperationError {
  return new AttachmentOperationError(code, message, details);
}
