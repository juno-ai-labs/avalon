import { Hono } from "hono";
import { z } from "zod/v3";
import type { HonoAppEnv } from "../env";
import { getAuth } from "../middleware/auth";
import { RealtimeTranscriptionService } from "../services/realtime-transcription-service";

/** The socket URL and the single-use ticket that authorises it. */
const TranscriptionTicketResponseSchema = z.object({
  url: z.string().min(1),
  ticket: z.string().min(1),
});

export const realtimeRoutes = new Hono<HonoAppEnv>();

realtimeRoutes.get("/transcription/socket", async (c) =>
  c.json(TranscriptionTicketResponseSchema.parse(
    await new RealtimeTranscriptionService(c.env).ticket(getAuth(c)))),
);
