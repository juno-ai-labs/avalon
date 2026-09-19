const encoder = new TextEncoder();
const decoder = new TextDecoder();

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function randomToken(byteLength = 32): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", asArrayBuffer(bytes))));
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", asArrayBuffer(bytes)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function importAesKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error("An encryption key is not configured");
  let keyBytes: Uint8Array;
  try {
    keyBytes = base64UrlToBytes(secret);
  } catch {
    keyBytes = encoder.encode(secret);
  }
  if (keyBytes.byteLength !== 32) {
    keyBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(secret)));
  }
  return crypto.subtle.importKey("raw", asArrayBuffer(keyBytes), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptString(
  plaintext: string,
  secret: string,
  additionalData?: string,
): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importAesKey(secret);
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: asArrayBuffer(iv),
      ...(additionalData ? { additionalData: asArrayBuffer(encoder.encode(additionalData)) } : {}),
    },
    key,
    asArrayBuffer(encoder.encode(plaintext)),
  );
  return {
    ciphertext: bytesToBase64Url(new Uint8Array(encrypted)),
    iv: bytesToBase64Url(iv),
  };
}

export async function decryptString(
  ciphertext: string,
  iv: string,
  secret: string,
  additionalData?: string,
): Promise<string> {
  const key = await importAesKey(secret);
  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: asArrayBuffer(base64UrlToBytes(iv)),
      ...(additionalData ? { additionalData: asArrayBuffer(encoder.encode(additionalData)) } : {}),
    },
    key,
    asArrayBuffer(base64UrlToBytes(ciphertext)),
  );
  return decoder.decode(decrypted);
}

export async function sealString(plaintext: string, secret: string): Promise<string> {
  const encrypted = await encryptString(plaintext, secret);
  return `${encrypted.iv}.${encrypted.ciphertext}`;
}

export async function openString(sealed: string, secret: string): Promise<string> {
  const separator = sealed.indexOf(".");
  if (separator < 1) throw new Error("Invalid encrypted value");
  return decryptString(sealed.slice(separator + 1), sealed.slice(0, separator), secret);
}

export function timingSafeEqualText(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return mismatch === 0;
}

export async function hmacSha256(secret: string, value: string | Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    asArrayBuffer(encoder.encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    asArrayBuffer(typeof value === "string" ? encoder.encode(value) : value),
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

/**
 * One opaque string standing in for a structured value in a link someone
 * receives — the whole of what the recipient sees, in place of the fields it
 * carries.
 *
 * `purpose` is authenticated alongside the payload, so a credential minted for
 * one kind of link cannot be presented as another, and the key makes the string
 * readable only to the deployment that issued it.
 */
export async function sealPayload(value: unknown, secret: string, purpose: string): Promise<string> {
  const encrypted = await encryptString(JSON.stringify(value), secret, purpose);
  return `${encrypted.iv}.${encrypted.ciphertext}`;
}

/**
 * Null is the single answer to every way a sealed payload can fail to open — a
 * key that did not mint it, an edited character, the wrong purpose. Telling
 * those apart would tell a holder something about a credential they do not
 * have; the caller owes its own reader one unavailable link either way.
 */
export async function openPayload(sealed: string, secret: string, purpose: string): Promise<unknown> {
  const separator = sealed.indexOf(".");
  if (separator < 1) return null;
  try {
    return JSON.parse(await decryptString(sealed.slice(separator + 1), sealed.slice(0, separator), secret, purpose));
  } catch {
    return null;
  }
}
