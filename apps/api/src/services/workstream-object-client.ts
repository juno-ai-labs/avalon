import { uuidV7 } from "../lib/uuid-v7";
import { SearchLinkSchema } from '../durable-objects/conversation-link-search';
import {
  ConversationSuggestionActionResultSchema,
  type ConversationSuggestionActionResult,
  ElicitationSchema,
  ParticipantSchema,
  WorkstreamResourceSchema,
  type ResourceRelationshipType,
  WorkstreamDetailSchema,
  WorkstreamTranscriptSnapshotSchema,
  WorkstreamSchema,
  TranscriptTurnSchema,
  WorkstreamMessageAdmissionReceiptSchema,
  ConnectorResourceAuthorizationRequestSchema,
  type Elicitation,
  asSubstreamId,
  asWorkspaceId,
  asWorkstreamId,
  type WorkstreamResource,
  type Workstream,
  type WorkstreamDetail,
  type WorkstreamTranscriptSnapshot,
  type WorkstreamAppearancePatch,
  type WorkstreamMessageAdmissionReceipt,
  type PreparedConversation,
} from "@rally/contracts";
import type {
  AcknowledgeWorkstreamReadRequestSchema,
  AnswerElicitationRequestSchema,
  SlackOriginContext,
  UpdateWorkstreamRequestSchema,
} from "@rally/contracts";
import { z } from "zod";

import type { ConversationParentKind } from "@rally/contracts/conversation-parent";
import { ReadTranscriptResultSchema, SidekickRunTranscriptResultSchema, type ReadTranscriptRequest } from "@rally/contracts";

import { conversationObjectName } from "../durable-objects/names";
import type {
  AgentLoopDO,
  SubstreamProductRequestInput,
} from "../durable-objects/agent-loop-do";
import { rpcResultBody, type DurableObjectRpcResult } from "../durable-objects/rpc-result";
import type {
  InitializeWorkstreamObjectRequest,
  WorkstreamObjectCreateMessageInput,
} from "../durable-objects/workstream-object-product";
import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import {
  WorkstreamReaderAudienceSchema,
  type WorkstreamReaderAudience,
} from "../lib/audience-containment";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";

const BootPayloadSchema = z.object({
  workstream: WorkstreamDetailSchema,
  transcript: WorkstreamTranscriptSnapshotSchema,
});
const AttachedResourcesSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    linked: z.array(z.string()),
    resources: z.array(z.strictObject({ id: z.string(), slug: z.string().optional(), title: z.string(), kind: z.string() })),
  }),
  z.strictObject({
    ok: z.literal(false),
    index: z.number().int().nonnegative(),
    code: z.enum(["resource_not_found", "resource_access_denied", "attachment_draft_requires_message"]),
  }),
]);

const CreatedMessageSchema = WorkstreamMessageAdmissionReceiptSchema;
const AnsweredElicitationSchema = z.strictObject({
  elicitation: ElicitationSchema.optional(),
});
const InitializedWorkstreamSchema = z.strictObject({
  workstream: WorkstreamSchema,
  turnId: z.string().uuid(),
  harnessRunId: z.string().uuid().nullable(),
});

async function objectStub(
  env: Env,
  workspaceId: string,
  workstreamId: string,
  substreamId = "0",
): Promise<DurableObjectStub<AgentLoopDO>> {
  return durableObjectStubForWorkspace(
    env,
    env.SUBSTREAM_AGENTS,
    workspaceId,
    conversationObjectName(env.AVALON_REGION, asWorkspaceId(workspaceId), asWorkstreamId(workstreamId), asSubstreamId(substreamId)),
  );
}

export async function attachWorkstreamRuntimeResource(
  env: Env,
  input: WorkstreamRuntimeResourceAttachment,
): Promise<void> {
  const { substreamId, ...attachment } = input;
  const response = await (await objectStub(env, input.workspaceId, input.workstreamId, substreamId))
    .attachRuntimeResource(attachment);
  if (response.status < 200 || response.status >= 300) {
    const body = rpcResultBody(response) as { error?: unknown } | null;
    throw new Error(typeof body?.error === "string" ? body.error : "runtime_resource_attach_failed");
  }
}

export interface WorkstreamRuntimeResourceAttachment {
  workspaceId: string;
  workstreamId: string;
  /** Which of the parent's conversations; the main one by default. */
  substreamId?: string;
  resourceId: string;
  attachedByUserId: string | null;
  relationshipType?: ResourceRelationshipType;
  /** The realtime transition this durable link write should advertise. */
  eventType?: "resource_attached" | "resource_updated";
}

export type WorkstreamRuntimeResourceAttacher = (
  input: WorkstreamRuntimeResourceAttachment,
) => Promise<void>;

/** Read audience from the work stream that owns participant and scope state. */
export async function readWorkstreamRuntimeAudience(
  env: Env,
  workspaceId: string,
  workstreamId: string,
): Promise<WorkstreamReaderAudience | null> {
  return WorkstreamReaderAudienceSchema.nullable().parse(
    await (await objectStub(env, workspaceId, workstreamId)).readerAudience({
      workspaceId,
      workstreamId,
    }),
  );
}

function decode(response: DurableObjectRpcResult): unknown {
  const body = rpcResultBody(response) as {
    error?: unknown;
    message?: unknown;
    details?: unknown;
  } | null;
  if (response.status >= 200 && response.status < 300) return body;
  throw new ApiError(
    apiStatus(response.status),
    typeof body?.error === "string" ? body.error : "workstream_object_request_failed",
    typeof body?.message === "string" ? body.message : "The thread could not be loaded",
    body?.details && typeof body.details === "object"
      ? body.details as Record<string, unknown>
      : undefined,
  );
}

function apiStatus(status: number): 400 | 401 | 403 | 404 | 409 | 413 | 422 | 426 | 429 | 500 | 502 | 503 {
  switch (status) {
    case 400: case 401: case 403: case 404: case 409: case 413:
    case 422: case 426: case 429: case 502: case 503: return status;
    default: return 500;
  }
}

/**
 * One product operation minus the two fields the client itself supplies.
 *
 * Distributed over the union so each operation keeps its own shape: an `Omit`
 * applied to the union as a whole would collapse it and let any operation carry
 * any other's fields.
 */
type ProductOperationPayload = SubstreamProductRequestInput extends infer Operation
  ? Operation extends object ? Omit<Operation, "auth" | "parentKind"> : never
  : never;

/** Typed Worker-side access to the product authority for one work stream. */
export class WorkstreamObjectClient {
  constructor(
    private readonly env: Env,
    private readonly auth: AuthContext,
    private readonly workstreamId: string,
    private readonly substreamId = "0",
    /**
     * Whether the caller is tracing one of the three work-stream flows. The
     * object's own spans nest under the caller's automatically — a Durable
     * Object call is a traced binding call — so nothing is propagated by hand;
     * this only tells the object whether to name its steps at all, so a
     * background path does not pay for spans nobody will read.
     */
    private readonly traced = false,
    /**
     * Which authority owns the parent this conversation belongs to.
     *
     * Sent on every product request and checked against the object's own
     * identity before it runs anything. A conversation is addressed by id, so
     * this is what keeps a Space id from reaching a Channel operation — see
     * `productOperation` in `agent-loop-do.ts`. The plain constructor means
     * a Channel; {@link WorkstreamObjectClient.forParent} names another kind.
     */
    private readonly parentKind: ConversationParentKind = "workstream",
  ) {}

  /**
   * One of a parent's conversations, addressed as whatever that parent is.
   *
   * For a caller that has already resolved the kind: the conversation routes
   * resolve it to authorize the viewer, and a Sidekick's run conversation
   * belongs to the Sidekick. The plain constructor means a Channel, which is
   * what every other caller has.
   */
  static forParent(
    env: Env,
    auth: AuthContext,
    parentKind: ConversationParentKind,
    parentId: string,
    substreamId = "0",
    traced = false,
  ): WorkstreamObjectClient {
    return new WorkstreamObjectClient(env, auth, parentId, substreamId, traced, parentKind);
  }

  private async request(body: ProductOperationPayload): Promise<unknown> {
    const response = await (await objectStub(
      this.env,
      this.auth.workspaceId,
      this.workstreamId,
      this.substreamId,
    )).handleProductRequest(
      // The auth payload is narrowed rather than spread: `AuthContext` now also
      // carries the analytics surrogates, `ProductRequestSchema` is strict, and
      // the object re-resolves both from its own session query anyway. Sending
      // them would be a field the room must reject or learn to ignore, for a
      // value it already has.
      {
        ...body,
        parentKind: this.parentKind,
        auth: {
          sessionId: this.auth.sessionId,
          userId: this.auth.userId,
          workspaceId: this.auth.workspaceId,
          region: this.auth.region,
          role: this.auth.role,
          // Spread conditionally so a session-principal payload never gains a
          // key it did not carry before connector principals existed: absence
          // is the wire's way of saying "verify my session". (Not a schema
          // necessity — the room declares the key as optional and JSON would
          // drop an `undefined` anyway; the point is the contract.)
          ...(this.auth.principal ? { principal: this.auth.principal } : {}),
        },
      },
      this.traced,
    );
    return decode(response);
  }

  async get(): Promise<WorkstreamDetail> {
    return WorkstreamDetailSchema.parse(await this.request({ operation: "get" }));
  }

  async searchLinks(links: Array<{ turnId: string; linkId: string }>) {
    return z.object({ title: z.string(), links: z.array(z.object({ linkId: z.string(), link: SearchLinkSchema.nullable() })) }).parse(
      await this.request({ operation: "search_links", links }),
    );
  }

  async searchLink(turnId: string, linkId: string) {
    return z.object({ title: z.string(), link: SearchLinkSchema.nullable() }).parse(
      await this.request({ operation: "search_link", turnId, linkId }),
    );
  }

  async searchTurns(turnIds: string[]) {
    return z.object({ title: z.string(), turns: z.array(TranscriptTurnSchema) }).parse(
      await this.request({ operation: "search_turns", turnIds }),
    );
  }

  /** Canonical participant history without opening the feed or acknowledging read state. */
  async readTranscript(input: ReadTranscriptRequest) {
    return ReadTranscriptResultSchema.parse(await this.request({ operation: "read_transcript", input }));
  }

  async inspectSidekickRunTranscript(input: ReadTranscriptRequest) {
    return SidekickRunTranscriptResultSchema.parse(await this.request({ operation: "inspect_sidekick_run_transcript",
      automationId: this.workstreamId, runId: this.substreamId, input }));
  }

  async readResourceAuthorizationRecovery(toolCallId: string) {
    return z.strictObject({ recovery: ConnectorResourceAuthorizationRequestSchema.nullable() }).parse(
      await this.request({ operation: "read_resource_authorization_recovery", toolCallId }),
    ).recovery;
  }

  /** Detail plus its canonical ordered transcript opening snapshot. */
  async boot(): Promise<{
    workstream: WorkstreamDetail;
    transcript: WorkstreamTranscriptSnapshot;
  }> {
    return BootPayloadSchema.parse(await this.request({ operation: "boot" }));
  }

  async initialize(input: InitializeWorkstreamObjectRequest): Promise<{
    workstream: Workstream;
    turnId: string;
    harnessRunId: string | null;
  }> {
    return InitializedWorkstreamSchema.parse(await this.request({ operation: "initialize", input }));
  }


  async update(input: z.infer<typeof UpdateWorkstreamRequestSchema>): Promise<Workstream> {
    return WorkstreamSchema.parse(await this.request({ operation: "update", input }));
  }

  async acknowledgeRead(
    input: z.infer<typeof AcknowledgeWorkstreamReadRequestSchema>,
  ): Promise<Workstream> {
    return WorkstreamSchema.parse(await this.request({ operation: "acknowledge_read", input }));
  }

  async markUnread(): Promise<Workstream> {
    return WorkstreamSchema.parse(await this.request({ operation: "mark_unread" }));
  }

  /** Mark the conversation resolved through its completion suggestion. */
  async resolveSuggestion(suggestionId: string): Promise<ConversationSuggestionActionResult> {
    return ConversationSuggestionActionResultSchema.parse(await this.request({ operation: "resolve_suggestion", suggestionId }));
  }

  /** Dismiss a conversation suggestion for everyone; replayed when it was already resolved. */
  async dismissSuggestion(suggestionId: string): Promise<ConversationSuggestionActionResult> {
    return ConversationSuggestionActionResultSchema.parse(await this.request({ operation: "dismiss_suggestion", suggestionId }));
  }

  async createMessage(
    input: WorkstreamObjectCreateMessageInput,
  ): Promise<WorkstreamMessageAdmissionReceipt> {
    return CreatedMessageSchema.parse(await this.request({ operation: "create_message", input }));
  }

  /**
   * Append a Breakout's merged result to this Main conversation: the message
   * route's admission with the server-written `merge` tag, which starts no
   * run. `replayed` is true when this `clientMessageId` was already admitted.
   */
  async createMergeMessage(
    input: WorkstreamObjectCreateMessageInput & { merge: NonNullable<WorkstreamObjectCreateMessageInput["merge"]> },
  ): Promise<WorkstreamMessageAdmissionReceipt & { replayed: boolean }> {
    return CreatedMessageSchema.extend({ replayed: z.boolean() }).parse(
      await this.request({ operation: "create_message", input }),
    );
  }

  async importedSessionSource(): Promise<{ provider: "chatgpt" | "claude" | "claude_code"; sessionId: string; url: string | null } | null> {
    return z.strictObject({ source: z.strictObject({ provider: z.enum(["chatgpt", "claude", "claude_code"]),
      sessionId: z.string(), url: z.string().nullable() }).nullable() }).parse(
      await this.request({ operation: "import_source_get" })).source;
  }

  async importedSessionCheckpoint(): Promise<Array<{ sourceMessageId: string; sourceRevision: string }>> {
    return z.strictObject({ messages: z.array(z.strictObject({ sourceMessageId: z.string(), sourceRevision: z.string() })) }).parse(
      await this.request({ operation: "import_source_checkpoint_get" })).messages;
  }

  async updateImportedSession(operationId: string, conversation: PreparedConversation): Promise<{ added: number; updated: number }> {
    return z.strictObject({ added: z.number().int().nonnegative(), updated: z.number().int().nonnegative() }).parse(
      await this.request({ operation: "import_source_update", operationId, conversation }));
  }

  /** Seat a reader through the conversation that owns the roster. */
  async addParticipant(userId: string, options: { operationId?: string } = {}):
  Promise<WorkstreamDetail["participants"][number]> {
    return ParticipantSchema.parse(await this.request({ operation: "add_participant", userId,
      operationId: options.operationId ?? uuidV7() }));
  }

  async removeParticipant(userId: string, options: { operationId?: string; owningThread?: boolean } = {}): Promise<void> {
    await this.request({ operation: "remove_participant", userId,
      operationId: options.operationId ?? uuidV7(), ...(options.owningThread ? { owningThread: true } : {}) });
  }

  /**
   * Set the icon and colour on the conversation that stores them.
   *
   * The Channel path for this is a socket command, which a Space has no socket
   * for. Same write, same effect, reached over the product request instead.
   */
  async setAppearance(patch: WorkstreamAppearancePatch): Promise<void> {
    await this.request({ operation: "set_appearance", operationId: uuidV7(), patch });
  }

  async attachResource(resourceId: string): Promise<WorkstreamResource> {
    return WorkstreamResourceSchema.parse(await this.request({ operation: "attach_resource", resourceId }));
  }

  /**
   * Attach several resources all or none, every check before any write; see
   * `WorkstreamObjectProduct.attachResources`. A refusal names the position.
   */
  async attachResources(resourceIds: readonly string[]): Promise<
    | { ok: true; linked: string[]; resources: Array<{ id: string; slug?: string | undefined; title: string; kind: string }> }
    | { ok: false; index: number; code: "resource_not_found" | "resource_access_denied" | "attachment_draft_requires_message" }
  > {
    return AttachedResourcesSchema.parse(await this.request({ operation: "attach_resources", resourceIds: [...resourceIds] }));
  }

  async detachResource(resourceId: string): Promise<void> {
    await this.request({ operation: "detach_resource", resourceId });
  }

  async renameResource(resourceId: string, title: string): Promise<void> {
    await this.request({ operation: "rename_resource", resourceId, title });
  }

  async answerElicitation(
    elicitationId: string,
    input: z.infer<typeof AnswerElicitationRequestSchema>,
    slackOrigin?: SlackOriginContext,
  ): Promise<{ elicitation: Elicitation | undefined }> {
    const parsed = AnsweredElicitationSchema.parse(await this.request({
      operation: "answer_elicitation",
      elicitationId,
      input,
      ...(slackOrigin ? { slackOrigin } : {}),
    }));
    return { elicitation: parsed.elicitation };
  }

}
