import {
  AppendNoteTranscriptSegmentRequestSchema,
  CreateNoteRequestSchema,
  GenerateNoteNotesRequestSchema,
  IdSchema,
  MeetingNotesResponseSchema,
  NoteCursorSchema,
  NoteDetailSchema,
  NoteSummarySchema,
  NoteTranscriptSegmentSchema,
  UpdateNoteRequestSchema,
} from "@rally/contracts";
import { Hono } from "hono";
import { z } from "zod";
import type { HonoAppEnv } from "../env";
import { getAuth } from "../middleware/auth";
import { zValidator } from "../middleware/validation";
import { NoteService } from "../services/note-service";

const idParam = z.object({ id: IdSchema });
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(250).default(250),
  before: NoteCursorSchema.optional(),
});
const NotePageSchema = z.object({
  items: z.array(NoteSummarySchema),
  nextCursor: NoteCursorSchema.nullable(),
});

export const noteRoutes = new Hono<HonoAppEnv>();

noteRoutes.get("/", zValidator("query", listQuery), async (c) => {
  const query = c.req.valid("query");
  return c.json(NotePageSchema.parse(
    await new NoteService(c.env, getAuth(c)).list(query.limit, query.before),
  ));
});
noteRoutes.post("/", zValidator("json", CreateNoteRequestSchema), async (c) =>
  c.json(NoteDetailSchema.parse(await new NoteService(c.env, getAuth(c)).create(c.req.valid("json"))), 201),
);
noteRoutes.get("/:id", zValidator("param", idParam), async (c) =>
  c.json(NoteDetailSchema.parse(await new NoteService(c.env, getAuth(c)).get(c.req.valid("param").id))),
);
noteRoutes.patch("/:id", zValidator("param", idParam), zValidator("json", UpdateNoteRequestSchema), async (c) =>
  c.json(NoteDetailSchema.parse(
    await new NoteService(c.env, getAuth(c)).update(c.req.valid("param").id, c.req.valid("json")))),
);
noteRoutes.post("/:id/archive", zValidator("param", idParam), async (c) => {
  await new NoteService(c.env, getAuth(c)).archive(c.req.valid("param").id);
  return c.body(null, 204);
});
noteRoutes.post(
  "/:id/segments",
  zValidator("param", idParam),
  zValidator("json", AppendNoteTranscriptSegmentRequestSchema),
  async (c) => c.json(NoteTranscriptSegmentSchema.parse(
    await new NoteService(c.env, getAuth(c)).appendSegment(c.req.valid("param").id, c.req.valid("json")),
  ), 201),
);
noteRoutes.post(
  "/:id/generate",
  zValidator("param", idParam),
  zValidator("json", GenerateNoteNotesRequestSchema),
  async (c) => {
    const input = c.req.valid("json");
    return c.json(MeetingNotesResponseSchema.parse(await new NoteService(c.env, getAuth(c)).generate(
      c.req.valid("param").id,
      c.get("requestId"),
      input.mode,
      input.transcriptStatus,
      input.refreshSeconds ?? null,
    )));
  },
);
