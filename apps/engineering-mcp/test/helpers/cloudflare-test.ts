import type { Pipeline } from "cloudflare:pipelines";

/**
 * The audit Pipeline for the Node transport tests. It accepts and discards
 * every row; the rows themselves are asserted in
 * apps/api/test-workers/engineering-mcp-audit.test.ts.
 */
export function createDiscardingAuditLakehouse(): Pipeline {
  return { send: async () => undefined };
}
