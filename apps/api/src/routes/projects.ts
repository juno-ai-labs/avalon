import {
  CreateProjectRequestSchema,
  ProjectDirectorySchema,
  ProjectIdSchema,
  ProjectSummarySchema,
  ReorderProjectsRequestSchema,
  UpdateProjectPresentationRequestSchema,
  UpdateProjectAudienceRequestSchema,
  WorkstreamIdSchema,
  IdSchema,
} from "@rally/contracts";
import { Hono } from "hono";
import { z } from "zod";

import type { HonoAppEnv } from "../env";
import { getAuth } from "../middleware/auth";
import { zValidator } from "../middleware/validation";
import { ProjectService } from "../services/project-service";

const idParam = z.strictObject({ id: ProjectIdSchema });
const workstreamParam = z.strictObject({ id: ProjectIdSchema, workstreamId: WorkstreamIdSchema });
const workstreamBody = z.strictObject({ workstreamId: WorkstreamIdSchema });
const resourceParam = z.strictObject({ id: ProjectIdSchema, resourceId: IdSchema });
const resourceBody = z.strictObject({ resourceId: IdSchema });

export const projectRoutes = new Hono<HonoAppEnv>();

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
projectRoutes.patch(
  "/:id/audience",
  zValidator("param", idParam),
  zValidator("json", UpdateProjectAudienceRequestSchema),
  async (c) => c.json(ProjectSummarySchema.parse(
    await new ProjectService(c.env, getAuth(c)).updateAudience(
      c.req.valid("param").id,
      c.req.valid("json"),
    ),
  )),
);
projectRoutes.post(
  "/:id/archive",
  zValidator("param", idParam),
  async (c) => c.json(ProjectSummarySchema.parse(
    await new ProjectService(c.env, getAuth(c)).archive(c.req.valid("param").id),
  )),
);
projectRoutes.post(
  "/:id/restore",
  zValidator("param", idParam),
  async (c) => c.json(ProjectSummarySchema.parse(
    await new ProjectService(c.env, getAuth(c)).restore(c.req.valid("param").id),
  )),
);
projectRoutes.post(
  "/:id/workstreams",
  zValidator("param", idParam),
  zValidator("json", workstreamBody),
  async (c) => c.json(ProjectSummarySchema.parse(
    await new ProjectService(c.env, getAuth(c)).addWorkstream(
      c.req.valid("param").id,
      c.req.valid("json").workstreamId,
    ),
  )),
);
projectRoutes.delete(
  "/:id/workstreams/:workstreamId",
  zValidator("param", workstreamParam),
  async (c) => c.json(ProjectSummarySchema.parse(
    await new ProjectService(c.env, getAuth(c)).removeWorkstream(
      c.req.valid("param").id,
      c.req.valid("param").workstreamId,
    ),
  )),
);
projectRoutes.post(
  "/:id/default-resources",
  zValidator("param", idParam),
  zValidator("json", resourceBody),
  async (c) => c.json(ProjectSummarySchema.parse(
    await new ProjectService(c.env, getAuth(c)).addDefaultResource(
      c.req.valid("param").id,
      c.req.valid("json").resourceId,
    ),
  )),
);
projectRoutes.delete(
  "/:id/default-resources/:resourceId",
  zValidator("param", resourceParam),
  async (c) => c.json(ProjectSummarySchema.parse(
    await new ProjectService(c.env, getAuth(c)).removeDefaultResource(
      c.req.valid("param").id,
      c.req.valid("param").resourceId,
    ),
  )),
);
