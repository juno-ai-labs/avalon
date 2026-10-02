import { ScopeGrantManagementRequestSchema, ManagedScopeGrantsSchema, RevokeScopeGrantSchema, ScopeGrantMutationResultSchema } from "@rally/contracts/scope-grants";
import { listSharedDirectory, listSharedNavigationDirectory } from "../services/shared-directory-service";
import { Hono } from "hono";
import { z } from "zod";
import { IdSchema } from "@rally/contracts";
import { UNAVAILABLE_INVITATION, openScopeInvitationCredential, parentStub } from "../services/scope-invitation-link";
import { ScopeSharingOptionsSchema, ListScopeInvitationsSchema, ScopeInvitationsListSchema, CreateScopeInvitationsSchema, AcceptScopeInvitationSchema, RevokeScopeInvitationSchema, ScopeInvitationCredentialSchema,
  SharedDirectorySchema, SharedNavigationDirectorySchema, ScopeInvitationResultSchema, type ScopeInvitationResult } from "@rally/contracts/scope-grants";
import type { HonoAppEnv } from "../env";
import { getIdentityAuth, getWorkspaceAuth, requireWorkspaceAuth } from "../middleware/auth";
import { zValidator } from "../middleware/validation";
import { ApiError } from "../lib/api-error";
import { diagnosticErrorCode, logWarn } from "../observability/logger";
import { dispatchWorkspaceRelationshipChanges } from "../services/workspace-relationship-delivery";

const CreateRequestSchema = z.strictObject({
  operationId: CreateScopeInvitationsSchema.shape.operationId,
  parentId: CreateScopeInvitationsSchema.shape.parentId,
  emails: CreateScopeInvitationsSchema.shape.emails,
  targets: CreateScopeInvitationsSchema.shape.targets,
  expiresAt: CreateScopeInvitationsSchema.shape.expiresAt,
  completeWorkstream: CreateScopeInvitationsSchema.shape.completeWorkstream,
});
const AcceptRequestSchema = ScopeInvitationCredentialSchema;
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
    : result.reason === "configuration_required" ? "Email sharing is not configured. Contact your workspace administrator."
    : result.reason === "scope_changed" || result.reason === "revision_conflict" || result.reason === "operation_conflict" ? "Sharing changed. Refresh the available scopes and try again."
    : result.reason === "verified_email_required" ? "Sign out and sign in with the email address that received this invitation."
    : UNAVAILABLE_INVITATION;
  throw new ApiError(status, `scope_${result.reason}`, message);
}

/**
 * Grants, invitations and sharing are Channel-only, and the Organization
 * object refuses a Space id with `channel_parent_required`. To the caller that
 * is a scope that does not exist, not a server error.
 */
function channelScopeNotFound(error: unknown): never {
  if (error instanceof Error && error.message === "channel_parent_required") {
    throw new ApiError(404, "scope_not_found", "That Channel could not be found");
  }
  throw error;
}

/** Mounted below identity auth; only creating/revoking needs an existing relationship. */
export const sharingRoutes = new Hono<HonoAppEnv>();
sharingRoutes.get("/directory", requireWorkspaceAuth, async (c) => {
  const auth = getWorkspaceAuth(c);
  c.header("Cache-Control", "no-store");
  return c.json(SharedDirectorySchema.parse(await listSharedDirectory(c.env, auth.workspaceId, auth.userId)));
});
sharingRoutes.get("/navigation", requireWorkspaceAuth, async (c) => {
  const auth = getWorkspaceAuth(c);
  c.header("Cache-Control", "no-store");
  return c.json(SharedNavigationDirectorySchema.parse(
    await listSharedNavigationDirectory(
      c.env, auth.workspaceId, auth.userId, c.req.query("attention") === "1", c.req.query("shell") === "1",
    ),
  ));
});
sharingRoutes.get("/:parentId/options", requireWorkspaceAuth, zValidator("param", z.object({ parentId: IdSchema })), async (c) => {
  const auth = getWorkspaceAuth(c);
  const parentId = c.req.valid("param").parentId;
  const result = await (await parentStub(c.env, auth.workspaceId)).scopeSharingOptions({
    workspaceId: auth.workspaceId, parentId, actorUserId: auth.userId,
  }).catch(channelScopeNotFound);
  c.header("Cache-Control", "no-store");
  return c.json(ScopeSharingOptionsSchema.parse(result));
});
sharingRoutes.post("/grants/list", requireWorkspaceAuth,
  zValidator("json", ScopeGrantManagementRequestSchema.omit({ actorUserId: true })), async (c) => {
    const auth = getWorkspaceAuth(c), target = c.req.valid("json").target;
    if (target.workspaceId !== auth.workspaceId) throw new ApiError(400, "scope_address_mismatch", "Choose a scope in this workspace");
    const result = await (await parentStub(c.env, auth.workspaceId)).listManagedScopeGrants({ target, actorUserId: auth.userId }).catch(channelScopeNotFound);
    c.header("Cache-Control", "no-store");
    return c.json(ManagedScopeGrantsSchema.parse(result));
  });
sharingRoutes.post("/grants/revoke", requireWorkspaceAuth, zValidator("json", RevokeScopeGrantSchema), async (c) => {
  const auth = getWorkspaceAuth(c), request = c.req.valid("json");
  if (request.target.workspaceId !== auth.workspaceId) throw new ApiError(400, "scope_address_mismatch", "Choose a scope in this workspace");
  const result = await (await parentStub(c.env, auth.workspaceId))
    .mutateScopeGrant({ ...request, actorUserId: auth.userId, active: false }).catch(channelScopeNotFound);
  c.header("Cache-Control", "no-store");
  return c.json(ScopeGrantMutationResultSchema.parse(result));
});
sharingRoutes.post("/list", requireWorkspaceAuth,
  zValidator("json", ListScopeInvitationsSchema.omit({ actorUserId: true })), async (c) => {
    const auth = getWorkspaceAuth(c);
    const target = c.req.valid("json").target;
    if (target.workspaceId !== auth.workspaceId) throw new ApiError(400, "scope_address_mismatch", "Choose a scope in this workspace");
    const result = await (await parentStub(c.env, auth.workspaceId)).listScopeInvitations({ target, actorUserId: auth.userId }).catch(channelScopeNotFound);
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
  const result = await (await parentStub(c.env, request.workspaceId)).createScopeInvitations(request).catch(channelScopeNotFound);
  c.header("Cache-Control", "no-store");
  return c.json(ScopeInvitationResultSchema.parse(acceptedResult(result)), 201);
});
sharingRoutes.post("/accept", zValidator("json", AcceptRequestSchema), async (c) => {
  // The credential names its own scope; an authenticated caller cannot address
  // an invitation this deployment did not issue a token for, and never sees
  // where it points until the acceptance it authorizes succeeds.
  const address = await openScopeInvitationCredential(c.env, c.req.valid("json"));
  if (!address) throw new ApiError(403, "scope_invitation_unavailable", UNAVAILABLE_INVITATION);
  const request = AcceptScopeInvitationSchema.parse({ ...address, userId: getIdentityAuth(c).userId });
  const result = await (await parentStub(c.env, request.workspaceId)).acceptScopeInvitation(request).catch(channelScopeNotFound);
  // Acceptance may have created the recipient's guest relationship. Publish
  // its change now rather than on the next cron sweep, so the rest of the
  // Organization (member lists, other checks) hears of it in seconds. After
  // the response: the acceptance itself already recorded it where it checks.
  const delivery = dispatchWorkspaceRelationshipChanges(c.env, { workspaceId: request.workspaceId, userId: request.userId })
    .catch((error: unknown) => {
      logWarn(c.env, "workspace_relationship_dispatch_failed", {
        workspace_id: request.workspaceId, error: diagnosticErrorCode(error, "workspace_relationship_dispatch_failed"),
      });
    });
  try { c.executionCtx.waitUntil(delivery); } catch { void delivery; }
  c.header("Cache-Control", "no-store");
  return c.json(ScopeInvitationResultSchema.parse(acceptedResult(result)));
});
sharingRoutes.delete("/:parentId/:invitationId", requireWorkspaceAuth,
  zValidator("param", InvitationParamSchema), zValidator("json", RevokeRequestSchema), async (c) => {
    const auth = getWorkspaceAuth(c);
    const request = RevokeScopeInvitationSchema.parse({ ...c.req.valid("param"), ...c.req.valid("json"),
      workspaceId: auth.workspaceId, actorUserId: auth.userId });
    const result = await (await parentStub(c.env, request.workspaceId)).revokeScopeInvitation(request).catch(channelScopeNotFound);
    c.header("Cache-Control", "no-store");
    return c.json(ScopeInvitationResultSchema.parse(acceptedResult(result)));
  });
