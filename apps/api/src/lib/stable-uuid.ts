import { sha256Hex } from './crypto';

/** Deterministic UUID for a namespaced idempotent operation, not a content hash. */
export async function stableUuid(parts: readonly unknown[]): Promise<string> {
  const hash = await sha256Hex(new TextEncoder().encode(JSON.stringify(parts)));
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-8${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
}
