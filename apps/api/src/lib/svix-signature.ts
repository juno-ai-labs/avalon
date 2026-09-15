import { ApiError } from "./api-error";

export interface VerifySvixInput {
  unavailableCode?: string;
  secret: string;
  rawBody: string;
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  now: number;
  replayWindowSeconds: number;
}

export async function verifySvixSignature(input: VerifySvixInput): Promise<void> {
  if (!input.id || input.id.length > 200 || !input.timestamp || !input.signature) {
    throw new ApiError(401, "invalid_signature", "The webhook signature is invalid");
  }
  if (!/^\d{1,16}$/u.test(input.timestamp)) {
    throw new ApiError(401, "invalid_signature", "The webhook signature is invalid");
  }
  const timestamp = Number(input.timestamp);
  if (!Number.isSafeInteger(timestamp)) {
    throw new ApiError(401, "invalid_signature", "The webhook signature is invalid");
  }
  const nowSeconds = Math.floor(input.now / 1_000);
  if (Math.abs(nowSeconds - timestamp) > input.replayWindowSeconds) {
    throw new ApiError(401, "invalid_signature", "The webhook is outside the replay window");
  }

  let secret: Uint8Array;
  try {
    const encoded = input.secret.startsWith("whsec_") ? input.secret.slice(6) : input.secret;
    secret = decodeBase64(encoded);
    if (secret.byteLength < 16) throw new Error("weak webhook key");
  } catch {
    throw new ApiError(503, input.unavailableCode ?? "webhook_unavailable", "Webhook verification is not configured");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    exactArrayBuffer(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${input.id}.${input.timestamp}.${input.rawBody}`),
  ));
  const supplied = input.signature.split(/\s+/u).some((candidate) => {
    const separator = candidate.indexOf(",");
    if (separator < 1 || candidate.slice(0, separator) !== "v1") return false;
    try {
      return timingSafeEqualBytes(expected, decodeBase64(candidate.slice(separator + 1)));
    } catch {
      return false;
    }
  });
  if (!supplied) {
    throw new ApiError(401, "invalid_signature", "The webhook signature is invalid");
  }
}

function exactArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(value.byteLength);
  new Uint8Array(copy).set(value);
  return copy;
}

function timingSafeEqualBytes(left: Uint8Array, right: Uint8Array): boolean {
  const length = Math.max(left.byteLength, right.byteLength);
  let mismatch = left.byteLength ^ right.byteLength;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return mismatch === 0;
}

function decodeBase64(value: string): Uint8Array {
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized)) throw new Error("invalid base64");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

