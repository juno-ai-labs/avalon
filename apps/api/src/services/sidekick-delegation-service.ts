import {
  IdSchema, SIDEKICK_DELEGATION_ERRORS, LEGACY_WORKSTREAM_LINK_ORIGINS,
  SidekickDelegatesResultSchema, SidekickMyDelegationsResultSchema, SidekickDelegationReceiptResultSchema,
  asWorkspaceId, parseSidekickLinkPathTarget,
  type UserId, type WorkspaceId,
} from "@rally/contracts";
import type { Env } from "../env";
import { ApiError, asApiError } from "../lib/api-error";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { workspaceDOName } from "../durable-objects/names";
/** The host supplies the actor; agent tools may select another Organization user. */
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

  setOwn(sidekickId: string, allowed: boolean, operationId: string, source: "self_service" | "agent_request") {
    return this.setFor(sidekickId, this.userId, allowed, operationId, source);
  }

  async setFor(sidekickId: string, userId: UserId, allowed: boolean, operationId: string, source: "self_service" | "agent_request") {
    IdSchema.parse(sidekickId);
    IdSchema.parse(operationId);
    const workspace = await this.workspace();
    const request = { workspaceId: this.workspaceId, automationId: sidekickId, userId, allowed, operationId };
    const { generation } = await workspace.sidekickPrepareMyDelegation(request);
    return workspace.sidekickSetDelegation({ ...request, actorUserId: this.userId, expectedGeneration: generation, source });
  }

  readOwnReceipt(sidekickId: string, allowed: boolean, operationId: string, source: "self_service" | "agent_request") {
    return this.readReceipt(sidekickId, this.userId, allowed, operationId, source);
  }

  async readReceipt(sidekickId: string, userId: UserId, allowed: boolean, operationId: string, source: "self_service" | "agent_request") {
    try {
      return SidekickDelegationReceiptResultSchema.parse(await (await this.workspace()).sidekickReadMyDelegationReceipt({
        workspaceId: this.workspaceId, automationId: IdSchema.parse(sidekickId), userId, actorUserId: this.userId,
        operationId: IdSchema.parse(operationId), allowed, source,
      }));
    } catch (error) {
      const refusal = asApiError(error);
      if (refusal && ["sidekick_not_found", "sidekick_delegation_membership_unavailable"].includes(refusal.code)) {
        return { outcome: "unavailable" as const };
      }
      throw error;
    }
  }

  private unavailable(): ApiError {
    return new ApiError(404, "sidekick_not_found", SIDEKICK_DELEGATION_ERRORS.sidekick_not_found);
  }
}
