import { Hono } from "hono";
import type { HonoAppEnv } from "../env";
import { getAuth } from "../middleware/auth";
import { RealtimeTranscriptionService } from "../services/realtime-transcription-service";

export const realtimeRoutes = new Hono<HonoAppEnv>();

realtimeRoutes.get("/transcription/socket", async (c) =>
  c.json(await new RealtimeTranscriptionService(c.env).ticket(getAuth(c))),
);
