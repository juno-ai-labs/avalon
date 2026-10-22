import { z } from "zod";
import { ToolExecutionAccountSchema } from "@rally/contracts";
import { validateToolArguments } from "@rally/agent-harness";
import { stableWireToolName } from "./connector-tool-inventory";
import { ObjectPortError } from "../runtime/object-port";
import type { HarnessTool, HarnessToolContext, HarnessToolResult } from "@rally/agent-harness";
import type { ToolReceiptObjectPort } from "../durable-objects/workstream-tool-receipt-protocol";
import type { ToolReceiptFence } from "../durable-objects/workstream-tool-receipt-storage";

function pageInput(prefix: string, wirePrefix: string, operation: string, previous = false) {
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const schema = z.strictObject({ pageId: z.string()
    .regex(new RegExp(`^${escapedPrefix}_[a-z]+_[a-z]+_[a-z]+_[a-z]+$`, "u"))
    .describe("Copy the page ID returned by this plugin. Send it alone; filters and page size are retained automatically.") });
  const field = previous ? "previousPageId" : operation === "read_resource" ? "nextPageId or readPageId" : "nextPageId";
  const message = `Send only {"pageId":"<copied ID>"}. pageId must start with "${prefix}_", followed by exactly four lowercase words separated by underscores. Copy ${field} exactly from a tool result; do not invent or repair an ID. If that field is null, stop: there is no page. If you have no ID, call ${stableWireToolName(wirePrefix, operation)} to start a new read.`;
  function validateInput(input: unknown) {
    return schema.safeParse(input).success ? null : new z.ZodError([
      { code: "custom", path: ["pageId"], message },
    ]);
  }
  return { schema, validateInput, parse(input: unknown) {
    const error = validateInput(input);
    if (error) throw error;
    return schema.parse(input);
  } };
}

export interface PaginationHost {
  receipts: Pick<ToolReceiptObjectPort, "issuePage" | "claimPage">;
  fence: ToolReceiptFence | (() => ToolReceiptFence);
  /**
   * The namespace a minted page ID carries (`workstream_brave_clever_…`). It is
   * required and non-empty: `tool-page-storage` builds every ID as
   * `<prefix>_<four words>` and validates that shape on the way back in.
   */
  prefix: string;
  /**
   * The plugin's *model-facing* wire prefix, for the tool names these
   * descriptions tell the model to call. Usually the same string as `prefix`,
   * and deliberately not the same field: a plugin that declares no wire prefix
   * still needs a page-ID namespace, and naming `workstream_list_resources` in
   * a description would point the model at a tool this run does not advertise.
   */
  wirePrefix?: string;
  connectionId: string | null;
}

/**
 * The tool names one authored definition becomes once {@link withToolPagination}
 * expands it: itself alone when it is not paginated or is `sourceOnly`, a
 * `_next` beside it otherwise, and `read_resource_previous` as well for
 * `read_resource`. The expansion takes its names from here, so anything that
 * counts what an activation offers — Settings' Tools column — cannot drift from
 * what the activation builds.
 */
export function paginatedToolNames(definition: Pick<HarnessTool["definition"], "name" | "pagination">): string[] {
  const operation = definition.name;
  if (!definition.pagination || definition.pagination.sourceOnly === true) return [operation];
  if (operation !== "read_resource") return [operation, `${operation}_next`];
  return [operation, `${operation}_next`, "read_resource_previous"];
}

/**
 * An authored paginated tool that can name what one of its continuations
 * reads, as structured failure details (`{ resourceId }` for a resource read).
 * It runs only to describe a page that cannot be redeemed, never to execute
 * it; the attachment grounding guard needs the identity to clear the failure.
 */
export type PaginatedHarnessTool = HarnessTool & {
  continuationDetails?: (continuationInput: unknown) => Promise<Record<string, unknown> | null>;
};

/** Expand only an explicitly authored tool. Private continuations never escape this wrapper. */
export function withToolPagination(tool: PaginatedHarnessTool, host: PaginationHost): HarnessTool[] {
  const pagination = tool.definition.pagination;
  if (!pagination) return [tool];
  const sourceOnly = pagination.sourceOnly === true;
  const wirePrefix = host.wirePrefix ?? host.prefix;
  const operation = tool.definition.name;
  const [, nextName, previousName] = paginatedToolNames(tool.definition);
  const schema = tool.definition.inputSchema;
  const properties = z.record(z.string(), z.unknown()).parse(schema.properties ?? {});
  const firstProperties = { ...properties };
  delete firstProperties[pagination.cursorParameter];
  const firstSchema = { ...schema, properties: firstProperties,
    required: operation === "read_resource" ? ["resourceId"] : Array.isArray(schema.required) ? schema.required.filter((name) => name !== pagination.cursorParameter) : [],
    additionalProperties: false,
  };
  // The shared JSON Schema classifier deliberately tolerates unsupported
  // schemas. Key exclusion is an execution contract, not just a classifier.
  const firstKeys = z.strictObject(Object.fromEntries(
    Object.keys(firstProperties).map((name) => [name, z.unknown().optional()]),
  ));
  function identity(context: HarnessToolContext) {
    if (!context.effectIntentId) throw new Error("page_execution_receipt_missing");
    return {
      runId: context.harnessRunId, effectIntentId: context.effectIntentId,
      operation, connectionId: host.connectionId,
      principalJson: JSON.stringify(context.executionPrincipal), fence: typeof host.fence === "function" ? host.fence() : host.fence,
    };
  }
  const firstName = stableWireToolName(wirePrefix, operation);
  async function claim(pageId: string, context: HarnessToolContext, target = operation) {
    let claimed;
    try {
      claimed = await host.receipts.claimPage({ ...identity(context), operation: target, pageId });
    } catch (error) {
      let message = error instanceof ObjectPortError ? error.code : error instanceof Error ? error.message : "";
      // Storage cannot name the model's tools, so the instruction is written
      // here. It covers wrong-scope and uncommitted pages too, where the ID
      // was copied exactly, so it says only what to do next.
      const unknownPage = message.startsWith("page_id_invalid:");
      if (unknownPage) {
        message = `page_id_invalid: This page ID cannot be used here. Call ${firstName} to start a new read.`;
      }
      // Keep the attachment grounding guard's existing, bounded recovery
      // semantics when a model damages a page ID before resource resolution.
      if (operation === "read_resource" && unknownPage) {
        throw Object.assign(new Error(message), { code: "invalid_cursor" });
      }
      if (unknownPage || (error instanceof ObjectPortError && message.startsWith("page_"))) throw new Error(message, { cause: error });
      throw error;
    }
    if (!claimed.refused) return claimed;
    // Across runs the guard has no memory of this page, so without the
    // identity its failure stays anonymous and no later read can clear it.
    const details = await tool.continuationDetails?.(JSON.parse(claimed.inputJson)).catch(() => null);
    throw Object.assign(new Error(claimed.refused === "page_already_consumed"
      ? `page_already_consumed: This page was already read. Use the nextPageId from that read's result, or call ${firstName} to start a new read.`
      : "page_in_progress: This page already has a call in progress."),
    { code: claimed.refused, ...(details ? { details } : {}) });
  }
  async function execute(input: unknown, context: HarnessToolContext): Promise<HarnessToolResult> {
    const result = await tool.execute(input, context);
    if (!result.pagination) throw new Error("page_continuation_contract_missing");
    const output = z.record(z.string(), z.unknown()).parse(result.output);
    const publicOutput: Record<string, unknown> = sourceOnly ? { ...output } : { ...output, nextPageId: null };
    for (const continuation of result.pagination.continuations) {
      const target = continuation.operation;
      if (target !== operation && !(operation === "read_resource" && target === "read_resource_previous")
        && !(["search_resource", "summarize_resource"].includes(operation) && target === "read_resource")) throw new Error("page_continuation_operation_mismatch");
      const pageId = await host.receipts.issuePage({
        ...identity(context), operation: target, prefix: host.prefix,
        slot: continuation.citationIndex !== undefined ? `citation:${continuation.citationIndex}`
          : continuation.passageIndex === undefined ? continuation.slot : `passage:${continuation.passageIndex}`,
        inputJson: JSON.stringify(result.executionAccount ? {
          __rallyPage: { input: continuation.input, executionAccount: result.executionAccount },
        } : continuation.input),
      });
      if (pageId === null) {
        publicOutput.paginationWarning = "The provider repeated a continuation. This page was returned, but pagination stopped to avoid repeating pages. Do not claim the full result set was read.";
      }
      if (continuation.slot === "readPageId") {
        const field = continuation.citationIndex === undefined ? "passages" : "citations";
        const passages = z.array(z.record(z.string(), z.unknown())).parse(publicOutput[field]);
        const passage = passages[continuation.citationIndex ?? continuation.passageIndex ?? -1];
        if (!passage) throw new Error("page_continuation_passage_missing");
        passage.readPageId = pageId;
        publicOutput[field] = passages;
      } else publicOutput[continuation.slot] = pageId;
    }
    const publicResult = { ...result };
    delete publicResult.pagination;
    return { ...publicResult, output: publicOutput };
  }
  const first: HarnessTool = {
    ...tool,
    definition: { ...tool.definition, inputSchema: firstSchema,
      description: pagination.sourceOnly ? tool.definition.description : `${tool.definition.description} Starts a new read. For another page, call ${stableWireToolName(wirePrefix, `${operation}_next`)} with the returned nextPageId.`,
    },
    validateInput: (input) => firstKeys.safeParse(input).error
      ?? validateToolArguments(input, firstSchema) ?? tool.validateInput?.(input) ?? null,
    execute: async (input, context) => {
      firstKeys.parse(input);
      const invalid = validateToolArguments(input, firstSchema);
      if (invalid) throw invalid;
      return execute(input, context);
    },
  };
  if (nextName === undefined) return [first];
  const resume = (inputJson: string, context: HarnessToolContext) => {
    const saved = JSON.parse(inputJson) as Record<string, unknown>;
    if (!saved.__rallyPage) return execute(saved, context);
    const page = z.object({ input: z.unknown(), executionAccount: ToolExecutionAccountSchema }).parse(saved.__rallyPage);
    return execute(page.input, { ...context, executionAccount: page.executionAccount });
  };
  const nextInput = pageInput(host.prefix, wirePrefix, operation);
  const next: HarnessTool = {
    definition: { ...tool.definition, name: nextName,
      description: `Read the next page of ${stableWireToolName(wirePrefix, operation)}. Copy nextPageId from its result. A null nextPageId means there are no more pages. Each page ID can be consumed once.`,
      inputSchema: z.toJSONSchema(nextInput.schema),
    },
    validateInput: nextInput.validateInput,
    execute: async (raw, context) => {
      const { pageId } = nextInput.parse(raw);
      const saved = await claim(pageId, context);
      return resume(saved.inputJson, context);
    },
  };
  if (previousName === undefined) return [first, next];
  const previousInput = pageInput(host.prefix, wirePrefix, operation, true);
  return [first, next, {
    ...next,
    validateInput: previousInput.validateInput,
    definition: { ...next.definition, name: previousName,
      inputSchema: z.toJSONSchema(previousInput.schema),
      description: "Read the preceding resource page using its previousPageId. Each page ID can be consumed once.",
    },
    execute: async (raw, context) => {
      const { pageId } = previousInput.parse(raw);
      const saved = await claim(pageId, context, "read_resource_previous");
      return resume(saved.inputJson, context);
    },
  }];
}
