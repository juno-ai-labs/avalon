import { asUserId, asWorkspaceId, SIDEKICK_SOURCE_ERRORS } from "@rally/contracts";
import {
  SOURCE_DECISION_PATH, SourceDecisionLinkSchema, SourceDecisionResultSchema, type SourceDecisionLink, type SourceDecisionResult,
} from "@rally/contracts/browser-session";
import type { z } from "zod";

import type { Env } from "../env";
import { sourceNoticeNames } from "../durable-objects/sidekick-source-notices";
import { workspaceDOName } from "../durable-objects/names";
import { ApiError } from "../lib/api-error";
import { browserOrigin } from "../lib/browser-origin";
import { hmacSha256, timingSafeEqualText } from "../lib/crypto";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";

/**
 * The emailed Approve and Decline links of a Sidekick source request: one
 * click records the asked person's answer, with no sign-in.
 *
 * A link is the request's own fields and an HMAC over them, keyed with the
 * session signing key under its own label, as an email sign-in proof is
 * (`email-login-service.ts`). Nothing is stored for it. The signature binds
 * the Organization, the Sidekick, the request, the person asked and the
 * decision, so a link cannot be edited into another person's answer or the
 * other decision; the request's own `pending` state is what makes it
 * single-use, and a request already answered or replaced reads back as it
 * stands. The fields ride in the fragment, which reaches no server or proxy
 * log; the page the link opens posts them as it loads. So the link is a
 * bearer of the answer: whoever opens it answers, a mail scanner that runs
 * the page's script included. `docs/sidekick-sources.md` owns the request and
 * says what that costs.
 */
export type SourceDecisionClaim = Omit<SourceDecisionLink, "token">;

function signature(env: Env, claim: SourceDecisionClaim): Promise<string> {
  return hmacSha256(env.SESSION_SIGNING_KEY, JSON.stringify(["sidekick-source-decision", claim.workspaceId, claim.sidekickId,
    claim.requestId, claim.userId, claim.decision]));
}

/** The link that records this decision when it is opened, on the browser host. */
export async function sourceDecisionUrl(env: Env, claim: SourceDecisionClaim): Promise<string> {
  const url = new URL(SOURCE_DECISION_PATH, browserOrigin(env));
  // A fragment does not reach the HTTP server or a proxy's log.
  url.hash = new URLSearchParams({
    region: env.AVALON_REGION, workspace: claim.workspaceId, sidekick: claim.sidekickId, request: claim.requestId,
    person: claim.userId, decision: claim.decision, token: await signature(env, claim),
  }).toString();
  return url.toString();
}

/** The two buttons a `source_request` email carries, in the order the app draws the same pair: Decline, then Approve. */
export async function sourceDecisionActions(env: Env, request: Omit<SourceDecisionClaim, "decision">): Promise<{ label: string; url: string }[]> {
  const [approve, decline] = await Promise.all([
    sourceDecisionUrl(env, { ...request, decision: "approve" }), sourceDecisionUrl(env, { ...request, decision: "decline" }),
  ]);
  return [{ label: "Decline", url: decline }, { label: "Approve", url: approve }];
}

const invalid = () => new ApiError(401, "sidekick_source_link_invalid", "This link is not valid. Open the request in Rally to answer it.");

/**
 * Record the decision a link carries, as the person it was sent to. The
 * signature is checked before anything is read, so an unsigned request
 * reaches no Organization. The request is read as that person first: one
 * still waiting is decided, and one already answered or replaced by a newer
 * ask is not changed, and the answer says how it stands. So the same link
 * opened again answers the same thing, and the other button opened after an
 * answer says the answer.
 */
export async function decideSourceRequestByLink(env: Env, input: z.input<typeof SourceDecisionLinkSchema>): Promise<SourceDecisionResult> {
  const { token, ...claim } = SourceDecisionLinkSchema.parse(input);
  if (!timingSafeEqualText(token, await signature(env, claim))) throw invalid();
  const workspaceId = asWorkspaceId(claim.workspaceId);
  const userId = asUserId(claim.userId);
  const workspace = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, workspaceId, workspaceDOName(env.AVALON_REGION, workspaceId));
  const current = (await workspace.sidekickReadSourceRequests({ workspaceId, actor: { userId }, requestIds: [claim.requestId] })).requests[0];
  // Gone with its Sidekick, or the person is no longer in the Organization.
  if (!current || current.sidekickId !== claim.sidekickId) {
    throw new ApiError(404, "sidekick_source_request_not_found", SIDEKICK_SOURCE_ERRORS.sidekick_source_request_not_found);
  }
  const view = current.state === "pending"
    ? await workspace.sidekickDecideSourceRequest({ workspaceId, automationId: claim.sidekickId, requestId: claim.requestId, userId, decision: claim.decision })
    : current;
  return SourceDecisionResultSchema.parse({
    state: view.state, applied: view.state === (claim.decision === "approve" ? "approved" : "declined"),
    sidekickName: view.sidekickName, requestedByName: view.requestedByName,
    ...sourceNoticeNames(env, view.connectorType, view.eventTypes), condition: view.condition,
  });
}
