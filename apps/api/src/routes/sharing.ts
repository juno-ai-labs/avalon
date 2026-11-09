import { Hono } from "hono";
import { z } from "zod";
import { IdSchema } from "@rally/contracts";
import { parentStub, publishJoined } from "../services/scope-invitation-claims";
import {
  CreateScopeInvitationsSchema,
  RevokeScopeInvitationSchema,
  ScopeInvitationResultSchema,
  type ScopeInvitationResult,
} from "@rally/contracts/scope-grants";
import type { HonoAppEnv } from "../env";
import { getWorkspaceAuth, requireWorkspaceAuth } from "../middleware/auth";
import { zValidator } from "../middleware/validation";
import { ApiError, asApiError } from "../lib/api-error";

const CreateRequestSchema = z.strictObject({
  operationId: CreateScopeInvitationsSchema.shape.operationId,
  parentId: CreateScopeInvitationsSchema.shape.parentId,
  emails: CreateScopeInvitationsSchema.shape.emails,
  targets: CreateScopeInvitationsSchema.shape.targets,
  expiresAt: CreateScopeInvitationsSchema.shape.expiresAt,
  completeWorkstream: CreateScopeInvitationsSchema.shape.completeWorkstream,
});
const RevokeRequestSchema = RevokeScopeInvitationSchema.pick({ expectedRevision: true });
const InvitationParamSchema = z.strictObject({ parentId: IdSchema, invitationId: IdSchema });

function sharingResult(input: ScopeInvitationResult) {
  const result = ScopeInvitationResultSchema.parse(input);
  if (result.status !== "denied") return result;
  const status = result.reason === "configuration_required" ? 503
    : result.reason === "operation_conflict" || result.reason === "revision_conflict" || result.reason === "migration_pending" || result.reason === "scope_changed" ? 409 : 403;
  const message = result.reason === "sharing_required" ? "You cannot share this conversation. It may be archived or your access may have changed."
    : result.reason === "relationship_required" ? "Your workspace access has changed. Sign in again to continue."
    : result.reason === "migration_pending" ? "Sharing is being prepared. Try again shortly."
    : result.reason === "configuration_required" ? "Email sharing is not configured. Contact your workspace administrator."
    : result.reason === "scope_changed" || result.reason === "revision_conflict" || result.reason === "operation_conflict" ? "Sharing changed. Refresh the available scopes and try again."
    : "This share is no longer available.";
  throw new ApiError(status, `scope_${result.reason}`, message);
}

/**
 * A share is a Canvas's. The Organization object refuses any other parent id
 * as `conversation_parent_not_found`; to the caller that is a scope that does
 * not exist, not a server error.
 */
function canvasScopeNotFound(error: unknown): never {
  const api = asApiError(error);
  if (api?.code === "conversation_parent_not_found") {
    throw new ApiError(404, "scope_not_found", "That Canvas could not be found");
  }
  throw error;
}

/** Mounted below identity auth; every route here needs an existing relationship. */
export const sharingRoutes = new Hono<HonoAppEnv>();
// The shared directory, sharing options, grant management and the pending
// share list served Threads and Channels, which are retired (plan step C-2).
// A Canvas's Share dialog makes and removes shares by address, below.
sharingRoutes.post("/", requireWorkspaceAuth, zValidator("json", CreateRequestSchema), async (c) => {
  const auth = getWorkspaceAuth(c);
  const body = c.req.valid("json");
  if (body.targets.some((target) => target.workspaceId !== auth.workspaceId || target.parentId !== body.parentId)) {
    throw new ApiError(400, "scope_address_mismatch", "Choose targets in this Canvas");
  }
  const request = CreateScopeInvitationsSchema.parse({ ...body, workspaceId: auth.workspaceId, actorUserId: auth.userId });
  const result = sharingResult(
    await (await parentStub(c.env, request.workspaceId)).createScopeInvitations(request).catch(canvasScopeNotFound));
  // A recipient who already had an account was claimed as the share was made.
  // Publish any guest relationship that created after the response.
  const delivery = publishJoined(c.env, request.workspaceId, result.status === "created"
    ? result.invitations.flatMap((invitation) => invitation.acceptedByUserId ? [invitation.acceptedByUserId] : []) : []);
  try { c.executionCtx.waitUntil(delivery); } catch { void delivery; }
  c.header("Cache-Control", "no-store");
  return c.json(ScopeInvitationResultSchema.parse(result), 201);
});
sharingRoutes.delete("/:parentId/:invitationId", requireWorkspaceAuth,
  zValidator("param", InvitationParamSchema), zValidator("json", RevokeRequestSchema), async (c) => {
    const auth = getWorkspaceAuth(c);
    const request = RevokeScopeInvitationSchema.parse({ ...c.req.valid("param"), ...c.req.valid("json"),
      workspaceId: auth.workspaceId, actorUserId: auth.userId });
    const result = await (await parentStub(c.env, request.workspaceId)).revokeScopeInvitation(request).catch(canvasScopeNotFound);
    c.header("Cache-Control", "no-store");
    return c.json(ScopeInvitationResultSchema.parse(sharingResult(result)));
  });
