import { z } from "zod";

import { hmacSha256, timingSafeEqualText } from "./crypto";

const MAXIMUM_CURSOR_LENGTH = 2_048;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const AttachmentCursorPayloadSchema = z.strictObject({
  version: z.literal(1),
  purpose: z.string().min(1).max(64),
  expiresAt: z.number().int().nonnegative(),
  principal: z.string().min(1).max(200),
  scopeId: z.string().min(1).max(200),
  state: z.record(z.string(), z.unknown()),
});

export type AttachmentCursorInput = Omit<z.infer<typeof AttachmentCursorPayloadSchema>, "version">;
export type AttachmentCursorPayload = z.infer<typeof AttachmentCursorPayloadSchema>;

export class AttachmentCursorError extends Error {
  constructor(readonly code: "invalid_cursor" | "cursor_expired", message: string) {
    super(message);
    this.name = "AttachmentCursorError";
  }
}

function base64UrlEncode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Invalid base64url");
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/**
 * The domain separator this build mints with, and the one it still verifies.
 *
 * A cursor is valid for an hour and is held by an agent run between paginated
 * tool calls, so a deploy lands mid-run: the run seals a cursor under the old
 * separator and presents it to a Worker that has already moved. Verifying
 * against both spellings keeps that run going. Remove the superseded entry once
 * an hour has passed since the deploy that introduced it — nothing older can
 * still be presented.
 */
const CURSOR_DOMAIN_SEPARATOR = "rally:attachment-cursor:v1";
const SUPERSEDED_CURSOR_DOMAIN_SEPARATORS: readonly string[] = Object.freeze([
  "avalon:attachment-cursor:v1",
]);

async function purposeSeparatedSecret(secret: string, separator: string): Promise<string> {
  if (!secret) throw new Error("Attachment cursor signing key is not configured");
  return hmacSha256(secret, separator);
}

export async function sealAttachmentCursor(
  secret: string,
  input: AttachmentCursorInput,
): Promise<string> {
  const payload = AttachmentCursorPayloadSchema.parse({ version: 1, ...input });
  const encoded = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await hmacSha256(await purposeSeparatedSecret(secret, CURSOR_DOMAIN_SEPARATOR), encoded);
  const cursor = `${encoded}.${signature}`;
  if (cursor.length > MAXIMUM_CURSOR_LENGTH) {
    throw new AttachmentCursorError("invalid_cursor", "Attachment cursor is too large");
  }
  return cursor;
}

export async function openAttachmentCursor(
  secret: string,
  cursor: string,
  expected: {
    purpose: string;
    principal: string;
    scopeId: string;
    now?: number;
  },
): Promise<AttachmentCursorPayload> {
  try {
    if (!cursor || cursor.length > MAXIMUM_CURSOR_LENGTH) throw new Error("Invalid cursor length");
    const parts = cursor.split(".");
    if (parts.length !== 2) throw new Error("Invalid cursor shape");
    const [encoded, receivedSignature] = parts as [string, string];
    // Every separator is tried rather than short-circuiting on the first
    // match, so verification cost does not depend on which spelling signed the
    // cursor; `timingSafeEqualText` guards the comparison itself.
    let signatureMatched = false;
    for (const separator of [CURSOR_DOMAIN_SEPARATOR, ...SUPERSEDED_CURSOR_DOMAIN_SEPARATORS]) {
      const expectedSignature = await hmacSha256(await purposeSeparatedSecret(secret, separator), encoded);
      if (timingSafeEqualText(receivedSignature, expectedSignature)) signatureMatched = true;
    }
    if (!signatureMatched) throw new Error("Invalid signature");
    const payload = AttachmentCursorPayloadSchema.parse(JSON.parse(decoder.decode(base64UrlDecode(encoded))));
    if (payload.purpose !== expected.purpose
      || payload.principal !== expected.principal
      || payload.scopeId !== expected.scopeId) {
      throw new Error("Cursor scope does not match");
    }
    if (payload.expiresAt < (expected.now ?? Date.now())) {
      throw new AttachmentCursorError("cursor_expired", "Attachment cursor expired");
    }
    return payload;
  } catch (error) {
    if (error instanceof AttachmentCursorError) throw error;
    throw new AttachmentCursorError("invalid_cursor", "Attachment cursor is invalid");
  }
}
