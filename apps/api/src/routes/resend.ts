import { Hono } from "hono";
import { z } from "zod/v3";
import type { HonoAppEnv } from "../env";
import { numericEnv } from "../env";
import { ApiError } from "../lib/api-error";
import { ResendInboundEmailRoutingService } from "../services/resend-inbound-email-service";

const DEFAULT_MAX_WEBHOOK_BYTES = 2_000_000;

/** What Resend is told about an inbound message; the route owns this shape. */
const ResendInboundResponseSchema = z.object({
  accepted: z.literal(true),
  duplicate: z.boolean(),
  ignored: z.boolean(),
  routedCount: z.number().int().safe().nonnegative(),
});

export const resendInboundRoutes = new Hono<HonoAppEnv>();

resendInboundRoutes.post("/", async (c) => {
  const maxBytes = numericEnv(c.env, "PROVIDER_WEBHOOK_MAX_BYTES", DEFAULT_MAX_WEBHOOK_BYTES);
  const result = await new ResendInboundEmailRoutingService(c.env).ingest(
    await readBoundedRequestBytes(c.req.raw, maxBytes),
    c.req.raw.headers,
  );
  // Resend treats any 2xx as accepted. A consistent 200 also avoids provider
  // ambiguity about whether Avalon still has asynchronous work outstanding.
  return c.json(ResendInboundResponseSchema.parse(result), 200);
});

async function readBoundedRequestBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && /^\d+$/u.test(declaredLength) && Number(declaredLength) > maxBytes) {
    throw new ApiError(413, "webhook_too_large", "The Resend webhook is too large");
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
        throw new ApiError(413, "webhook_too_large", "The Resend webhook is too large");
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

export const __resendRouteTesting = { readBoundedRequestBytes };
