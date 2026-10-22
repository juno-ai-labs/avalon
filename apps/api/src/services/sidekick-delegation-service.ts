import {
  IdSchema, SIDEKICK_DELEGATION_ERRORS, LEGACY_WORKSTREAM_LINK_ORIGINS,
  SidekickDelegatesResultSchema, SidekickMyDelegationsResultSchema,
  asUserId, asWorkspaceId, parseSidekickLinkPathTarget,
  type UserId, type WorkspaceId, type WorkstreamWorkflowInput,
} from "@rally/contracts";
import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { workspaceDOName } from "../durable-objects/names";
import { createMessageObjectPort } from "../runtime/message-port";

/** No model text participates: canonical human message identity supplies the speaker. */
export async function directSidekickDelegationUser(env: Env, input: WorkstreamWorkflowInput): Promise<UserId | null> {
  if (input.executionPrincipal.type !== "user" || !input.triggerMessageId || input.automationRun ||
    input.automationDelegation || input.backgroundAgent || input.agentExchange || input.scheduledWakeupId || input.activityId) return null;
  const message = await createMessageObjectPort(env, input.workspaceId, input.parentId, undefined, input.substreamId ?? "0")
    .message({ messageId: input.triggerMessageId });
  return message?.author_type === "human" && message.author_user_id === input.executionPrincipal.userId
    ? input.executionPrincipal.userId : null;
}

/** Record a routing hint before consent can commit, so response loss cannot hide a grant. */
export async function rememberSidekickDelegationLocation(env: Env, workspaceId: string, userId: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO sidekick_delegation_locations(user_id,workspace_id,region)
    VALUES (?,?,?) ON CONFLICT(user_id,workspace_id) DO NOTHING`).bind(userId, workspaceId, env.AVALON_REGION).run();
}

/** Signed-in self-service. This class never receives a model-selected actor. */
export class SidekickDelegationService {
  private readonly workspaceId: WorkspaceId;
  constructor(private readonly env: Env, workspaceId: string, private readonly userId: UserId) {
    this.workspaceId = asWorkspaceId(workspaceId);
  }

  private workspace() {
    return durableObjectStubForWorkspace(this.env, this.env.WORKSPACE_DOS, this.workspaceId,
      workspaceDOName(this.env.AVALON_REGION, this.workspaceId));
  }

  async listOwn() {
    return SidekickMyDelegationsResultSchema.parse(await (await this.workspace()).sidekickReadMyDelegations({
      workspaceId: this.workspaceId, userId: this.userId,
    }));
  }

  /** UUID and canonical link resolution still require the same viewer check as names. */
  async listDelegates(reference: string) {
    let id = IdSchema.safeParse(reference).data;
    if (!id) {
      let url: URL | null = null;
      try { url = new URL(reference); } catch { /* Exact visible name, not a URL. */ }
      if (url) {
        const origins = [this.env.PUBLIC_WEB_BASE_URL, ...LEGACY_WORKSTREAM_LINK_ORIGINS].map((origin) => new URL(origin).origin);
        const target = origins.includes(url.origin) && !url.search && !url.hash ? parseSidekickLinkPathTarget(url.pathname) : null;
        if (!target || target.workspaceId !== this.workspaceId || target.region !== this.env.AVALON_REGION) throw this.unavailable();
        id = target.sidekickId;
      } else {
        const directory = await (await this.workspace()).listSidekickDirectoryForAuthorizedMember({ workspaceId: this.workspaceId, userId: this.userId });
        const matches = directory.items.filter((item) => item.name.trim().toLocaleLowerCase() === reference.trim().toLocaleLowerCase());
        if (matches.length > 1) throw new ApiError(409, "sidekick_delegation_ambiguous_target", SIDEKICK_DELEGATION_ERRORS.sidekick_delegation_ambiguous_target);
        id = matches[0]?.id;
      }
    }
    if (!id) throw this.unavailable();
    return SidekickDelegatesResultSchema.parse(await (await this.workspace()).sidekickReadDelegation({
      workspaceId: this.workspaceId, automationId: id, actor: { userId: this.userId, participantOfOwningWorkstream: false },
    }));
  }

  async setOwn(sidekickId: string, allowed: boolean, operationId: string, source: "self_service" | "agent_request") {
    IdSchema.parse(sidekickId);
    IdSchema.parse(operationId);
    if (allowed) await rememberSidekickDelegationLocation(this.env, this.workspaceId, this.userId);
    const workspace = await this.workspace();
    const request = { workspaceId: this.workspaceId, automationId: sidekickId, userId: this.userId, allowed, operationId };
    // Preparation is durable and idempotent. A re-delivery cannot replace an old generation.
    const { generation } = await workspace.sidekickPrepareMyDelegation(request);
    return workspace.sidekickSetMyDelegation({ ...request, expectedGeneration: generation, source });
  }

  private unavailable(): ApiError {
    return new ApiError(404, "sidekick_not_found", SIDEKICK_DELEGATION_ERRORS.sidekick_not_found);
  }
}

/** Regional account recovery does not consult current Organization membership. */
export async function ownSidekickDelegationsAcrossOrganizations(env: Env, userId: UserId) {
  const locations = await env.DB.prepare("SELECT workspace_id FROM sidekick_delegation_locations WHERE user_id=? AND region=? ORDER BY workspace_id")
    .bind(userId, env.AVALON_REGION).all<{ workspace_id: string }>();
  const organizations = await Promise.all(locations.results.map(async (location) => ({
    workspaceId: asWorkspaceId(location.workspace_id),
    ...(await new SidekickDelegationService(env, location.workspace_id, asUserId(userId)).listOwn()),
  })));
  return { organizations };
}
