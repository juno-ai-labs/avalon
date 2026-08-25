import { Hono } from "hono";
import { zValidator } from "../middleware/validation";
import { IdSchema } from "@rally/contracts";
import { z } from "zod";
import type { HonoAppEnv } from "../env";
import {
  BlockDashboardBlockSocketService,
  SocketService,
  WorkspaceSocketService,
  WorkstreamControlSocketService,
} from "../services/socket-service";
import { RealtimeTranscriptionService } from "../services/realtime-transcription-service";

const params = z.object({ id: IdSchema });
const substreamParams = params.extend({ substreamId: z.union([z.literal("0"), IdSchema]) });
const workspaceParams = z.object({ workspaceId: IdSchema });
const blockDashboardBlockParams = params.extend({ blockId: IdSchema });
// Optional: a client that presents its ticket through `Sec-WebSocket-Protocol`
// sends no query at all, and the service rejects a request that carries neither.
const query = z.object({ ticket: z.string().min(20).max(4_000).optional() });

export const socketRoutes = new Hono<HonoAppEnv>();
socketRoutes.get("/workstreams/:id/substreams/:substreamId", zValidator("param", substreamParams), zValidator("query", query), async (c) =>
  new SocketService(c.env).upgrade(
    c.req.valid("param").id,
    c.req.valid("param").substreamId,
    c.req.valid("query").ticket,
    c.req.raw,
  ),
);
socketRoutes.get(
  "/workspaces/:workspaceId",
  zValidator("param", workspaceParams),
  zValidator("query", query),
  async (c) => {
    const input = c.req.valid("param");
    return new WorkspaceSocketService(c.env).upgrade(
      input.workspaceId,
      c.req.valid("query").ticket,
      c.req.raw,
    );
  },
);
socketRoutes.get(
  "/workstreams/:id/block-dashboard/blocks/:blockId",
  zValidator("param", blockDashboardBlockParams),
  zValidator("query", query),
  async (c) => {
    const input = c.req.valid("param");
    return new BlockDashboardBlockSocketService(c.env).upgrade(
      input.id,
      input.blockId,
      c.req.valid("query").ticket,
      c.req.raw,
    );
  },
);
socketRoutes.get(
  "/workstreams/:id",
  zValidator("param", params),
  zValidator("query", query),
  async (c) => new WorkstreamControlSocketService(c.env).upgrade(
    c.req.valid("param").id,
    c.req.valid("query").ticket,
    c.req.raw,
  ),
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
