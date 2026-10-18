import analyticsEvents from "../../../config/analytics-events-lakehouse.json";
import inference from "../../../config/inference-lakehouse.json";
import usage from "../../../config/usage-lakehouse.json";

/**
 * Each Global lakehouse is its own Basin Catalog bucket, and a query sees only
 * the tables in the bucket it is sent to. The checked-in manifests are the one
 * source of the bucket, namespace and table names.
 */
export const LAKEHOUSES = Object.fromEntries(
  [inference, analyticsEvents, usage].map((manifest) => [
    manifest.table,
    { bucket: manifest.regions.global.bucket, table: `${manifest.namespace}.${manifest.table}` },
  ]),
) as Record<string, { bucket: string; table: string }>;

export const LAKEHOUSE_TABLES = Object.keys(LAKEHOUSES) as [string, ...string[]];

/** A Basin SQL failure, with the code its log names it by. */
export class LakehouseQueryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "LakehouseQueryError";
  }
}

type BasinSqlResponse = {
  success?: boolean;
  errors?: Array<{ code?: number | string; message?: string }>;
  result?: unknown;
};

/**
 * Runs one read-only statement through Cloudflare's Basin SQL HTTP API (formerly
 * R2 SQL). Basin SQL refuses writes itself, so the statement is passed through
 * as written. The returned `result` is Cloudflare's own: `schema`, `rows`, and
 * `metrics` with the bytes and files scanned.
 */
export async function queryLakehouse(
  { accountId, token }: { accountId: string; token: string | undefined },
  lakehouse: string,
  sql: string,
): Promise<unknown> {
  const target = LAKEHOUSES[lakehouse];
  if (!target) throw new LakehouseQueryError("lakehouse_unknown", `${lakehouse} is not a Rally lakehouse`);
  if (!token) {
    throw new LakehouseQueryError(
      "lakehouse_token_unconfigured",
      "The engineering MCP has no BASIN_SQL_API_TOKEN secret; lakehouse queries are unavailable",
    );
  }
  const response = await fetch(
    `https://api.sql.cloudflarestorage.com/api/v1/accounts/${accountId}/basin-sql/query/${target.bucket}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: sql }),
    },
  );
  const body = await response.json().catch(() => null) as BasinSqlResponse | null;
  if (response.ok && body?.success === true) return body.result;
  const first = body?.errors?.[0];
  const code = first?.code === undefined ? `http_${response.status}` : String(first.code);
  throw new LakehouseQueryError(
    `lakehouse_query_failed:${code}`,
    body?.errors?.length
      ? body.errors.map((error) => `${error.code ?? "error"}: ${error.message ?? ""}`).join("\n")
      : `Basin SQL returned HTTP ${response.status}`,
  );
}
