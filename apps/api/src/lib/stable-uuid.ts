import { sha256Hex } from './crypto';

/** Deterministic UUID for a namespaced idempotent operation, not a content hash. */
export async function stableUuid(parts: readonly unknown[]): Promise<string> {
  const hash = await sha256Hex(new TextEncoder().encode(JSON.stringify(parts)));
  return asUuid(hash);
}

const FNV1A_128_OFFSET = 0x6c62272e07bb014262b821756295c58dn;
const FNV1A_128_PRIME = 0x0000000001000000000000000000013bn;

/**
 * {@link stableUuid} for a caller inside a synchronous storage transaction,
 * where the Web Crypto digest cannot be awaited: FNV-1a 128 over the same
 * encoding. For ids a server derives from ids it already owns, never for
 * anything a caller chooses to collide.
 */
export function stableUuidSync(parts: readonly unknown[]): string {
  let hash = FNV1A_128_OFFSET;
  for (const byte of new TextEncoder().encode(JSON.stringify(parts))) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(128, hash * FNV1A_128_PRIME);
  }
  return asUuid(hash.toString(16).padStart(32, "0"));
}

function asUuid(hex: string): string {
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-8${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
