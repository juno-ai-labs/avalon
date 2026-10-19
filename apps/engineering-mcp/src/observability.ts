import { z } from "zod";

import { CloudflareQueryError, cloudflareResult } from "./cloudflare-api";

const operations = [
  "eq", "neq", "gt", "gte", "lt", "lte", "in", "not_in",
  "includes", "not_includes", "starts_with", "ends_with", "regex", "exists", "is_null",
] as const;
const valueTypes = ["string", "number", "boolean"] as const;
const calculationOperators = [
  "count", "uniq", "sum", "avg", "min", "max", "median", "stddev", "variance",
  "p001", "p01", "p05", "p10", "p25", "p75", "p90", "p95", "p99", "p999",
] as const;

const filterSchema = z.object({
  key: z.string().min(1).describe(
    "A field: one Rally logs (event, level, code, request_id, workspace_id, …) or a platform one ($metadata.service, $metadata.traceId, $metadata.requestId, $metadata.error, $workers.outcome, …).",
  ),
  operation: z.enum(operations),
  type: z.enum(valueTypes).describe("The type of the field's value."),
  value: z.union([z.string(), z.number(), z.boolean()]).optional().describe(
    "Omitted for exists and is_null. String matching is case-sensitive; regex is RE2.",
  ),
});

/**
 * One level of grouping is what every saved view uses; Cloudflare allows four,
 * but a recursive schema reaches some MCP clients as an unresolved `$ref`.
 */
const filterGroupSchema = z.object({
  kind: z.literal("group"),
  filterCombination: z.enum(["and", "or"]),
  filters: filterSchema.array().min(1),
});

/** The tool's input, in Cloudflare's own names wherever it has one. */
export const observabilityQueryInputSchema = {
  view: z.enum(["events", "traces", "invocations", "calculations"]).describe(
    "events: one row per log line or span. traces: one row per trace. invocations: events grouped by request. calculations: aggregates over events, with groupBys.",
  ),
  from: z.iso.datetime({ offset: true }).describe("Start of the window. Workers Logs keep seven days."),
  to: z.iso.datetime({ offset: true }).optional().describe("End of the window; now when omitted."),
  filters: z.union([filterSchema, filterGroupSchema]).array().optional(),
  filterCombination: z.enum(["and", "or"]).optional().describe("How top-level filters combine; and when omitted."),
  needle: z.string().min(1).optional().describe("Full-text search across every field, case-insensitive."),
  calculations: z.object({
    operator: z.enum(calculationOperators).describe("median is the 50th percentile; Cloudflare has no p50."),
    key: z.string().min(1).optional().describe("The field to aggregate; omitted for count."),
    keyType: z.enum(valueTypes).optional(),
    alias: z.string().min(1).optional(),
  }).array().optional().describe("For the calculations view."),
  groupBys: z.object({ type: z.enum(valueTypes), value: z.string().min(1) }).array().optional(),
  orderBy: z.object({ value: z.string().min(1), order: z.enum(["asc", "desc"]) }).optional().describe(
    "Orders grouped results by a calculation alias.",
  ),
  limit: z.number().int().positive().optional().describe("Rows to return; Cloudflare allows up to 2000."),
  offset: z.string().min(1).optional().describe("The cursor a previous page returned, for the next page."),
};

type ObservabilityQuery = z.infer<z.ZodObject<typeof observabilityQueryInputSchema>>;

/**
 * Runs one query against the account's Workers Observability store: the same
 * logs and traces the dashboard's Query Builder reads, for every Worker on the
 * account. `dry` keeps the run out of the account's query history. The returned
 * `result` is Cloudflare's own; which of `events`, `traces`, `invocations` and
 * `calculations` it carries follows the view.
 */
export async function queryObservability(
  { accountId, token }: { accountId: string; token: string | undefined },
  { view, from, to, limit, offset, needle, ...parameters }: ObservabilityQuery,
): Promise<unknown> {
  if (!token) {
    throw new CloudflareQueryError(
      "observability_token_unconfigured",
      "The engineering MCP has no WORKERS_OBSERVABILITY_API_TOKEN secret; log and trace queries are unavailable",
    );
  }
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/observability/telemetry/query`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        queryId: "rally-engineering-mcp",
        view,
        dry: true,
        timeframe: { from: Date.parse(from), to: to === undefined ? Date.now() : Date.parse(to) },
        ...(limit === undefined ? {} : { limit }),
        ...(offset === undefined ? {} : { offset }),
        parameters: {
          ...parameters,
          ...(needle === undefined ? {} : { needle: { value: needle } }),
          ...(limit === undefined ? {} : { limit }),
        },
      }),
    },
  );
  return cloudflareResult(response, "observability_query_failed");
}
