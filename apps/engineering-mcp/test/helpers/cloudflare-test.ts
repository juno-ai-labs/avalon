/**
 * The audit bucket for the Node transport tests, where R2 cannot run. It
 * accepts and discards every write; the records themselves are proved on real
 * R2 in apps/api/test-workers/engineering-mcp-audit.test.ts.
 */
export function createDiscardingAuditLog(): R2Bucket {
  return { put: async () => null } as unknown as R2Bucket;
}
