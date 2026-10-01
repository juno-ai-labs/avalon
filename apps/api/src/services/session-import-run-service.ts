import { renderSessionImportOpening } from "@rally/agent-harness";
import {
  asHarnessRunId,
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  type SessionImportRequest,
  type SpaceId,
} from "@rally/contracts";

import { RESERVED_CHILD_MEMBERSHIP_VERSION } from "../durable-objects/hosted-parent";
import { conversationObjectName, substreamLoopId, workspaceDOName } from "../durable-objects/names";
import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { uuidV7 } from "../lib/uuid-v7";
import { createHarnessRunObjectPort } from "../runtime/harness-run-port";
import { createMessageObjectPort } from "../runtime/message-port";
import { resolveAgentModelRouting } from "./agent-model-flags";
import { activateWorkstreamLoop } from "./integrations";
import { browserConversationSource, sessionSourceUrlProvider } from "./session-import";
import { prepareSessionImport } from "./session-import-files";
import { WorkstreamObjectClient } from "./workstream-object-client";
import { WorkstreamObjectCreationService } from "./workstream-object-creation-service";
import { bootstrapConversationChildRuntime, provisionWorkstreamObject } from "./workstream-runtime-database";

/** The create key's stand-in for history the reservation does not have yet. */
function importIdentityHash(clientMessageId: string): string {
  return `session-import:${clientMessageId}`;
}

/**
 * A conversation import run: an agent in a hidden child of the Channel it
 * imports into, driving the person's desktop browser, whose result the
 * desktop hands back to `complete` (a new Channel) or to the existing update
 * route (a Channel imported before).
 *
 * A new import reserves its Channel first, so the agent's run has a parent;
 * the Channel is listed and opens once `complete` initializes it with the
 * history, and `discard` archives it if the import never finishes.
 * `docs/session-import.md` owns the lifecycle.
 */
export class SessionImportRunService {
  constructor(
    private readonly env: Env,
    private readonly auth: AuthContext,
    private readonly defer?: (task: Promise<unknown>) => void,
  ) {}

  private creation() {
    return new WorkstreamObjectCreationService(this.env, this.auth, this.defer);
  }

  private channelInput(input: { title: string; clientMessageId: string; spaceIds: readonly string[] }) {
    return {
      objective: input.title,
      title: input.title,
      clientMessageId: input.clientMessageId,
      participantUserIds: [],
      scope: "personal" as const,
      spaceIds: input.spaceIds.map((id) => id as SpaceId),
    };
  }

  /** Reserve a new Channel and start the agent that will fill it. */
  async start(input: { sourceUrl: string; title: string; spaceIds: readonly string[]; clientMessageId: string }) {
    const source = browserConversationSource(input.sourceUrl);
    const { workstreamId } = await this.creation().reserveImport(
      this.channelInput(input),
      importIdentityHash(input.clientMessageId),
    );
    const substreamId = await this.launch(workstreamId, source, []);
    return { workstreamId, substreamId };
  }

  /** Start the agent again on a Channel imported before, keeping its recorded messages first. */
  async startUpdate(workstreamId: string) {
    const client = new WorkstreamObjectClient(this.env, this.auth, workstreamId, "0");
    const recorded = await client.importedSessionSource();
    if (!recorded?.url) throw new ApiError(409, "session_import_source_missing", "This channel has no updateable source session");
    const checkpoint = await client.importedSessionCheckpoint();
    const source = browserConversationSource(recorded.url);
    const substreamId = await this.launch(workstreamId, source, checkpoint.map((entry) => entry.sourceMessageId));
    return { workstreamId, substreamId };
  }

  /**
   * The agent's child conversation, provisioned under the Channel's parent
   * and started. Modeled on a Sidekick run (`SidekickDO.provisionRun`): the
   * child is reserved on the parent, so it is in no listing, admits only the
   * person importing, and runs the `session_import` agent profile.
   */
  private async launch(
    workstreamId: string,
    source: { provider: "chatgpt" | "claude"; url: string },
    recordedMessageIds: readonly string[],
  ): Promise<string> {
    const workspaceId = this.auth.workspaceId;
    const userId = asUserId(this.auth.userId);
    const childId = uuidV7(Date.now());
    const parent = await durableObjectStubForWorkspace(
      this.env, this.env.WORKSPACE_DOS, workspaceId, workspaceDOName(this.env.AVALON_REGION, asWorkspaceId(workspaceId)),
    );
    await parent.reserveHiddenChild({
      workspaceId: asWorkspaceId(workspaceId),
      parentId: workstreamId,
      substreamId: asSubstreamId(childId),
      createdByUserId: userId,
    }).catch((error: unknown) => {
      if (error instanceof Error && error.message === "workstream_archived") {
        throw new ApiError(409, "workstream_archived", "This channel is archived");
      }
      throw error;
    });
    await bootstrapConversationChildRuntime(this.env, workspaceId, "workstream", workstreamId, childId);
    const now = Date.now();
    await provisionWorkstreamObject(this.env, {
      workspaceId,
      workstreamId,
      substreamId: childId,
      title: "Import",
      objective: `Import ${source.url}`,
      scope: "personal",
      createdByUserId: userId,
      participantUserIds: [userId],
      harnessStatus: "scheduled",
      emailAddress: null,
      emailRouteStatus: null,
      systemKind: null,
      modelOverride: null,
      agentProfile: "session_import",
      now,
    });
    // The reserved child keeps no roster on its parent; the importer is its
    // one member, seated here at the version the parent admits them at.
    const childAgent = await durableObjectStubForWorkspace(
      this.env, this.env.SUBSTREAM_AGENTS, workspaceId,
      conversationObjectName(this.env.AVALON_REGION, asWorkspaceId(workspaceId), asWorkstreamId(workstreamId), asSubstreamId(childId)),
    );
    await childAgent.applyPrivateChildMembership({
      workspaceId, parentId: workstreamId, substreamId: childId, userId, actorUserId: userId,
      active: true, membershipVersion: RESERVED_CHILD_MEMBERSHIP_VERSION,
    });
    const opening = await createMessageObjectPort(this.env, workspaceId, workstreamId, undefined, childId).appendMessage({
      messageId: uuidV7(Date.now()),
      clientMessageId: `session-import-opening:${childId}`,
      authorType: "system",
      authorUserId: null,
      externalActorJson: null,
      messageType: "system",
      text: renderSessionImportOpening({ provider: source.provider, sourceUrl: source.url, recordedMessageIds }),
      structuredContentJson: null,
      producedByRunId: null,
      now: Date.now(),
    });
    const runId = uuidV7(Date.now());
    const executionPrincipal = { type: "user" as const, userId };
    const model = (await resolveAgentModelRouting(this.env, "session_import", { workspaceId, workstreamId, userId })).model;
    await createHarnessRunObjectPort(this.env, workspaceId, workstreamId, undefined, childId).admitRun({
      runId,
      origin: "session_import",
      executionPrincipalJson: JSON.stringify(executionPrincipal),
      status: "admitted",
      startedAt: null,
      model,
      triggerPartId: null,
      parentRunId: null,
      expectedLatestRunId: null,
      now: Date.now(),
    });
    await activateWorkstreamLoop(this.env, {
      region: this.env.AVALON_REGION,
      workspaceId: asWorkspaceId(workspaceId),
      parentKind: "workstream",
      parentId: workstreamId,
      substreamId: asSubstreamId(childId),
      loopId: substreamLoopId(workstreamId, asSubstreamId(childId)),
      harnessRunId: asHarnessRunId(runId),
      triggerMessageId: opening.messageId,
      activityId: null,
      executionPrincipal,
      reason: "session_import",
    });
    return childId;
  }

  /** Initialize a reserved Channel with what the agent read. */
  async complete(workstreamId: string, body: SessionImportRequest) {
    assertImportIdentity(body);
    const conversation = await prepareSessionImport(this.env, this.auth, body, body.clientMessageId);
    const created = await this.creation().openReservedImport(
      this.channelInput({ title: body.title, clientMessageId: body.clientMessageId, spaceIds: body.spaceIds }),
      conversation,
      importIdentityHash(body.clientMessageId),
    );
    if (created.workstream.id !== workstreamId) {
      throw new ApiError(409, "session_import_channel_mismatch", "This import key belongs to another channel");
    }
    return created;
  }

  /**
   * End an import that will not finish: stop its agent and, for a Channel that
   * never opened, archive it out of every listing. The create key is retired
   * first, so a `complete` that races this one is refused rather than opening
   * a Channel this has already archived.
   */
  async discard(input: { workstreamId: string; substreamId: string; clientMessageId: string | null }) {
    const workspaceId = this.auth.workspaceId;
    const child = await durableObjectStubForWorkspace(
      this.env, this.env.SUBSTREAM_AGENTS, workspaceId,
      conversationObjectName(this.env.AVALON_REGION, asWorkspaceId(workspaceId), asWorkstreamId(input.workstreamId), asSubstreamId(input.substreamId)),
    );
    await child.stopOwnedAgent();
    if (input.clientMessageId === null) return { discarded: false };
    const retired = await this.env.DB.prepare(
      `UPDATE workstream_create_receipts
          SET state = 'failed', error_code = 'session_import_discarded', updated_at = ?
        WHERE workspace_id = ? AND creator_user_id = ? AND client_message_id = ?
          AND workstream_id = ? AND state IN ('reserved', 'failed')
        RETURNING workstream_id`,
    ).bind(new Date().toISOString(), workspaceId, this.auth.userId, input.clientMessageId, input.workstreamId)
      .first<{ workstream_id: string }>();
    if (retired?.workstream_id !== input.workstreamId) {
      throw new ApiError(409, "session_import_already_open", "This channel has already opened; archive it instead");
    }
    const parent = await durableObjectStubForWorkspace(
      this.env, this.env.WORKSPACE_DOS, workspaceId, workspaceDOName(this.env.AVALON_REGION, asWorkspaceId(workspaceId)),
    );
    const result = await parent.discardReservedMain({ workspaceId, parentId: input.workstreamId, userId: this.auth.userId });
    if (result.status === "refused") {
      throw new ApiError(409, `session_import_discard_${result.code}`, "This channel cannot be discarded");
    }
    return { discarded: true };
  }
}

/** The checks every import write makes before it touches the Channel. */
export function assertImportIdentity(body: Pick<SessionImportRequest, "source" | "content">): void {
  if (!body.source.sessionId || body.content.messages.some((message) => !message.sourceMessageId)) {
    throw new ApiError(422, "session_import_identity_missing", "Every imported message needs its source message id");
  }
  if (body.source.url && sessionSourceUrlProvider(body.source.url, body.source.sessionId) !== body.source.provider) {
    throw new ApiError(422, "invalid_session_source", "The source.url does not belong to source.provider");
  }
}
