import type { HarnessToolContext, ModelMessageContentPart } from "@rally/agent-harness";
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
  AttachmentKindSchema,
  classifyAttachmentKind,
  ResourceRelationshipTypeSchema,
  resourceDirectionForRelationship,
  type AttachmentKind,
  type ContentMode,
  type SuggestedAttachmentToolCall,
  type WorkstreamWorkflowInput,
} from "@rally/contracts";
import { z } from "zod";
import type { Env } from "../env";
import { AttachmentCursorError, openAttachmentCursor } from "../lib/attachment-cursor";
import { logStructuredEvent } from "../observability/logger";
import type { PaginatedHarnessTool } from "./tool-pagination";
import {
  ATTACHMENT_TEXT_EXTRACTOR_VERSION,
  materializeAttachmentDerivative,
  ocrPdfWithWorkersAi,
  type AuthorizedDerivativeResource,
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
import { createConversationResourceLinks } from "../runtime/resource-port";
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
const DEFAULT_LIST_LIMIT = 25;
const DEFAULT_READ_CHARACTERS = 12_000;
const MAXIMUM_READ_CHARACTERS = 24_000;
const DEFAULT_SEARCH_LIMIT = 5;
const DEFAULT_PASSAGE_CHARACTERS = 3_000;
const MAXIMUM_SEARCH_RESULT_CHARACTERS = 20_000;
const DEFAULT_IMAGE_MAX_DIMENSION = 1_536;
const DEFAULT_SUMMARY_CHARACTERS = 12_000;
const MAX_DERIVATIVE_OBJECT_BYTES = 8 * 1024 * 1024;
const SEARCH_CHUNK_CHARACTERS = 4_000;

export interface WorkstreamAttachmentToolOptions {
  summarizeDerivative?: AttachmentSummaryRunner;
  /** Reuse the derivative/tool implementation behind a separately authorized scope. */
  loadVisibleResources?: () => Promise<VisibleWorkstreamResourceSet>;
  cursorNamespace?: "workstream" | "automation-draft";
  modelToolPrefix?: "workstream" | "sidekick";
  capabilityPrefix?: string;
}

const ListCursorStateSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("database"),
    fingerprint: z.string().min(1).max(100),
    attachmentKind: AttachmentKindSchema.nullable(),
    limit: z.number().int().min(1).max(50),
    afterAttachedAt: z.string().datetime({ offset: true }),
    afterResourceId: z.string().uuid(),
    asOf: z.string().datetime({ offset: true }),
  }),
  z.strictObject({
    mode: z.literal("in_memory"),
    fingerprint: z.string().min(1).max(100),
    attachmentKind: AttachmentKindSchema.nullable(),
    limit: z.number().int().min(1).max(50),
    nextIndex: z.number().int().nonnegative(),
    asOf: z.string().datetime({ offset: true }),
  }),
]);

const ReadCursorStateSchema = z.strictObject({
  resourceId: z.string().uuid(),
  sha256: z.string().min(1).max(128),
  extractorVersion: z.string().min(1).max(160),
  start: z.number().int().nonnegative(),
  pageSize: z.number().int().min(1).max(MAXIMUM_READ_CHARACTERS),
});

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
): PaginatedHarnessTool[] {
  const summarizeDerivative = options.summarizeDerivative ?? createAttachmentSummaryRunner(env);
  const modelToolPrefix = options.modelToolPrefix ?? "workstream";
  const capabilityPrefix = options.capabilityPrefix ?? "workstream.resources";
  // `rally:workstream` advertises these unprefixed, so a workstream-scoped run
  // must be told the bare name. Only the Sidekick-scoped variant still carries
  // one. Building this by interpolation is how the rename first missed every
  // remediation string in this file: they named tools the run does not offer,
  // beside a `suggestedCall` that named them correctly.
  const modelToolName = (name: string) =>
    modelToolPrefix === "sidekick" ? `sidekick_${name}` : name;
  return [
    {
      definition: {
        name: "list_resources",
        pagination: { cursorParameter: "cursor" },
        description: options.modelToolPrefix === "sidekick"
          ? ATTACHMENT_LIST_RESOURCES_DESCRIPTION.replace("this work stream", "this Sidekick draft's frozen attachment set")
          : ATTACHMENT_LIST_RESOURCES_DESCRIPTION,
        capability: `${capabilityPrefix}.list`,
        mode: "read",
        idempotency: "safe",
        inputSchema: z.toJSONSchema(AttachmentListResourcesArgumentsSchema, { io: "input" }) as Record<string, unknown>,
      },
      // The exclusivity between a cursor and the first page's filters is a
      // refinement, and `z.toJSONSchema` cannot carry one, so the declared
      // schema accepts an argument set the executor then rejects. Without the
      // hook the runtime files that rejection as this tool's own data problem
      // and tells the model to retry the same arguments.
      validateInput: (raw) => {
        const result = AttachmentListResourcesArgumentsSchema.safeParse(raw);
        return result.success ? null : result.error;
      },
      execute: async (raw) => {
        const args = AttachmentListResourcesArgumentsSchema.parse(raw);
        // The arguments are one flat object now, so presence is `!== undefined`
        // rather than `in`: an optional key the model omitted is absent, but an
        // executor that asked `in` would also accept an explicit `undefined`
        // and hand it to a cursor read as if it were a cursor.
        const state = args.cursor !== undefined
          ? await openCursorState(env, input, options, args.cursor, LIST_CURSOR_PURPOSE, ListCursorStateSchema)
          : null;
        const attachmentKind = state?.attachmentKind ?? args.attachmentKind ?? null;
        const limit = state?.limit ?? args.limit ?? DEFAULT_LIST_LIMIT;
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
            workstreamId: input.parentId,
            asOf,
            totalVisibleResources: visible.rows.length,
            totalMatchingResources: matching.length,
            filters: { attachmentKind },
            items: page.map(resourceListItem),
            nextCursor,
          });
          const { nextCursor: continuation, ...data } = output;
          return { output: data, summary: `Listed ${page.length} of ${matching.length} matching work-stream resources`,
            pagination: { continuations: continuation ? [{ operation: "list_resources", slot: "nextPageId" as const, input: { cursor: continuation } }] : [] },
          };
        }
        if (state && state.mode !== "database") {
          throw attachmentError("invalid_cursor", "This resource cursor belongs to another resource scope");
        }
        let result;
        try {
          result = await loadVisibleWorkstreamResourcePage(
            env.DB,
            createConversationResourceLinks(env, input.workspaceId, input.parentId, undefined, undefined, input.executionPrincipal),
            {
              workspaceId: input.workspaceId,
              workstreamId: input.parentId,
              principal: input.executionPrincipal,
              attachmentKind,
              limit,
              ...(state ? { expectedFingerprint: state.fingerprint } : {}),
              after: state
                ? { attachedAt: state.afterAttachedAt, resourceId: state.afterResourceId }
                : null,
            },
          );
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
          workstreamId: input.parentId,
          asOf,
          totalVisibleResources: result.totalVisibleResources,
          totalMatchingResources: result.totalMatchingResources,
          filters: { attachmentKind },
          items: result.rows.map(resourceListItem),
          nextCursor,
        });
        const { nextCursor: continuation, ...data } = output;
        return {
          output: data,
          pagination: { continuations: continuation ? [{ operation: "list_resources", slot: "nextPageId" as const, input: { cursor: continuation } }] : [] },
          summary: `Listed ${result.rows.length} of ${result.totalMatchingResources} matching work-stream resources`,
        };
      },
    },
    {
      definition: {
        name: "read_resource",
        pagination: { cursorParameter: "cursor" },
        description: [
          "Read one bounded page from a visible text, Markdown, PDF, document, spreadsheet, or presentation derivative.",
          "Start with resourceId and optional startCharacter. Continue using read_resource_next with nextPageId, or read_resource_previous with previousPageId.",
          "Use charactersBefore and charactersAfter to tell whether the page covers the whole resource.",
        ].join(" "),
        capability: `${capabilityPrefix}.read`,
        mode: "read",
        idempotency: "safe",
        inputSchema: z.toJSONSchema(AttachmentReadResourceArgumentsSchema, { io: "input" }) as Record<string, unknown>,
      },
      // Same reason as `list_resources` above: exactly one of `resourceId` or
      // `cursor` is a refinement the wire schema cannot state, so the model has
      // to be the one told it got the arguments wrong.
      validateInput: (raw) => {
        const result = AttachmentReadResourceArgumentsSchema.safeParse(raw);
        return result.success ? null : result.error;
      },
      execute: async (raw, context) => {
        const args = AttachmentReadResourceArgumentsSchema.parse(raw);
        let resourceId: string;
        let start: number;
        let pageSize = DEFAULT_READ_CHARACTERS;
        let cursorVersion: { sha256: string; extractorVersion: string } | null = null;
        if (args.cursor !== undefined) {
          const state = await openCursorState(env, input, options, args.cursor, READ_CURSOR_PURPOSE, ReadCursorStateSchema);
          resourceId = state.resourceId;
          start = state.start;
          pageSize = state.pageSize;
          cursorVersion = { sha256: state.sha256, extractorVersion: state.extractorVersion };
        } else if (args.resourceId !== undefined) {
          resourceId = args.resourceId;
          start = args.startCharacter ?? 0;
        } else {
          // Unreachable: the schema's refinement requires exactly one of the
          // two. Stated rather than asserted with `!`, so a refinement someone
          // relaxes later fails as this tool's own error instead of reading a
          // resource named `undefined`.
          throw attachmentError(
            "invalid_arguments",
            "Send exactly one of resourceId or cursor",
          );
        }
        let row: VisibleWorkstreamResourceRow;
        let ready: Awaited<ReturnType<typeof ensureReadyTextDerivative>>;
        try {
          row = await requireVisibleResource(env, input, options, resourceId);
          assertReadableKind(row, modelToolName("read_resource"), modelToolPrefix);
          ready = await ensureReadyTextDerivative(env, row, context);
        } catch (error) {
          if (error instanceof AttachmentOperationError) {
            throw attachmentError(error.code, error.message, { ...error.details, resourceId });
          }
          throw error;
        }
        if (cursorVersion && (cursorVersion.sha256 !== ready.sha256 || cursorVersion.extractorVersion !== ready.extractorVersion)) {
          throw attachmentError(
            "resource_version_changed",
            "The resource changed; restart the read from its resource ID",
            { resourceId },
          );
        }
        const object = await env.PAYLOADS.get(ready.contentRef);
        if (!object) {
          throw attachmentError("resource_conversion_failed", "The selected derivative is unavailable", { resourceId });
        }
        if (object.size > MAX_DERIVATIVE_OBJECT_BYTES) {
          throw attachmentError(
            "resource_conversion_failed",
            "The selected derivative exceeds the readable size limit",
            { resourceId },
          );
        }
        const text = await object.text();
        if (text.length !== ready.totalCharacters) {
          throw attachmentError(
            "resource_version_changed",
            "The selected derivative length no longer matches its version",
            { resourceId },
          );
        }
        if (start > text.length) {
          throw attachmentError("invalid_cursor", "The requested character position is outside this resource", { resourceId });
        }
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
        const { nextCursor: next, previousCursor: previous, ...data } = output;
        return { output: { ...data, previousPageId: null }, summary: `Read ${end - start} characters from ${row.title}`,
          pagination: { continuations: [
            ...(next ? [{ operation: "read_resource", slot: "nextPageId" as const, input: { cursor: next } }] : []),
            ...(previous ? [{ operation: "read_resource_previous", slot: "previousPageId" as const, input: { cursor: previous } }] : []),
          ] },
        };
      },
      continuationDetails: async (continuationInput) => {
        const continuation = z.object({ cursor: z.string() }).safeParse(continuationInput);
        if (!continuation.success) return null;
        const state = await openCursorState(
          env, input, options, continuation.data.cursor, READ_CURSOR_PURPOSE, ReadCursorStateSchema,
        );
        return { resourceId: state.resourceId };
      },
    },
    {
      definition: {
        name: "search_resource",
        pagination: { cursorParameter: "cursor", sourceOnly: true },
        description: "Search one visible text, Markdown, PDF, document, spreadsheet, or presentation derivative. Results are bounded passages from this resource only; use each readPageId with read_resource_next to inspect its surrounding text.",
        capability: `${capabilityPrefix}.search`,
        mode: "read",
        idempotency: "safe",
        inputSchema: z.toJSONSchema(AttachmentSearchResourceArgumentsSchema, { io: "input" }) as Record<string, unknown>,
      },
      execute: async (raw, context) => {
        const args = AttachmentSearchResourceArgumentsSchema.parse(raw);
        const row = await requireVisibleResource(env, input, options, args.resourceId);
        assertReadableKind(row, modelToolName("search_resource"), modelToolPrefix);
        const ready = await ensureReadyTextDerivative(env, row, context);
        const contentObject = await env.PAYLOADS.get(ready.contentRef);
        if (!contentObject) throw attachmentError("resource_conversion_failed", "The selected derivative is unavailable");
        if (contentObject.size > MAX_DERIVATIVE_OBJECT_BYTES) {
          throw attachmentError("resource_conversion_failed", "The selected derivative exceeds its readable size limit");
        }
        const text = await contentObject.text();
        if (text.length !== ready.totalCharacters) {
          throw attachmentError("resource_version_changed", "The selected derivative length no longer matches its version");
        }
        const queryTerms = normalizedTerms(args.query);
        const normalizedQuery = args.query.trim().toLocaleLowerCase("en-US");
        const ranked = derivativeSearchChunks(text).map((chunk) => {
          const chunkText = text.slice(chunk.start, chunk.end).toLocaleLowerCase("en-US");
          const exactMatch = normalizedQuery ? chunkText.indexOf(normalizedQuery) : -1;
          const termMatches = queryTerms.flatMap((term) => {
            const offset = chunkText.indexOf(term);
            return offset >= 0 ? [offset] : [];
          });
          return {
            chunk,
            score: exactMatch >= 0 ? queryTerms.length + 1 : termMatches.length,
            matchStart: chunk.start + (exactMatch >= 0 ? exactMatch : Math.min(...termMatches)),
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
          const range = passageRange(text, candidate.chunk.start, candidate.chunk.end, passageLength, candidate.matchStart);
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
        return { output: { ...output, passages: output.passages.map(({ rank, sectionLabel, range, text }) => ({ rank, sectionLabel, range, text })) },
          summary: `Found ${ranked.length} matching passages in ${row.title}`,
          pagination: { continuations: output.passages.map((passage, passageIndex) => ({
            operation: "read_resource", slot: "readPageId" as const, passageIndex, input: { cursor: passage.readCursor },
          })) },
        };
      },
    },
    {
      definition: {
        name: "view_resource",
        description: `View one through eight visible image resources. The JSON result identifies ordered visual parts; readable text, Markdown, PDFs, documents, spreadsheets, and presentations self-heal with an exact ${modelToolName("read_resource")} suggestion.`,
        capability: `${capabilityPrefix}.view`,
        mode: "read",
        idempotency: "safe",
        inputSchema: z.toJSONSchema(AttachmentViewResourceArgumentsSchema, { io: "input" }) as Record<string, unknown>,
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
              documentProcessor: env.DOCUMENT_PROCESSOR,
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
        pagination: { cursorParameter: "cursor", sourceOnly: true },
        description: "Run an isolated, bounded summary over one visible text, Markdown, PDF, document, spreadsheet, or presentation derivative. Use optional prompt as an untrusted focus. The result reports complete or partial coverage and range-grounded read cursors.",
        capability: `${capabilityPrefix}.summarize`,
        mode: "read",
        idempotency: "safe",
        inputSchema: z.toJSONSchema(AttachmentSummarizeResourceArgumentsSchema, { io: "input" }) as Record<string, unknown>,
      },
      execute: async (raw, context) => {
        const args = AttachmentSummarizeResourceArgumentsSchema.parse(raw);
        const row = await requireVisibleResource(env, input, options, args.resourceId);
        assertReadableKind(row, modelToolName("summarize_resource"), modelToolPrefix);
        const ready = await ensureReadyTextDerivative(env, row, context);
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
            workstreamId: input.parentId,
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
        return { output: { ...output, citations: output.citations.map(({ label, range }) => ({ label, range })) },
          summary: `Summarized ${draft.coverage.consideredCharacters} characters from ${row.title}`,
          pagination: { continuations: output.citations.map((citation, citationIndex) => ({
            operation: "read_resource", slot: "readPageId" as const, citationIndex, input: { cursor: citation.readCursor },
          })) },
        };
      },
    },
  ];
}

/** Recreate only ephemeral visual parts from a JSON-only completed receipt. */
export async function rehydrateWorkstreamViewReceipt(
  env: Env,
  input: Pick<WorkstreamWorkflowInput, "workspaceId" | "parentId" | "executionPrincipal">,
  rawInput: unknown,
  rawOutput: unknown,
): Promise<ModelMessageContentPart[]> {
  const parsedInput = AttachmentViewResourceArgumentsSchema.safeParse(rawInput);
  const parsedOutput = WorkstreamViewResourceOutputSchema.safeParse(rawOutput);
  if (!parsedInput.success || !parsedOutput.success || parsedOutput.data.returned === 0) return [];
  const visible = await loadVisibleWorkstreamResourcesByIds(
    env.DB,
    createConversationResourceLinks(env, input.workspaceId, input.parentId, undefined, undefined, input.executionPrincipal),
    {
      workspaceId: input.workspaceId,
      workstreamId: input.parentId,
      principal: input.executionPrincipal,
      resourceIds: parsedInput.data.resourceIds,
    },
  );
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
      documentProcessor: env.DOCUMENT_PROCESSOR,
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
  modelToolPrefix: "workstream" | "sidekick" = "workstream",
): SuggestedAttachmentToolCall {
  return modelToolPrefix === "sidekick"
    ? { tool: "sidekick_read_resource", arguments: { resourceId } }
    : { tool: "read_resource", arguments: { resourceId } };
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

/**
 * What a content read on a *site* gets instead of a dead end.
 *
 * A site has no single content body to return — its stored content is a
 * manifest, not a page — so this failure is not an edge case, it is the natural
 * next call a model makes after connecting "the artifact" to "a resource in
 * this work stream". The failure path is therefore where that connection gets
 * taught, which is why it names the import rather than merely refusing.
 *
 * **It is prefix-aware, and the automation branch names no tool at all.** The
 * same failure fires from automation-prefixed runs, and the tool it would name
 * is a Terminal one those runs do not hold: naming it would trade one dead end
 * for a worse one, and the sanitizer would drop the unrecognized entry anyway.
 *
 * The suggestion carries `{ resourceId }` alone — the create-only form, which
 * refuses a non-empty destination rather than replacing anything — so a model
 * that follows it blind cannot lose work.
 */
export function siteReadRemediation(
  resourceId: string,
  mimeType: string | null,
  calledTool: string,
  modelToolPrefix: "workstream" | "sidekick",
): AttachmentOperationError {
  return attachmentError(
    "resource_tool_mismatch",
    modelToolPrefix === "sidekick"
      ? `${calledTool} cannot read a site; a site's source is edited in a terminal workspace, which this run does not have.`
      : `${calledTool} cannot read a site; a site's source is edited in the terminal workspace, so import it there to read or revise it.`,
    {
      actualMimeType: mimeType,
      attachmentKind: "site",
      ...(modelToolPrefix === "sidekick"
        ? {}
        : { suggestedCall: { tool: "import_resource", arguments: { resourceId } } }),
    },
  );
}

function assertReadableKind(
  row: VisibleWorkstreamResourceRow,
  calledTool: string,
  modelToolPrefix: "workstream" | "sidekick",
): void {
  const kind = rowKind(row);
  if (kind === "site") throw siteReadRemediation(row.id, row.mime_type, calledTool, modelToolPrefix);
  if (kind !== "image") return;
  throw attachmentError(
    "resource_tool_mismatch",
    `${calledTool} cannot handle ${row.mime_type ?? "image"} resources; call ${modelToolPrefix === "sidekick" ? "sidekick_view_resource" : "view_resource"} with the supplied arguments instead.`,
    {
      actualMimeType: row.mime_type,
      attachmentKind: kind,
      suggestedCall: modelToolPrefix === "sidekick"
        ? { tool: "sidekick_view_resource", arguments: { resourceIds: [row.id] } }
        : { tool: "view_resource", arguments: { resourceIds: [row.id] } },
    },
  );
}

async function ensureReadyTextDerivative(
  env: Env,
  row: VisibleWorkstreamResourceRow,
  context: HarnessToolContext,
): Promise<Extract<MaterializedAttachmentDerivative, { status: "ready" }>> {
  const result = await materializeAttachmentDerivative(env.DB, env.PAYLOADS, authorizedDerivativeResource(row), {
    signal: context.signal,
    pdfExtractor: (bytes) => env.DOCUMENT_PROCESSOR.extractText(bytes),
    ocr: (bytes, pageCount) => ocrPdfWithWorkersAi(env.AI, row.title, bytes, pageCount, context.signal,
      { env, workspaceId: row.workspace_id, sourceId: row.id }),
    onPhase: (event) => logStructuredEvent(env, "info", "attachment_derivative_phase_finished", {
      workspace_id: context.workspaceId,
      workstream_id: context.workstreamId,
      harness_run_id: context.harnessRunId,
      tool_call_id: context.toolCallId,
      resource_id: row.id,
      phase: event.phase,
      outcome: event.outcome,
      duration_ms: event.durationMs,
      ...(event.errorCode ? { code: event.errorCode } : {}),
    }),
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
    modelContentStatus: row.model_content_status,
    modelContentExtractorVersion: row.model_content_extractor_version,
    modelContentCharacterCount: row.model_content_character_count,
    modelContentClaimedAt: row.model_content_claimed_at,
    modelContentClaimId: row.model_content_claim_id,
    modelContentErrorCode: row.model_content_error_code,
  };
}

function resourceListItem(row: VisibleWorkstreamResourceRow) {
  const attachmentKind = rowKind(row);
  const relationshipType = ResourceRelationshipTypeSchema.parse(row.relationship_type);
  return {
    resourceId: row.id,
    slug: row.slug,
    title: row.title,
    resourceType: row.resource_type,
    provider: row.provider,
    mimeType: row.mime_type,
    sizeBytes: metadataSize(row.metadata_json),
    relationshipType,
    direction: resourceDirectionForRelationship(relationshipType),
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
  if (kind === "audio") return "unsupported";
  if (row.model_content_status === "unsupported"
    && row.model_content_extractor_version === ATTACHMENT_TEXT_EXTRACTOR_VERSION) return "unsupported";
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
  // This payload is private continuation input stored by the receipt authority,
  // never an argument exposed to the model. Keep scope checks, not a second TTL.
  return JSON.stringify({
    purpose: scopedCursorPurpose(options, purpose),
    principal: executionPrincipalKey(input.executionPrincipal),
    scopeId: input.parentId,
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
    const expected = {
      purpose: scopedCursorPurpose(options, purpose),
      principal: executionPrincipalKey(input.executionPrincipal),
      scopeId: input.parentId,
    };
    // Signed tokens remain readable for receipts produced before this cutover.
    const payload = cursor.startsWith("{")
      ? z.object({ purpose: z.literal(expected.purpose), principal: z.literal(expected.principal),
          scopeId: z.literal(expected.scopeId), state: z.record(z.string(), z.unknown()) }).parse(JSON.parse(cursor))
      : await openAttachmentCursor(env.SESSION_SIGNING_KEY, cursor, expected);
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
  return loadVisibleWorkstreamResourcesByIds(
    env.DB,
    createConversationResourceLinks(env, input.workspaceId, input.parentId, undefined, undefined, input.executionPrincipal),
    {
      workspaceId: input.workspaceId,
      workstreamId: input.parentId,
      principal: input.executionPrincipal,
      resourceIds,
    },
  );
}

function scopedCursorPurpose(options: WorkstreamAttachmentToolOptions, purpose: string): string {
  return options.cursorNamespace === "automation-draft"
    ? purpose.replace(/^workstream-/u, "automation-draft-")
    : purpose;
}

function normalizedTerms(value: string): string[] {
  return [...new Set(value.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}_-]+/gu) ?? [])];
}

function passageRange(
  text: string,
  chunkStart: number,
  chunkEnd: number,
  maximumLength: number,
  matchStart: number,
): { start: number; end: number } {
  let start = Math.max(chunkStart, matchStart - Math.floor(maximumLength / 3));
  const end = Math.min(chunkEnd, start + maximumLength);
  if (end - start < maximumLength) start = Math.max(0, end - maximumLength);
  return { start: safeUtf16Start(text, start), end: safeUtf16End(text, end) };
}

function derivativeSearchChunks(text: string): Array<{
  start: number;
  end: number;
  sectionLabel: string | null;
}> {
  const chunks = [];
  let sectionLabel: string | null = null;
  for (let start = 0; start < text.length;) {
    const hardEnd = Math.min(text.length, start + SEARCH_CHUNK_CHARACTERS);
    const candidate = text.slice(start, hardEnd);
    const headings = [...candidate.matchAll(/^#{1,6}\s+(.+)$/gmu)];
    if (headings.length > 0) sectionLabel = headings.at(-1)?.[1]?.trim() || sectionLabel;
    let end = hardEnd;
    if (hardEnd < text.length) {
      const boundary = Math.max(candidate.lastIndexOf("\n\n"), candidate.lastIndexOf("\n"));
      if (boundary >= Math.floor(SEARCH_CHUNK_CHARACTERS / 2)) end = start + boundary + 1;
      end = safeUtf16End(text, end);
    }
    chunks.push({ start, end, sectionLabel });
    start = end;
  }
  return chunks;
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
