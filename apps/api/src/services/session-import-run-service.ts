import { renderSessionImportOpening } from "@rally/agent-harness";
import {
  asHarnessRunId,
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  type SessionImportBreakoutRequest,
  type SessionImportRequest,
  type SpaceId,
} from "@rally/contracts";

import { RESERVED_CHILD_MEMBERSHIP_VERSION } from "../durable-objects/hosted-parent";
import { conversationObjectName, substreamLoopId, workspaceDOName } from "../durable-objects/names";
import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { uuidV7 } from "../lib/uuid-v7";
import { diagnosticErrorCode, logWarn } from "../observability/logger";
import { createHarnessRunObjectPort } from "../runtime/harness-run-port";
import { createMessageObjectPort } from "../runtime/message-port";
import { resolveAgentModelRouting } from "./agent-model-flags";
import { activateWorkstreamLoop } from "./integrations";
import { browserConversationSource, sessionSourceUrlProvider } from "./session-import";
import { prepareSessionImport } from "./session-import-files";
import { SubstreamCreationService } from "./substream-creation-service";
import { WorkstreamObjectClient } from "./workstream-object-client";
import { WorkstreamObjectCreationService } from "./workstream-object-creation-service";
import { bootstrapConversationChildRuntime, provisionWorkstreamObject } from "./workstream-runtime-database";

/**
 * The create key's stand-in for history the reservation does not have yet:
 * the key and the conversation the person opened, so `complete` can only
 * open the reservation with the conversation it was reserved for.
 */
function importIdentityHash(clientMessageId: string, sourceUrl: string): string {
  return `session-import:${clientMessageId}:${sourceUrl}`;
}

/**
 * A UUID named by `name`: the same name always gives the same id. A new
 * import's agent child and its run are named from its reservation, so a
 * replayed or concurrent start names the same child and the same run, and
 * the run is admitted once.
 */
async function nameDerivedUuid(name: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(name)));
  digest[6] = (digest[6]! & 0x0f) | 0x80; // version 8: a name-derived UUID
  digest[8] = (digest[8]! & 0x3f) | 0x80; // RFC 9562 variant
  const hex = [...digest.subarray(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The agent child of a Breakout import, named from the thread, the create key
 * and the conversation it reads: a replay on another conversation names a
 * different child, and a finish can be checked against the one that started.
 */
function breakoutImportChildId(workstreamId: string, clientMessageId: string, sourceUrl: string): Promise<string> {
  return nameDerivedUuid(`${workstreamId}:${clientMessageId}:breakout:${sourceUrl}`);
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

  private parent() {
    const workspaceId = this.auth.workspaceId;
    return durableObjectStubForWorkspace(
      this.env, this.env.WORKSPACE_DOS, workspaceId, workspaceDOName(this.env.AVALON_REGION, asWorkspaceId(workspaceId)),
    );
  }

  /**
   * Reserve a new Channel and start the agent that will fill it. Replaying
   * the same create key returns the run it started; a launch that fails
   * retires the reservation, so no listed Channel is left that nothing fills.
   */
  async start(input: { sourceUrl: string; title: string; spaceIds: readonly string[]; clientMessageId: string }) {
    const source = browserConversationSource(input.sourceUrl);
    const { workstreamId } = await this.creation().reserveImport(
      this.channelInput(input),
      importIdentityHash(input.clientMessageId, source.url),
    );
    const childId = await nameDerivedUuid(`${workstreamId}:${input.clientMessageId}`);
    const runId = await nameDerivedUuid(`${workstreamId}:${input.clientMessageId}:run`);
    const parent = await this.parent();
    if (await parent.ownsHiddenChild({ workspaceId: this.auth.workspaceId, parentId: workstreamId, substreamId: childId, userId: this.auth.userId })) {
      return { workstreamId, substreamId: childId };
    }
    let admitted: "admitted" | "exists" | null = null;
    try {
      await this.launch(workstreamId, source, [], childId, runId, (outcome) => { admitted = outcome; });
    } catch (error) {
      // A concurrent start that admitted the run owns the Channel now; only a
      // start whose launch failed with no run admitted takes the reservation back.
      const othersRun = admitted === "exists" || (admitted === null && await createHarnessRunObjectPort(
        this.env, this.auth.workspaceId, workstreamId, undefined, childId,
      ).run({ runId }).then((found) => found != null, () => false));
      // The launch's own error is what the caller gets; a retire that fails
      // too leaves the Channel listed until the desktop abandons the key, so
      // it is logged rather than lost.
      if (!othersRun) {
        await this.retire(workstreamId, input.clientMessageId).catch((retireError: unknown) => {
          logWarn(this.env, "session_import_retire_failed", {
            workspace_id: this.auth.workspaceId,
            workstream_id: workstreamId,
            reason: diagnosticErrorCode(retireError, "session_import_retire_failed"),
          });
        });
      }
      throw error;
    }
    return { workstreamId, substreamId: childId };
  }

  /**
   * Stop the caller's import agents on a Channel: an update's earlier runs, so
   * one runs at a time, and whatever an abandoned start left running.
   */
  private async stopImports(workstreamId: string): Promise<void> {
    const workspaceId = this.auth.workspaceId;
    const parent = await this.parent();
    const earlier = await parent.hiddenChildren({ workspaceId, parentId: workstreamId, userId: this.auth.userId });
    await Promise.all(earlier.map(async (substreamId) => {
      const child = await durableObjectStubForWorkspace(
        this.env, this.env.SUBSTREAM_AGENTS, workspaceId,
        conversationObjectName(this.env.AVALON_REGION, asWorkspaceId(workspaceId), asWorkstreamId(workstreamId), asSubstreamId(substreamId)),
      );
      await child.stopOwnedAgent();
    }));
  }

  /** Retire a new import's create key and archive its Channel, which never opened. */
  private async retire(workstreamId: string, clientMessageId: string): Promise<void> {
    const workspaceId = this.auth.workspaceId;
    const retired = await this.env.DB.prepare(
      `UPDATE workstream_create_receipts
          SET state = 'failed', error_code = 'session_import_discarded', updated_at = ?
        WHERE workspace_id = ? AND creator_user_id = ? AND client_message_id = ?
          AND workstream_id = ? AND state IN ('reserved', 'failed')
          -- Not 'initialized': a complete has claimed it and is opening the Channel.
        RETURNING workstream_id`,
    ).bind(new Date().toISOString(), workspaceId, this.auth.userId, clientMessageId, workstreamId)
      .first<{ workstream_id: string }>();
    if (retired?.workstream_id !== workstreamId) {
      throw new ApiError(409, "session_import_already_open", "This thread has already opened; archive it instead");
    }
    const result = await (await this.parent()).discardReservedMain({ workspaceId, parentId: workstreamId, userId: this.auth.userId });
    if (result.status === "refused") {
      throw new ApiError(409, `session_import_discard_${result.code}`, "This thread cannot be discarded");
    }
  }

  /**
   * Reserve a Breakout of an existing thread and start the agent that will
   * fill it. The Breakout is an ordinary unconfirmed preparation, captured
   * with the thread's context like any other, so it is in no listing until
   * `completeBreakout` confirms it with the history. The create key is the
   * preparation id, and the agent's child and run are named from it, so a
   * replayed start reserves nothing new and launches no second agent.
   */
  async startBreakout(workstreamId: string, input: { sourceUrl: string; title: string; clientMessageId: string }) {
    const source = browserConversationSource(input.sourceUrl);
    const breakouts = new SubstreamCreationService(this.env, this.auth, this.defer);
    const childId = await breakoutImportChildId(workstreamId, input.clientMessageId, source.url);
    const runId = await nameDerivedUuid(`${childId}:run`);
    // Who may start a Breakout here is decided before anything is launched in the thread.
    await breakouts.assertCanCreate(workstreamId);
    // Preparation captures and summarizes the thread's context, a model round
    // trip the agent does not depend on, so the agent starts alongside it
    // rather than after it. It is ready long before the agent finishes reading.
    const preparing = breakouts.prepare(workstreamId, { operationId: input.clientMessageId, title: input.title, throughTurnId: null });
    preparing.catch(() => undefined);
    const parent = await this.parent();
    if (await parent.ownsHiddenChild({ workspaceId: this.auth.workspaceId, parentId: workstreamId, substreamId: childId, userId: this.auth.userId })) {
      await preparing;
      return { workstreamId, substreamId: childId };
    }
    let admitted: "admitted" | "exists" | null = null;
    const [prepared, launched] = await Promise.allSettled([
      preparing,
      this.launch(workstreamId, source, [], childId, runId, (outcome) => { admitted = outcome; }),
    ]);
    if (prepared.status === "rejected") {
      // No Breakout for the agent to fill. Best effort: a loop not yet executing
      // misses the stop, and its finish is then refused instead.
      if (launched.status === "fulfilled") await this.stopAgent(workstreamId, childId).catch(() => undefined);
      throw prepared.reason;
    }
    if (launched.status === "rejected") {
      // As `start`: a concurrent start that admitted the run owns the
      // reservation now; only a launch with no run admitted takes it back.
      const othersRun = admitted === "exists" || (admitted === null && await createHarnessRunObjectPort(
        this.env, this.auth.workspaceId, workstreamId, undefined, childId,
      ).run({ runId }).then((found) => found != null, () => false));
      if (!othersRun) await breakouts.cancel(workstreamId, input.clientMessageId).catch(() => undefined);
      throw launched.reason;
    }
    return { workstreamId, substreamId: childId };
  }

  /** Stop the import agent running in the caller's hidden child. */
  private async stopAgent(workstreamId: string, substreamId: string): Promise<void> {
    const workspaceId = this.auth.workspaceId;
    const child = await durableObjectStubForWorkspace(
      this.env, this.env.SUBSTREAM_AGENTS, workspaceId,
      conversationObjectName(this.env.AVALON_REGION, asWorkspaceId(workspaceId), asWorkstreamId(workstreamId), asSubstreamId(substreamId)),
    );
    await child.stopOwnedAgent();
  }

  /** Confirm the reserved Breakout with the conversation the agent read. */
  async completeBreakout(workstreamId: string, body: SessionImportBreakoutRequest) {
    assertImportIdentity(body);
    if (!body.source.url) throw new ApiError(422, "session_import_source_missing", "The import names no source conversation");
    const breakouts = new SubstreamCreationService(this.env, this.auth, this.defer);
    // Before any file is uploaded: a key that names no live reservation of the
    // caller's, or a conversation other than the one the import was started
    // on, must not leave drafts behind, as `complete` checks its receipt first.
    const childId = await breakoutImportChildId(workstreamId, body.clientMessageId, browserConversationSource(body.source.url).url);
    if (!await (await this.parent()).ownsHiddenChild({ workspaceId: this.auth.workspaceId, parentId: workstreamId, substreamId: childId, userId: this.auth.userId })) {
      throw new ApiError(409, "session_import_source_mismatch", "This import was started on another conversation");
    }
    // Only files are uploaded ahead of `confirm`, which checks the preparation itself.
    if (body.content.messages.some((message) => message.files?.length)) {
      await breakouts.assertConfirmable(workstreamId, body.clientMessageId);
    }
    // Files are named from this operation; the thread scopes it as the preparation is scoped.
    const conversation = await prepareSessionImport(this.env, this.auth, body, `breakout:${workstreamId}:${body.clientMessageId}`);
    return breakouts.confirm(workstreamId, body.clientMessageId, null, null, conversation);
  }

  /** Start the agent again on a Channel imported before, keeping its recorded messages first. */
  async startUpdate(workstreamId: string) {
    const client = new WorkstreamObjectClient(this.env, this.auth, workstreamId, "0");
    const recorded = await client.importedSessionSource();
    if (!recorded?.url) throw new ApiError(409, "session_import_source_missing", "This thread has no updateable source session");
    const checkpoint = await client.importedSessionCheckpoint();
    const source = browserConversationSource(recorded.url);
    await this.stopImports(workstreamId);
    const substreamId = uuidV7(Date.now());
    await this.launch(workstreamId, source, checkpoint.map((entry) => entry.sourceMessageId), substreamId, uuidV7(Date.now()));
    return { workstreamId, substreamId };
  }

  /**
   * The agent's child conversation, provisioned under the Channel's parent
   * and started. Modeled on a Sidekick run (`provisionSidekickRun`): the
   * child is reserved on the parent, so it is in no listing, admits only the
   * person importing, and runs the `session_import` agent profile.
   */
  private async launch(
    workstreamId: string,
    source: { provider: "chatgpt" | "claude"; url: string },
    recordedMessageIds: readonly string[],
    childId: string,
    runId: string,
    onAdmission: (outcome: "admitted" | "exists") => void = () => undefined,
  ): Promise<string> {
    const workspaceId = this.auth.workspaceId;
    const userId = asUserId(this.auth.userId);
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
        throw new ApiError(409, "workstream_archived", "This thread is archived");
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
    const executionPrincipal = { type: "user" as const, userId };
    const model = (await resolveAgentModelRouting(this.env, "session_import", { workspaceId, workstreamId, userId })).model;
    const admission = await createHarnessRunObjectPort(this.env, workspaceId, workstreamId, undefined, childId).admitRun({
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
    if (admission.outcome === "exists") {
      // Another start admitted this run and activates it; there is one agent.
      onAdmission("exists");
      return childId;
    }
    onAdmission("admitted");
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
    if (!body.source.url) throw new ApiError(422, "session_import_source_missing", "The import names no source conversation");
    // Before anything is opened: a key that belongs to another Channel must
    // not initialize that Channel and then report a mismatch.
    const receipt = await this.env.DB.prepare(
      `SELECT workstream_id FROM workstream_create_receipts
        WHERE workspace_id = ? AND creator_user_id = ? AND client_message_id = ?`,
    ).bind(this.auth.workspaceId, this.auth.userId, body.clientMessageId).first<{ workstream_id: string }>();
    if (receipt?.workstream_id !== workstreamId) {
      throw new ApiError(409, "session_import_channel_mismatch", "This import key belongs to another thread");
    }
    const conversation = await prepareSessionImport(this.env, this.auth, body, body.clientMessageId);
    const created = await this.creation().openReservedImport(
      this.channelInput({ title: body.title, clientMessageId: body.clientMessageId, spaceIds: body.spaceIds }),
      conversation,
      importIdentityHash(body.clientMessageId, browserConversationSource(body.source.url).url),
    );
    if (created.workstream.id !== workstreamId) {
      throw new ApiError(409, "session_import_channel_mismatch", "This import key belongs to another thread");
    }
    return created;
  }

  /**
   * End an import that will not finish: stop its agent and, for a Channel that
   * never opened, archive it out of every listing. The create key is retired
   * first, so a `complete` that races this one is refused rather than opening
   * a Channel this has already archived.
   */
  async discard(input: { workstreamId: string; substreamId: string; clientMessageId: string | null; breakout?: boolean }) {
    const workspaceId = this.auth.workspaceId;
    const parent = await this.parent();
    // Authorized before anything is stopped: only the hidden child the caller
    // reserved for an import. Any other conversation's agent — a Channel's
    // own, a Breakout's, another person's import — is out of reach here.
    if (!await parent.ownsHiddenChild({ workspaceId, parentId: input.workstreamId, substreamId: input.substreamId, userId: this.auth.userId })) {
      throw new ApiError(404, "session_import_not_found", "No import of yours runs in that conversation");
    }
    await this.stopAgent(input.workstreamId, input.substreamId);
    if (input.clientMessageId === null) return { discarded: false };
    if (input.breakout) {
      // A Breakout the finish already confirmed stays; `cancel` refuses it.
      await new SubstreamCreationService(this.env, this.auth, this.defer).cancel(input.workstreamId, input.clientMessageId);
      return { discarded: true };
    }
    await this.retire(input.workstreamId, input.clientMessageId);
    return { discarded: true };
  }

  /**
   * End a new import by its create key alone: stop the caller's import agents
   * on its Channel and, while the Channel has never opened, archive it.
   *
   * For a start whose answer never reached the desktop (a launch that failed
   * with a retire that failed too, or an invocation cut off mid-launch), so
   * the window holds no ids for `discard`, only the key it sent. No run may
   * exist to end, so the run-end reclaim cannot cover it either.
   *
   * Reaches only the caller's own key, and only while its receipt is
   * `reserved` or `failed`: a key `complete` has claimed is refused before any
   * agent is stopped. A `failed` receipt is retired again, because a retire
   * that failed after the receipt was written left its Channel listed. A key
   * that reserved nothing answers `abandoned: false`.
   */
  async abandon(clientMessageId: string): Promise<{ abandoned: boolean }> {
    const receipt = await this.env.DB.prepare(
      `SELECT workstream_id, state FROM workstream_create_receipts
        WHERE workspace_id = ? AND creator_user_id = ? AND client_message_id = ?`,
    ).bind(this.auth.workspaceId, this.auth.userId, clientMessageId)
      .first<{ workstream_id: string; state: string }>();
    if (!receipt) return { abandoned: false };
    if (receipt.state !== "reserved" && receipt.state !== "failed") {
      throw new ApiError(409, "session_import_already_open", "This thread has already opened; archive it instead");
    }
    await this.stopImports(receipt.workstream_id);
    await this.retire(receipt.workstream_id, clientMessageId);
    return { abandoned: true };
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
