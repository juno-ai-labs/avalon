import { ScopeGrantManagementRequestSchema, ManagedScopeGrantsSchema, RevokeScopeGrantSchema, ScopeGrantMutationResultSchema } from "@rally/contracts/scope-grants";
import { listSharedDirectory } from "../services/shared-directory-service";
import { Hono } from "hono";
import { z } from "zod";
import { IdSchema, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import { ScopeSharingOptionsSchema, ListScopeInvitationsSchema, ScopeInvitationsListSchema, CreateScopeInvitationsSchema, AcceptScopeInvitationSchema, RevokeScopeInvitationSchema,
  SharedDirectorySchema, ScopeInvitationResultSchema, type ScopeInvitationResult } from "@rally/contracts/scope-grants";
import type { Env, HonoAppEnv } from "../env";
import { getIdentityAuth, getWorkspaceAuth, requireWorkspaceAuth } from "../middleware/auth";
import { zValidator } from "../middleware/validation";
import { ApiError } from "../lib/api-error";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { workstreamDOName } from "../durable-objects/names";

const CreateRequestSchema = z.strictObject({
  operationId: CreateScopeInvitationsSchema.shape.operationId,
  parentId: CreateScopeInvitationsSchema.shape.parentId,
  emails: CreateScopeInvitationsSchema.shape.emails,
  targets: CreateScopeInvitationsSchema.shape.targets,
  expiresAt: CreateScopeInvitationsSchema.shape.expiresAt,
  completeWorkstream: CreateScopeInvitationsSchema.shape.completeWorkstream,
});
const AcceptRequestSchema = AcceptScopeInvitationSchema.omit({ userId: true });
const RevokeRequestSchema = RevokeScopeInvitationSchema.pick({ expectedRevision: true });
const InvitationParamSchema = z.strictObject({ parentId: IdSchema, invitationId: IdSchema });

function acceptedResult(input: ScopeInvitationResult) {
  const result = ScopeInvitationResultSchema.parse(input);
  if (result.status !== "denied") return result;
  const status = result.reason === "configuration_required" ? 503
    : result.reason === "operation_conflict" || result.reason === "revision_conflict" || result.reason === "migration_pending" || result.reason === "scope_changed" ? 409 : 403;
  const message = result.reason === "sharing_required" ? "You cannot share this conversation. It may be archived or your access may have changed."
    : result.reason === "relationship_required" ? "Your workspace access has changed. Sign in again to continue."
    : result.reason === "migration_pending" ? "Sharing is being prepared. Try again shortly."
    : "This invitation operation is unavailable. Refresh and try again.";
  throw new ApiError(status, `scope_${result.reason}`, message);
}

function parent(env: Env, workspaceId: string, parentId: string) {
  return durableObjectStubForWorkspace(env, env.WORKSTREAM_DOS, workspaceId,
    workstreamDOName(env.AVALON_REGION, asWorkspaceId(workspaceId), asWorkstreamId(parentId)));
}

/** Mounted below identity auth; only creating/revoking needs an existing relationship. */
export const sharingRoutes = new Hono<HonoAppEnv>();
sharingRoutes.get("/directory", requireWorkspaceAuth, async (c) => {
  const auth = getWorkspaceAuth(c);
  c.header("Cache-Control", "no-store");
  return c.json(SharedDirectorySchema.parse(await listSharedDirectory(c.env, auth.workspaceId, auth.userId)));
});
sharingRoutes.get("/:parentId/options", requireWorkspaceAuth, zValidator("param", z.object({ parentId: IdSchema })), async (c) => {
  const auth = getWorkspaceAuth(c);
  const parentId = c.req.valid("param").parentId;
  const result = await (await parent(c.env, auth.workspaceId, parentId)).scopeSharingOptions({
    workspaceId: auth.workspaceId, parentId, actorUserId: auth.userId,
  });
  c.header("Cache-Control", "no-store");
  return c.json(ScopeSharingOptionsSchema.parse(result));
});
sharingRoutes.post("/grants/list", requireWorkspaceAuth,
  zValidator("json", ScopeGrantManagementRequestSchema.omit({ actorUserId: true })), async (c) => {
    const auth = getWorkspaceAuth(c), target = c.req.valid("json").target;
    if (target.workspaceId !== auth.workspaceId) throw new ApiError(400, "scope_address_mismatch", "Choose a scope in this workspace");
    const result = await (await parent(c.env, auth.workspaceId, target.parentId)).listManagedScopeGrants({ target, actorUserId: auth.userId });
    c.header("Cache-Control", "no-store");
    return c.json(ManagedScopeGrantsSchema.parse(result));
  });
sharingRoutes.post("/grants/revoke", requireWorkspaceAuth, zValidator("json", RevokeScopeGrantSchema), async (c) => {
  const auth = getWorkspaceAuth(c), request = c.req.valid("json");
  if (request.target.workspaceId !== auth.workspaceId) throw new ApiError(400, "scope_address_mismatch", "Choose a scope in this workspace");
  const result = await (await parent(c.env, auth.workspaceId, request.target.parentId))
    .mutateScopeGrant({ ...request, actorUserId: auth.userId, active: false });
  c.header("Cache-Control", "no-store");
  return c.json(ScopeGrantMutationResultSchema.parse(result));
});
sharingRoutes.post("/list", requireWorkspaceAuth,
  zValidator("json", ListScopeInvitationsSchema.omit({ actorUserId: true })), async (c) => {
    const auth = getWorkspaceAuth(c);
    const target = c.req.valid("json").target;
    if (target.workspaceId !== auth.workspaceId) throw new ApiError(400, "scope_address_mismatch", "Choose a scope in this workspace");
    const result = await (await parent(c.env, auth.workspaceId, target.parentId)).listScopeInvitations({ target, actorUserId: auth.userId });
    c.header("Cache-Control", "no-store");
    return c.json(ScopeInvitationsListSchema.parse(result));
  });
sharingRoutes.post("/", requireWorkspaceAuth, zValidator("json", CreateRequestSchema), async (c) => {
  const auth = getWorkspaceAuth(c);
  const body = c.req.valid("json");
  if (body.targets.some((target) => target.workspaceId !== auth.workspaceId || target.parentId !== body.parentId)) {
    throw new ApiError(400, "scope_address_mismatch", "Choose targets in this workstream");
  }
  const request = CreateScopeInvitationsSchema.parse({ ...body, workspaceId: auth.workspaceId, actorUserId: auth.userId });
  const result = await (await parent(c.env, request.workspaceId, request.parentId)).createScopeInvitations(request);
  c.header("Cache-Control", "no-store");
  return c.json(ScopeInvitationResultSchema.parse(acceptedResult(result)), 201);
});
sharingRoutes.post("/accept", zValidator("json", AcceptRequestSchema), async (c) => {
  const request = AcceptScopeInvitationSchema.parse({ ...c.req.valid("json"), userId: getIdentityAuth(c).userId });
  const result = await (await parent(c.env, request.workspaceId, request.parentId)).acceptScopeInvitation(request);
  c.header("Cache-Control", "no-store");
  return c.json(ScopeInvitationResultSchema.parse(acceptedResult(result)));
});
sharingRoutes.delete("/:parentId/:invitationId", requireWorkspaceAuth,
  zValidator("param", InvitationParamSchema), zValidator("json", RevokeRequestSchema), async (c) => {
    const auth = getWorkspaceAuth(c);
    const request = RevokeScopeInvitationSchema.parse({ ...c.req.valid("param"), ...c.req.valid("json"),
      workspaceId: auth.workspaceId, actorUserId: auth.userId });
    const result = await (await parent(c.env, request.workspaceId, request.parentId)).revokeScopeInvitation(request);
    c.header("Cache-Control", "no-store");
    return c.json(ScopeInvitationResultSchema.parse(acceptedResult(result)));
  });
