import analyticsEvents from "../../../config/analytics-events-lakehouse.json";
import inference from "../../../config/inference-lakehouse.json";
import usage from "../../../config/usage-lakehouse.json";
import { CloudflareQueryError, cloudflareResult } from "./cloudflare-api";

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
  const target = LAKEHOUSES[lakehouse]!;
  if (!token) {
    throw new CloudflareQueryError(
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
  return cloudflareResult(response, "lakehouse_query_failed");
}
