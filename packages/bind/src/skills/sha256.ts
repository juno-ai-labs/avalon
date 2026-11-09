/**
 * SHA-256 over a UTF-8 string, in plain TypeScript.
 *
 * **Why the package carries an implementation instead of taking a port**, when
 * `run/receipts.ts` deliberately does the opposite. Two differences decide it.
 *
 * The first is *when* the digest is needed. A receipt's hash is taken inside an
 * already-async tool dispatch, so `crypto.subtle.digest` — which is async
 * everywhere, and is the only digest workerd has — fits without changing any
 * signature. A skill's `contentSha` is computed at **registration**, which is
 * the synchronous act of a module declaring what it contributes. Taking an
 * async digest there forces either an async `register()` (so a plugin's
 * registration becomes something a host must await and order) or a lazily
 * resolved hash on every read path that wants one. Both cost more than this
 * file.
 *
 * The second is *what the value means*. A receipt hash is persisted by the host
 * forever and compared against rows written by earlier versions, so the host
 * must own the algorithm choice — and its input is tool arguments, routinely
 * user data, which is why that doc argues preimage resistance. A `contentSha`
 * identifies build content within one deployment: it is derived from source the
 * deployment already ships, and nothing reads it that did not just compute it.
 *
 * A host with a native digest can still supply one — {@link Sha256Hex} is a
 * parameter everywhere this is used — but it must be synchronous and it must be
 * SHA-256, or the hashes two hosts compute for the same skill diverge.
 *
 * The implementation is the FIPS 180-4 reference algorithm with no shortcuts.
 * `__tests__/sha256.test.ts` pins it against the published vectors, plus a
 * multi-block and a multi-byte-UTF-8 case, because a hash that is subtly wrong
 * fails silently: every value still looks like a hash.
 */

/** A synchronous SHA-256 that returns lowercase hex. */
export type Sha256Hex = (text: string) => string;

/** Round constants: the first 32 bits of the fractional parts of the cube roots of the first 64 primes. */
// prettier-ignore
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

const encoder = new TextEncoder();

/** SHA-256 (lowercase hex) of a UTF-8 string. */
export const sha256Hex: Sha256Hex = (text: string): string => {
  const data = encoder.encode(text);

  // Pad to a whole number of 512-bit blocks: the 0x80 terminator, zeroes, then
  // the message length in bits as a 64-bit big-endian integer.
  const total = (((data.length + 9 + 63) / 64) | 0) * 64;
  const buf = new Uint8Array(total);
  buf.set(data);
  buf[data.length] = 0x80;

  const view = new DataView(buf.buffer);
  // The bit length can exceed 32 bits for inputs over 512 MiB. Split it rather
  // than relying on a single `setUint32`, which would silently truncate.
  const bitLength = data.length * 8;
  view.setUint32(total - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(total - 4, bitLength >>> 0);

  // Initial hash values: the first 32 bits of the fractional parts of the
  // square roots of the first eight primes.
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  // The schedule and round constants have 64 words, and the hash has eight.
  // Every indexed read below is within those fixed bounds.
  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15]!;
      const y = w[i - 2]!;
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = w[i - 16]! + s0 + w[i - 7]! + s1;
    }

    let a = h[0]!;
    let b = h[1]!;
    let c = h[2]!;
    let d = h[3]!;
    let e = h[4]!;
    let f = h[5]!;
    let g = h[6]!;
    let hh = h[7]!;

    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + K[i]! + w[i]!) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }

    h[0]! += a;
    h[1]! += b;
    h[2]! += c;
    h[3]! += d;
    h[4]! += e;
    h[5]! += f;
    h[6]! += g;
    h[7]! += hh;
  }

  let hex = "";
  for (let i = 0; i < 8; i += 1) hex += h[i]!.toString(16).padStart(8, "0");
  return hex;
};

/** Byte length of a string in UTF-8 — what a resource listing reports. */
export function utf8ByteLength(text: string): number {
  return encoder.encode(text).length;
}
