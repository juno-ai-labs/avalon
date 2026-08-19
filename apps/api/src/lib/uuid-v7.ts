/**
 * Generate an RFC 9562 UUIDv7 using the runtime's cryptographic randomness.
 *
 * UUID string order follows the 48-bit Unix-millisecond prefix. Independent
 * writers in the same millisecond remain randomly ordered; callers that need
 * causal freshness must retain their own authority-local sequence/waterline.
 */
export function uuidV7(now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffff_ffff_ffff) {
    throw new RangeError("UUIDv7 timestamp must fit in 48 unsigned bits");
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = BigInt(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
