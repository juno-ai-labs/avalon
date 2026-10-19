import {
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  asSpaceId,
  mergeResourceIds,
  type ConversationMergeChannel,
  type ConversationMergeErrorCode,
  type ConversationMergeRequest,
  type ConversationMergeResult,
  type ConversationMergeV1,
  type ConversationMergedIntoV1,
} from "@rally/contracts";

import { workspaceDOName } from "../durable-objects/names";
import type { SpaceActorAuth } from "../durable-objects/workspace-space-protocol";
import type { AuthContext, Env } from "../env";
import { ApiError, asApiError } from "../lib/api-error";
import { sha256Hex } from "../lib/crypto";
import { uuidV7 } from "../lib/uuid-v7";
import { logError } from "../observability/logger";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { createMessageObjectPort } from "../runtime/message-port";
import { ConversationService } from "./conversation-service";
import type { WorkstreamObjectClient } from "./workstream-object-client";

/**
 * A refused merge: one of {@link ConversationMergeErrorCode}, with only the
 * allowlisted details (`field`, `available`). The route answers it as is; the
 * `conversation_merge` tool turns the code into its sentence.
 */
export class ConversationMergeRefusal extends ApiError {
  constructor(
    readonly mergeCode: ConversationMergeErrorCode,
    details?: { field?: string; available?: ConversationMergeChannel[] },
  ) {
    super(MERGE_REFUSAL_STATUS[mergeCode], mergeCode, MERGE_REFUSAL_MESSAGE[mergeCode], details);
  }
}

const MERGE_REFUSAL_STATUS = {
  merge_channel_not_placed: 409,
  merge_target_not_writable: 403,
  merge_resource_not_shareable: 403,
  conversation_archived: 409,
  conversation_access_denied: 404,
} as const satisfies Record<ConversationMergeErrorCode, ApiError["status"]>;

const MERGE_REFUSAL_MESSAGE: Record<ConversationMergeErrorCode, string> = {
  merge_channel_not_placed: "That channel does not hold this thread",
  merge_target_not_writable: "You cannot post there",
  merge_resource_not_shareable: "An embedded artifact cannot be shared there",
  conversation_archived: "That conversation is archived",
  conversation_access_denied: "Conversation not found",
};

/**
 * Merge-back (docs/conversation-merge.md): a Breakout's result into its
 * Thread, or a Thread's result into one of its Channels. The Merge button and
 * the `conversation_merge` tool both call this, so admission is the same for
 * a person and for Rally acting for one.
 *
 * Every check runs before anything is written; then the embedded resources
 * are attached, all or none; then the merge is posted. Attaching is
 * idempotent, so a retry after a failed post repeats nothing.
 */
export class ConversationMergeService {
  constructor(
    private readonly env: Env,
    private readonly auth: AuthContext,
  ) {}

  async merge(
    threadId: string,
    request: ConversationMergeRequest,
    options: { actingAgent?: boolean } = {},
  ): Promise<ConversationMergeResult> {
    const actingAgent = options.actingAgent === true;
    const result = request.breakoutId === undefined
      ? await this.mergeIntoChannel(threadId, request)
      : await this.mergeIntoThread(threadId, request.breakoutId, request, actingAgent);
    // The merge has landed: a marker that cannot be written is logged, not
    // reported as a failed merge the reader would then send again.
    await this.markSource(threadId, request, result, actingAgent).catch((error: unknown) => {
      logError(this.env, "conversation_merge_source_marker_failed", {
        workspace_id: this.auth.workspaceId,
        thread_id: threadId,
        breakout_id: request.breakoutId ?? null,
        target_kind: result.mergedInto.kind,
        target_id: result.mergedInto.id,
        reason: asApiError(error)?.code ?? (error instanceof Error ? error.message : String(error)),
      });
    });
    return result;
  }

  /**
   * Leave a system row in the source saying where the result went, which the
   * client draws as a divider that opens the merge. Keyed by the merge's
   * operation and target, so a retry, which replays the merge, writes no
   * second row, and finishes one a failed attempt left unwritten. Rally's
   * merges leave one too, marked as Rally's for the person it served. A
   * merge into a private or Personal Channel leaves one as well, naming that
   * Channel to every reader of the thread: a product choice, for a source
   * that always says where its work went.
   */
  private async markSource(
    threadId: string,
    request: ConversationMergeRequest,
    result: ConversationMergeResult,
    actingAgent: boolean,
  ): Promise<void> {
    const marker: ConversationMergedIntoV1 = {
      type: "conversation_merged_into",
      schemaVersion: 1,
      mergedInto: result.mergedInto,
      messageId: result.messageId,
      mergedByUserId: asUserId(this.auth.userId),
      actingAgent,
    };
    const key = await sha256Hex(`${result.mergedInto.kind}:${result.mergedInto.id}:${request.clientMessageId}`);
    await createMessageObjectPort(this.env, this.auth.workspaceId, threadId, undefined, request.breakoutId).appendMessage({
      messageId: uuidV7(Date.now()),
      clientMessageId: `merged-into:${key.slice(0, 48)}`,
      authorType: "system",
      authorUserId: null,
      externalActorJson: null,
      messageType: "system",
      text: `Merged into ${result.mergedInto.title || (result.mergedInto.kind === "thread" ? "the thread" : "the channel")}`,
      structuredContentJson: JSON.stringify(marker),
      producedByRunId: null,
      now: Date.now(),
    });
  }

  /** The Channels this thread could merge into for this person, and the default. */
  async channelTarget(threadId: string, channelId: string | null): Promise<
    { id: string; name: string; channels: ConversationMergeChannel[] }
  > {
    const target = await (await this.workspace()).channelMergeTarget({
      auth: this.actor(), workstreamId: asWorkstreamId(threadId), spaceId: channelId === null ? null : asSpaceId(channelId),
    });
    if (!target.ok) throw channelRefusal(target.code, target.channels);
    return { id: target.spaceId, name: target.name, channels: target.channels };
  }

  /**
   * Every Channel this thread is in that this person may post in, possibly
   * none: what the agent tool merges into. A thread that cannot merge at all
   * (private, archived, gone) is refused as the route refuses it.
   */
  async writableChannels(threadId: string): Promise<ConversationMergeChannel[]> {
    const target = await (await this.workspace()).channelMergeTarget({
      auth: this.actor(), workstreamId: asWorkstreamId(threadId), spaceId: null,
    });
    if (target.ok) return target.channels;
    // No placement, or a default the person cannot post in: the others are
    // still theirs to merge into.
    if (target.code === "merge_channel_not_placed" || target.code === "merge_target_not_writable") return target.channels;
    throw channelRefusal(target.code, target.channels);
  }

  private async mergeIntoThread(
    threadId: string,
    breakoutId: string,
    request: ConversationMergeRequest,
    actingAgent: boolean,
  ): Promise<ConversationMergeResult> {
    const conversations = new ConversationService(this.env, this.auth);
    const [source, main] = await Promise.all([
      // Reading the Breakout as itself is what checks it belongs to this Thread.
      conversations.authorizeViewer(threadId, breakoutId).catch((error: unknown) => {
        throw refusalFor(error, "conversation_access_denied");
      }),
      conversations.writableClient(threadId, "0").catch((error: unknown) => {
        throw refusalFor(error, "merge_target_not_writable");
      }),
    ]);
    // Only a Thread's Breakouts merge; a Sidekick's run has nowhere to go.
    if (source.kind !== "workstream") throw new ConversationMergeRefusal("conversation_access_denied");
    if (source.archived) throw new ConversationMergeRefusal("conversation_archived");
    const titles = await (await this.workspace()).breakoutMergeTitles({
      workspaceId: this.auth.workspaceId, workstreamId: threadId, substreamId: breakoutId,
    });
    const shared = await attachEmbeds(main, request.body);
    const merge: ConversationMergeV1 = {
      type: "conversation_merge",
      schemaVersion: 1,
      mergedFrom: { breakoutId: asSubstreamId(breakoutId), title: titles.breakout.slice(0, 300) },
      mergedByUserId: asUserId(this.auth.userId),
      actingAgent,
    };
    const receipt = await main.createMergeMessage({
      text: request.body,
      clientMessageId: request.clientMessageId,
      mentions: request.mentions ?? [],
      confirmedParticipantUserIds: request.confirmedParticipantUserIds ?? [],
      attachmentIds: [],
      merge,
    });
    return {
      mergedInto: { kind: "thread", id: threadId, title: titles.thread },
      messageId: receipt.turn.turnId,
      replayed: receipt.replayed,
      sharedResourceIds: shared.linked,
    };
  }

  private async mergeIntoChannel(threadId: string, request: ConversationMergeRequest): Promise<ConversationMergeResult> {
    const conversations = new ConversationService(this.env, this.auth);
    const [main, target] = await Promise.all([
      conversations.writableClient(threadId, "0").catch((error: unknown) => {
        throw refusalFor(error, "conversation_access_denied");
      }),
      this.channelTarget(threadId, request.channelId ?? null),
    ]);
    const shared = await attachEmbeds(main, request.body);
    const merged = await (await this.workspace()).mergeThreadIntoChannel({
      auth: this.actor(),
      workstreamId: asWorkstreamId(threadId),
      spaceId: asSpaceId(target.id),
      body: request.body,
      embeds: shared.resources,
      operationId: request.clientMessageId,
    });
    if (!merged.ok) throw channelRefusal(merged.code, merged.channels);
    return {
      mergedInto: { kind: "channel", id: merged.spaceId, title: merged.name },
      messageId: merged.messageId,
      replayed: merged.replayed,
      sharedResourceIds: shared.linked,
    };
  }

  private async workspace() {
    return durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      this.auth.workspaceId,
      workspaceDOName(this.env.AVALON_REGION, asWorkspaceId(this.auth.workspaceId)),
    );
  }

  private actor(): SpaceActorAuth {
    return {
      sessionId: this.auth.sessionId,
      userId: asUserId(this.auth.userId),
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      region: this.auth.region,
      role: this.auth.role,
      ...(this.auth.principal ? { principal: this.auth.principal } : {}),
    };
  }
}

/**
 * Attach every resource the body embeds to the conversation whose readers
 * can see the merge, all or none. A refusal names the embed's position, never
 * the resource.
 */
async function attachEmbeds(client: WorkstreamObjectClient, body: string) {
  const ids = mergeResourceIds(body);
  const attached = await client.attachResources(ids);
  if (!attached.ok) {
    throw new ConversationMergeRefusal("merge_resource_not_shareable", { field: `body.resources[${attached.index}]` });
  }
  return attached;
}

/** An admission failure from `ConversationService` as the merge's own code. */
function refusalFor(error: unknown, notFound: ConversationMergeErrorCode): unknown {
  const api = asApiError(error);
  if (api === null) return error;
  if (api.code === "conversation_parent_archived") return new ConversationMergeRefusal("conversation_archived");
  if (api.status === 404 || api.status === 403) return new ConversationMergeRefusal(notFound);
  return api;
}

function channelRefusal(
  code: "space_access_denied" | "workstream_not_found" | "conversation_archived"
    | "merge_channel_not_placed" | "merge_target_not_writable",
  channels: ConversationMergeChannel[],
): ConversationMergeRefusal {
  switch (code) {
    case "space_access_denied": return new ConversationMergeRefusal("merge_target_not_writable");
    case "workstream_not_found": return new ConversationMergeRefusal("conversation_access_denied");
    case "merge_channel_not_placed": return new ConversationMergeRefusal(code, { field: "channelId", available: channels });
    default: return new ConversationMergeRefusal(code);
  }
}
