/** Bitcoin's unambiguous Base58 alphabet. */
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX = new Map([...BASE58_ALPHABET].map((character, index) => [character, index]));
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Encode the 128 bits of a UUID without punctuation for public URL segments. */
export function uuidToBase58(uuid: string): string {
  if (!UUID_PATTERN.test(uuid)) throw new Error("Base58 URL ids require a UUID");
  const bytes = uuid.replaceAll("-", "").toLowerCase();
  let value = BigInt(`0x${bytes}`);
  let encoded = "";
  while (value > 0n) {
    encoded = BASE58_ALPHABET[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  const leadingZeroBytes = /^(?:00)*/u.exec(bytes)?.[0].length ?? 0;
  return "1".repeat(leadingZeroBytes / 2) + encoded;
}

/** Decode one canonical Base58 UUID segment back to its internal UUID form. */
export function uuidFromBase58(encoded: string): string | null {
  if (!encoded) return null;
  let value = 0n;
  for (const character of encoded) {
    const digit = BASE58_INDEX.get(character);
    if (digit === undefined) return null;
    value = value * 58n + BigInt(digit);
  }
  let hexadecimal = value.toString(16);
  if (hexadecimal.length % 2) hexadecimal = `0${hexadecimal}`;
  const leadingZeroBytes = /^1*/u.exec(encoded)?.[0].length ?? 0;
  hexadecimal = `${"00".repeat(leadingZeroBytes)}${value === 0n ? "" : hexadecimal}`;
  if (hexadecimal.length !== 32) return null;
  const uuid = `${hexadecimal.slice(0, 8)}-${hexadecimal.slice(8, 12)}-${hexadecimal.slice(12, 16)}-${hexadecimal.slice(16, 20)}-${hexadecimal.slice(20)}`;
  return uuidToBase58(uuid) === encoded ? uuid : null;
}
