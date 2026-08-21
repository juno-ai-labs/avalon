/**
 * The stable request hash shared by the runtime SQL port and work-stream
 * creation receipts.
 *
 * Extracted from the retired maintenance-import machinery: the campaign that
 * introduced it is gone, but every create receipt already stored under this
 * FNV-1a-over-stable-JSON encoding, so the encoding is now a compatibility
 * contract. Changing it would break idempotency for previously issued
 * receipts.
 *
 * **The encoding is frozen; what is fed to it is not.** Adding a field to the
 * hashed value re-hashes every request, so a receipt reserved by the previous
 * Worker no longer matches its own retry and answers
 * `workstream_create_idempotency_conflict` for the length of a deploy. That is
 * a real cost and is only worth paying for a field that changes what the create
 * *means* — the work stream's audience is one, because a retry that resolved a
 * different audience is a different request and replaying it silently returns
 * the wrong one. Convenience fields stay out.
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
