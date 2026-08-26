import { z } from "zod";

import { sha256Hex } from "./crypto";

/**
 * Cloudflare's user-supplied Workflow instance-ID contract.
 *
 * Keep this validation at the platform boundary. Callers must not cast or
 * concatenate provider identifiers into a Workflow ID themselves; use
 * `cloudflareWorkflowInstanceId` so arbitrary identity bytes affect only the
 * digest, never the external identifier's alphabet or length.
 */
const CloudflareWorkflowInstanceIdSchema = z.string()
  .max(100)
  .regex(/^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/u)
  .brand<"CloudflareWorkflowInstanceId">();

export type CloudflareWorkflowInstanceId = z.infer<typeof CloudflareWorkflowInstanceIdSchema>;

type WorkflowIdentityPart = string | number;

/**
 * Derive a deterministic, user-supplied Cloudflare Workflow instance ID.
 *
 * `wf_` is fixed and the SHA-256 hex digest is always 64 lowercase hexadecimal
 * characters, so every returned value is 67 characters from Cloudflare's
 * accepted alphabet regardless of the identity parts supplied by a provider.
 * JSON array encoding keeps part boundaries and string/number types distinct.
 */
export async function cloudflareWorkflowInstanceId(
  ...identity: readonly WorkflowIdentityPart[]
): Promise<CloudflareWorkflowInstanceId> {
  const digest = await sha256Hex(JSON.stringify(identity));
  return CloudflareWorkflowInstanceIdSchema.parse(`wf_${digest}`);
}
