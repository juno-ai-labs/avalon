import { z } from "zod";
import { validateToolArguments } from "@rally/agent-harness";
import type { HarnessTool, HarnessToolContext, HarnessToolResult } from "@rally/agent-harness";
import type { ToolReceiptObjectPort } from "../durable-objects/workstream-tool-receipt-protocol";
import type { ToolReceiptFence } from "../durable-objects/workstream-tool-receipt-storage";

function pageInput(prefix: string, operation: string, previous = false) {
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const schema = z.strictObject({ pageId: z.string()
    .regex(new RegExp(`^${escapedPrefix}_[a-z]+_[a-z]+_[a-z]+_[a-z]+$`, "u"))
    .describe("Copy the page ID returned by this plugin. Send it alone; filters and page size are retained automatically.") });
  const field = previous ? "previousPageId" : operation === "read_resource" ? "nextPageId or readPageId" : "nextPageId";
  const message = `Send only {"pageId":"<copied ID>"}. pageId must start with "${prefix}_", followed by exactly four lowercase words separated by underscores. Copy ${field} exactly from a tool result; do not invent or repair an ID. If that field is null, stop: there is no page. If you have no ID, call ${operation} to start a new read.`;
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
  prefix: string;
  connectionId: string | null;
}

/** Expand only an explicitly authored tool. Private continuations never escape this wrapper. */
export function withToolPagination(tool: HarnessTool, host: PaginationHost): HarnessTool[] {
  const pagination = tool.definition.pagination;
  if (!pagination) return [tool];
  const sourceOnly = pagination.sourceOnly === true;
  const operation = tool.definition.name;
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
  async function claim(pageId: string, context: HarnessToolContext, target = operation) {
    try {
      return await host.receipts.claimPage({ ...identity(context), operation: target, pageId });
    } catch (error) {
      // Keep the attachment grounding guard's existing, bounded recovery
      // semantics when a model damages a page ID before resource resolution.
      if (operation === "read_resource" && error instanceof Error && error.message.startsWith("page_id_invalid:")) {
        throw Object.assign(new Error(error.message), { code: "invalid_cursor" });
      }
      throw error;
    }
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
        inputJson: JSON.stringify(continuation.input),
      });
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
      description: pagination.sourceOnly ? tool.definition.description : `${tool.definition.description} Starts a new read. For another page, call ${operation}_next with the returned nextPageId.`,
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
  if (pagination.sourceOnly) return [first];
  const nextInput = pageInput(host.prefix, operation);
  const next: HarnessTool = {
    definition: { ...tool.definition, name: `${operation}_next`,
      description: `Read the next page of ${operation}. Copy nextPageId from its result. A null nextPageId means there are no more pages. Each page ID can be consumed once.`,
      inputSchema: z.toJSONSchema(nextInput.schema),
    },
    validateInput: nextInput.validateInput,
    execute: async (raw, context) => {
      const { pageId } = nextInput.parse(raw);
      const saved = await claim(pageId, context);
      return execute(JSON.parse(saved.inputJson), context);
    },
  };
  if (operation !== "read_resource") return [first, next];
  const previousInput = pageInput(host.prefix, operation, true);
  return [first, next, {
    ...next,
    validateInput: previousInput.validateInput,
    definition: { ...next.definition, name: "read_resource_previous",
      description: "Read the preceding resource page using its previousPageId. Each page ID can be consumed once.",
    },
    execute: async (raw, context) => {
      const { pageId } = previousInput.parse(raw);
      const saved = await claim(pageId, context, "read_resource_previous");
      return execute(JSON.parse(saved.inputJson), context);
    },
  }];
}
