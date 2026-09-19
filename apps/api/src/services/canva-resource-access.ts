import { z } from "zod";
import { parseCanvaDesignReference } from "@rally/connectors";
import type { Env } from "../env";
import { encryptString } from "../lib/crypto";
import { decryptVersionedCredentialValue } from "./connector-credential-envelope";

const Envelope = z.object({
  encrypted_credentials: z.string(), credential_iv: z.string(), credential_key_version: z.number(),
});
function binding(workspaceId: string, connectionId: string, designId: string) {
  return JSON.stringify(["canva-design-access", workspaceId, connectionId, designId]);
}
export async function protectCanvaReference(env: Env, workspaceId: string, connectionId: string, value: string) {
  const reference = parseCanvaDesignReference(value);
  if (!reference.accessUrl) return { ...reference, protectedAccessJson: null };
  const encrypted = await encryptString(reference.accessUrl, env.CONNECTOR_CREDENTIALS_KEY,
    binding(workspaceId, connectionId, reference.designId));
  return { designId: reference.designId, canonicalUrl: reference.canonicalUrl,
    protectedAccessJson: JSON.stringify({ encrypted_credentials: encrypted.ciphertext,
      credential_iv: encrypted.iv, credential_key_version: Number(env.CONNECTOR_CREDENTIALS_KEY_VERSION || 1) }) };
}
export async function readCanvaReference(env: Env, workspaceId: string, connectionId: string, designId: string, envelope: unknown): Promise<string> {
  if (envelope == null) return designId;
  const value = await decryptVersionedCredentialValue(env, Envelope.parse(JSON.parse(z.string().parse(envelope))),
    binding(workspaceId, connectionId, designId));
  if (parseCanvaDesignReference(value).designId !== designId) throw new Error("Canva access material does not match its design");
  return value;
}
