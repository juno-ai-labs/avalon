import {
  CreateProjectRequestSchema,
  ProjectDirectorySchema,
  ProjectIdSchema,
  ProjectSummarySchema,
  ReorderProjectsRequestSchema,
  UpdateProjectPresentationRequestSchema,
} from "@rally/contracts";
import { Hono } from "hono";
import { z } from "zod";

import type { HonoAppEnv } from "../env";
import { getAuth } from "../middleware/auth";
import { zValidator } from "../middleware/validation";
import { ProjectService } from "../services/project-service";

const idParam = z.object({ id: ProjectIdSchema }).strict();

export const projectRoutes = new Hono<HonoAppEnv>();

projectRoutes.get("/", async (c) =>
  c.json(ProjectDirectorySchema.parse(await new ProjectService(c.env, getAuth(c)).list())),
);
projectRoutes.post("/", zValidator("json", CreateProjectRequestSchema), async (c) =>
  c.json(ProjectSummarySchema.parse(
    await new ProjectService(c.env, getAuth(c)).create(c.req.valid("json")),
  ), 201),
);
projectRoutes.put("/order", zValidator("json", ReorderProjectsRequestSchema), async (c) =>
  c.json(ProjectDirectorySchema.parse(
    await new ProjectService(c.env, getAuth(c)).reorder(c.req.valid("json")),
  )),
);
projectRoutes.patch(
  "/:id",
  zValidator("param", idParam),
  zValidator("json", UpdateProjectPresentationRequestSchema),
  async (c) => c.json(ProjectSummarySchema.parse(
    await new ProjectService(c.env, getAuth(c)).update(
      c.req.valid("param").id,
      c.req.valid("json"),
    ),
  )),
);
