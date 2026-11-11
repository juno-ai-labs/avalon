import {
  SidekickSourceRequestResultSchema, SidekickSourceRequestViewSchema, SidekickSourceRequestsReadResultSchema, SidekickSourcesResultSchema,
  asWorkspaceId, type SidekickSourceRequestInput, type SidekickSourceRequestResult, type SidekickSourceRequestView,
  type SidekickSourcesResult, type UserId, type WorkspaceId,
} from "@rally/contracts";
import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { workspaceDOName } from "../durable-objects/names";

/**
 * A Sidekick's sources, for a signed-in person and for an agent acting as
 * one: who lets events in, asking somebody to, answering one's own request,
 * and taking one's own source back. The Organization object decides every
 * one of them; this only carries who is acting. `docs/sidekick-sources.md`.
 */
export class SidekickSourceService {
  private readonly workspaceId: WorkspaceId;
  constructor(
    private readonly env: Env, workspaceId: string, private readonly userId: UserId,
    private readonly role: "owner" | "admin" | "member" | null = null,
  ) {
    this.workspaceId = asWorkspaceId(workspaceId);
  }

  private workspace() {
    return durableObjectStubForWorkspace(this.env, this.env.WORKSPACE_DOS, this.workspaceId,
      workspaceDOName(this.env.AVALON_REGION, this.workspaceId));
  }

  private actor() {
    return { userId: this.userId, actorRole: this.role, participantOfOwningWorkstream: false };
  }

  async list(sidekickId: string): Promise<SidekickSourcesResult> {
    return SidekickSourcesResultSchema.parse(await (await this.workspace()).sidekickReadSources({
      workspaceId: this.workspaceId, automationId: sidekickId, actor: this.actor(),
    }));
  }

  /** The asker's name is read now and kept on the request: the person asked reads who asked. */
  async ask(sidekickId: string, ask: SidekickSourceRequestInput): Promise<SidekickSourceRequestResult> {
    const asker = await this.env.DB.prepare("SELECT name FROM users WHERE id = ?").bind(this.userId).first<{ name: string | null }>();
    return SidekickSourceRequestResultSchema.parse(await (await this.workspace()).sidekickRequestSources({
      workspaceId: this.workspaceId, automationId: sidekickId, actor: this.actor(), ask, actorName: asker?.name || "Someone",
    }));
  }

  async decide(sidekickId: string, requestId: string, decision: "approve" | "decline"): Promise<SidekickSourceRequestView> {
    return SidekickSourceRequestViewSchema.parse(await (await this.workspace()).sidekickDecideSourceRequest({
      workspaceId: this.workspaceId, automationId: sidekickId, requestId, userId: this.userId, decision,
    }));
  }

  async withdraw(sidekickId: string, connectionId: string): Promise<{ withdrawn: boolean }> {
    return (await this.workspace()).sidekickWithdrawSource({
      workspaceId: this.workspaceId, automationId: sidekickId, userId: this.userId, connectionId,
    });
  }

  /** Requests by id, each only if this person may see it: what a card in a conversation reads. */
  async readRequests(requestIds: readonly string[]): Promise<{ requests: SidekickSourceRequestView[] }> {
    return SidekickSourceRequestsReadResultSchema.parse(await (await this.workspace()).sidekickReadSourceRequests({
      workspaceId: this.workspaceId, actor: { userId: this.userId }, requestIds: [...requestIds],
    }));
  }
}
