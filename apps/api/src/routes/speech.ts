import { Hono } from "hono";
import { z } from "zod";

import type { HonoAppEnv } from "../env";
import { zValidator } from "../middleware/validation";
import { logEvent } from "../observability/logger";
import { streamMessageSpeech } from "../services/message-speech-service";

const SpeechBodySchema = z.object({
  markdown: z.string().trim().min(1),
}).strict();

export const speechRoutes = new Hono<HonoAppEnv>();

speechRoutes.post("/", zValidator("json", SpeechBodySchema), async (c) => {
  const startedAt = Date.now();
  const speech = await streamMessageSpeech({
    env: c.env,
    markdown: c.req.valid("json").markdown,
    signal: c.req.raw.signal,
  });
  // Azure's streaming response carries no token usage or price. Playback must
  // still start; record the missing billing evidence instead of denying it.
  logEvent(c, "error", "message_speech_billing_unavailable", {
    model: speech.model,
    reason: "provider_usage_missing",
  });
  logEvent(c, "info", "message_speech_stream_started", {
    model: speech.model,
    chunk_count: speech.chunkCount,
    setup_duration_ms: Date.now() - startedAt,
  });
  return new Response(speech.body, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "audio/pcm;rate=24000;channels=1;bits=16;endian=little",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
