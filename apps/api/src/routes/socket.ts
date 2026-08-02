import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { IdSchema } from "@avalon/contracts";
import { z } from "zod";
import type { HonoAppEnv } from "../env";
import { SocketService } from "../services/socket-service";

const params = z.object({ id: IdSchema });
const query = z.object({ ticket: z.string().min(20).max(4_000) });

export const socketRoutes = new Hono<HonoAppEnv>();
socketRoutes.get("/workstreams/:id", zValidator("param", params), zValidator("query", query), async (c) =>
  new SocketService(c.env).upgrade(c.req.valid("param").id, c.req.valid("query").ticket, c.req.raw),
);
