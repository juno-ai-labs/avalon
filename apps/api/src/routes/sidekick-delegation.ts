import { Hono } from "hono";
import { z } from "zod";
import { IdSchema, WorkspaceIdSchema, AccountSidekickDelegationsSchema, SidekickDelegationMutationResultSchema } from "@rally/contracts";
import type { HonoAppEnv } from "../env";
import { getIdentityAuth, refuseSupportSession } from "../middleware/auth";
import { zValidator } from "../middleware/validation";
import { ownSidekickDelegationsAcrossOrganizations, SidekickDelegationService } from "../services/sidekick-delegation-service";

/** Mounted under identity auth, outside Organization membership middleware. */
export const accountSidekickDelegationRoutes = new Hono<HonoAppEnv>();
accountSidekickDelegationRoutes.use("*", refuseSupportSession);
accountSidekickDelegationRoutes.get("/", async (c) => c.json(
  AccountSidekickDelegationsSchema.parse(await ownSidekickDelegationsAcrossOrganizations(c.env, getIdentityAuth(c).userId)),
));
accountSidekickDelegationRoutes.post("/withdraw", zValidator("json", z.strictObject({
  workspaceId: WorkspaceIdSchema, sidekickId: IdSchema, operationId: IdSchema,
})), async (c) => {
  const input = c.req.valid("json");
  return c.json(SidekickDelegationMutationResultSchema.parse(await new SidekickDelegationService(
    c.env, input.workspaceId, getIdentityAuth(c).userId,
  ).setOwn(input.sidekickId, false, input.operationId, "self_service")));
});
