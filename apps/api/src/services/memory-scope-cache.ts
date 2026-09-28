import type { MemoryScope } from "./memory-service";

/**
 * Scope rows this isolate has already seen, keyed by (workspace, kind, owner).
 * A row never changes once created: `memory_scopes_are_immutable` refuses an
 * update, the table is typed-RPC-only and nothing deletes from it, and
 * `ensureWorkspaceMemoryScope` answers the stored row for an existing key. So
 * the id is safe to keep for the isolate's life. `writable` is not part of the
 * row — it depends on the caller's role — and is applied per call. A module of
 * its own, with no runtime imports, so the test setup that clears it is cheap.
 */
export const memoryScopeRows = new Map<string, Omit<MemoryScope, "writable">>();

/**
 * Drops every remembered scope. Exists for tests: storage isolation gives each
 * test a fresh object under the same workspace id, so its scopes get new ids
 * under keys this isolate already cached. `apps/api/test/setup.ts` calls it.
 */
export function clearMemoryScopeCache(): void {
  memoryScopeRows.clear();
}
