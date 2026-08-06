import { Hono } from "hono";
import { zValidator } from "../middleware/validation";
import { IdSchema } from "@avalon/contracts";
import { z } from "zod";
import type { HonoAppEnv } from "../env";
import { SocketService } from "../services/socket-service";
import { RealtimeTranscriptionService } from "../services/realtime-transcription-service";

const params = z.object({ id: IdSchema });
const query = z.object({ ticket: z.string().min(20).max(4_000) });

export const socketRoutes = new Hono<HonoAppEnv>();
socketRoutes.get("/workstreams/:id", zValidator("param", params), zValidator("query", query), async (c) =>
  new SocketService(c.env).upgrade(c.req.valid("param").id, c.req.valid("query").ticket, c.req.raw),
);
socketRoutes.get("/transcription", zValidator("query", query), async (c) => {
  const defer = (promise: Promise<void>): void => {
    try {
      c.executionCtx.waitUntil(promise);
    } catch {
      // Node-based route tests do not provide a Workers ExecutionContext.
      // The promise is already guarded by the service and may finish normally.
      void promise;
    }
  };
  return new RealtimeTranscriptionService(c.env, defer)
    .upgrade(c.req.valid("query").ticket, c.req.raw);
});
