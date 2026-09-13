import { ApiError } from "./api-error";
import type { Env } from "../env";

/**
 * The regional ceiling on a provider's inbound webhook body, applied before any
 * transport buffer is allocated. One helper rather than one per provider: the
 * setting is regional and every signed ingress admits the same size.
 */
export function providerWebhookMaxBytes(env: Pick<Env, "PROVIDER_WEBHOOK_MAX_BYTES">): number {
  const configured = Number.parseInt(env.PROVIDER_WEBHOOK_MAX_BYTES ?? "", 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 1_000_000;
}

export async function readBoundedRequestBytes(request: Request, maxBytes: number, message = "Webhook payload exceeds the configured limit"): Promise<Uint8Array<ArrayBuffer>> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && /^\d+$/u.test(declaredLength) && Number(declaredLength) > maxBytes) {
    throw new ApiError(413, "webhook_too_large", message);
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ApiError(413, "webhook_too_large", message);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

