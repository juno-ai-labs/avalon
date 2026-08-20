/**
 * The stable request hash shared by the runtime SQL port and work-stream
 * creation receipts.
 *
 * Extracted from the retired maintenance-import machinery: the campaign that
 * introduced it is gone, but every create receipt already stored under this
 * FNV-1a-over-stable-JSON encoding, so the encoding is now a compatibility
 * contract. Changing it would break idempotency for previously issued
 * receipts.
 */

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

export function workstreamImportHash(value: unknown): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(stableJson(value))) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}
