import { annotationCommentText } from "@rally/contracts";
import { ResourceService } from "./resource-service";
import { WorkstreamCreationFieldsSchema } from "@rally/contracts";
import type { ConversationInitialization, PreparedConversation } from "@rally/contracts";
import { CreateWorkstreamRequestSchema, asUserId, asWorkstreamId } from "@rally/contracts";
import type {
  DemoSeed,
  ExecutionPrincipal,
  Scope,
  SlackOriginContext,
  SlackSearchAuthorization,
  SpaceColorKey,
  SpaceId,
  SpaceSummary,
  Workstream,
  WorkstreamId,
} from "@rally/contracts";
import { newId } from "@rally/db";
import type { z } from "zod";

import { workspaceDOName } from "../durable-objects/names";
import type { AuthContext, Env } from "../env";
import type { WorkspaceDO } from "../durable-objects/workspace-do";
import { workstreamImportHash } from "../durable-objects/workstream-import-hash";
import {
  WorkspaceChannelReservationResultSchema,
  type WorkspaceChannelReservationRequest,
} from "../durable-objects/workspace-space-protocol";
import type { ExternalBindingClaim } from "../durable-objects/workspace-external-binding-protocol";
import { ApiError } from "../lib/api-error";
import { resolveSpaceWorkstreamStart } from "../lib/channel-audience";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { logWarn } from "../observability/logger";
import { noFlowSpan, type FlowSpan } from "../observability/tracing";
import { SpaceService, spaceRefusal } from "./space-service";
import {
  activateExternalBindingClaim,
  externalBindingRefusal,
  openUnderExternalBindingClaim,
} from "./external-binding-claims";
import { provisionalWorkstreamDescription } from "./workstream-description-service";
import { chooseWorkstreamIcon, nameWorkstream, provisionalWorkstreamTitle } from "./workstream-naming-service";
import {
  writeRegionalWorkstreamAnchorBatch,
} from "./workstream-runtime-database";
import { WorkstreamEmailRoutingService } from "./workstream-email-routing-service";
import { WorkstreamObjectClient } from "./workstream-object-client";
import { readWorkstreamAuthorityControl, type WorkstreamAuthorityControl } from "./workstream-authority";

type ParsedCreateInput = z.infer<typeof CreateWorkstreamRequestSchema>;
type CreateInput = Omit<ParsedCreateInput, "mentions" | "spaceIds"> & {
  /** Optional at this internal boundary because the schema fills the empty case. */
  mentions?: ParsedCreateInput["mentions"];
  /** Optional for the same reason; empty means General, which is what every
   * caller with nobody at a keyboard means. */
  spaceIds?: ParsedCreateInput["spaceIds"];
  descriptionSource?: "authored" | "derived";
  /**
   * Who may read the work stream from birth, for the callers that know. Omitted
   * means `personal`, the fail-closed reading: the creator and anyone they
   * named. A Space grants no audience, so a caller that means
   * Organization-wide says so; the desktop's create route does, because a
   * Channel somebody starts in Rally is public. Not part of
   * `CreateWorkstreamRequestSchema` and deliberately so: an audience is
   * something the route or an ingress *knows* (the Slack channel the mention
   * was read out of), never something a request asserts about itself.
   */
  scope?: Scope;
};

interface ReceiptRow {
  workstream_id: string;
  generation: number;
  request_hash: string;
  state: "reserved" | "initialized" | "completed" | "failed";
  message_id: string | null;
  harness_run_id: string | null;
}

interface CreateOptions {
  contentIdentityHash?: string;
  /** Run the icon pass on a Channel created with its title (an import). */
  chooseIcon?: boolean;
  initialization?: ConversationInitialization;
  /** Authority snapshot already resolved by the owning HTTP route in this request. */
  authorityControl?: WorkstreamAuthorityControl;
  openingStructuredContent?: unknown;
  opportunitySnapshot?: {
    opportunityId: string;
    version: number;
    displayPromptHash: string;
    executionPromptHash: string;
  };
  originResourceIds?: string[];
  executionPrincipal?: ExecutionPrincipal;
  slackOrigin?: SlackOriginContext;
  slackSearchAuthorization?: SlackSearchAuthorization;
  reason?: string;
  telemetryOperationId?: string;
  telemetryRequestReceivedAt?: number;
  /**
   * Whether the people in `participantUserIds` are told they were added.
   *
   * The caller's to state, never the object's to infer, for the reason `scope`
   * is also an argument: this service is reached both by a person picking names
   * in "Add people" and by a connector ingress handing over a conversation's
   * resolved roster, and only the caller can tell those apart. Omitted means
   * quiet.
   */
  notifyParticipants?: boolean;
  /**
   * A person started this thread from a Channel, so a private Channel makes
   * it private (`resolveSpaceWorkstreamStart`). Like `notifyParticipants`,
   * the caller's to state: a connector ingress never sets it.
   */
  narrowInPrivateSpaces?: boolean;
  /**
   * The external thread this Channel is created for (a Slack thread addressed
   * to Rally under a linked room). Claimed `pending` inside
   * `reserveChannelInSpaces`, activated once the creation receipt completes,
   * and released if the create fails, so a thread never routes to a Channel
   * that does not exist. See docs/external-conversation-bindings.md.
   */
  externalBinding?: ExternalBindingClaim;
  /**
   * The demo seed opening this work stream, when the demo seeder is the
   * caller. Carried to the object's `initialize` and from there onto the
   * opening run's execution context; `POST /workstreams` has no field for it.
   */
  seed?: DemoSeed;
  /**
   * The caller's open `workstream_create` span. Creation is the slowest thing
   * a person waits on in Avalon, and every step below is an awaited round trip
   * to D1, a Durable Object, or the email router — so the span names here are
   * the whole diagnosis. See `docs/performance-tracing.md`.
   */
  span?: FlowSpan;
}

/**
 * The audience a Channel is born with, re-exported from the pure module that
 * `WorkspaceDO.reserveChannelInSpaces` computes the same answer with.
 */
export { resolveSpaceWorkstreamStart };

/** The Organization object, addressed once per create. */
type WorkspaceStub = Awaited<ReturnType<typeof durableObjectStubForWorkspace<WorkspaceDO>>>;

/** The half of {@link SpaceService} a replayed create reconciles through. */
interface ReplaySpacePlacement {
  ensureGeneral(): Promise<SpaceSummary>;
  addChannel(spaceId: SpaceId, workstreamId: WorkstreamId): Promise<unknown>;
}

/**
 * Reconcile the Space placement that is outside the D1 create receipt.
 *
 * The receipt records that the Channel exists; it records nothing about the
 * Organization's membership rows, which live in the Organization object. A
 * first create commits its placement before the conversation opens, but a
 * replay can still find none (a receipt reserved before Spaces existed, or a
 * Channel since taken out of the Space it named), so a redelivered create
 * places the Channel again. It goes through `addChannel` rather than
 * `reserveChannelInSpaces` because the Channel already exists: its audience
 * has to be widened through its canonical operations, which the birth-mode
 * reservation assumes already happened. `addChannel`'s preflight answers an
 * already-active membership with the generation it already has, so the second
 * attempt settles rather than conflicting.
 */
export async function reconcileReplayedSpaceMembership(input: {
  spaces: ReplaySpacePlacement;
  spaceIds: readonly SpaceId[];
  workstreamId: WorkstreamId;
}): Promise<void> {
  const spaceIds = input.spaceIds.length > 0
    ? input.spaceIds
    : [(await input.spaces.ensureGeneral()).id];
  for (const spaceId of spaceIds) await input.spaces.addChannel(spaceId, input.workstreamId);
}

/**
 * Regional creation coordinator; the new Channel's hosted parent in WorkspaceDO
 * and its main conversation (`SubstreamAgent`) own product state.
 */
export class WorkstreamObjectCreationService {
  constructor(
    private readonly env: Env,
    private readonly auth: AuthContext,
    /**
     * HTTP callers hand in `waitUntil`-backed deferral so naming happens after
     * the response, exactly as the legacy service documents; callers with no
     * way to defer get the call awaited rather than dropped.
     */
    private readonly defer?: (task: Promise<unknown>) => void,
  ) {}

  /** Store prepared facts through the same receipt, membership and publication workflow. */
  async createPrepared(
    input: Omit<CreateInput, "openingMessage" | "attachmentIds" | "mentions">,
    conversation: PreparedConversation,
    options: Omit<CreateOptions, "initialization" | "seed" | "openingStructuredContent"> = {},
  ) {
    return this.create({ ...input, objective: input.objective ?? input.title, openingMessage: "", attachmentIds: [] }, {
      ...options, initialization: { kind: "history", conversation, ...(options.contentIdentityHash ? { identityHash: options.contentIdentityHash } : {}) },
    });
  }

  /**
   * Reserve a Channel whose history does not exist yet: place it in its
   * Spaces and activate its route, but leave its main conversation
   * uninitialized.
   *
   * For a conversation import, whose agent runs in a child of this Channel
   * before there is anything to initialize it with. The Channel is listed
   * from here on and opens once `openReservedImport` initializes it with the
   * imported history under the same create key; until then it answers as
   * unavailable. `discardReservedChannel` removes it if the import never
   * finishes.
   *
   * `identityHash` stands in for the history in the create receipt, so the
   * reservation and the later open are one request to the receipt even
   * though only the second carries content.
   */
  async reserveImport(
    input: Omit<CreateInput, "openingMessage" | "attachmentIds" | "mentions">,
    identityHash: string,
  ): Promise<{ workstreamId: WorkstreamId }> {
    const reserved = await this.createOrReserve(
      { ...input, objective: input.objective ?? input.title, openingMessage: "", attachmentIds: [] },
      // The reservation never reads the conversation; the hash names it.
      { reason: "session_import", initialization: { kind: "history", conversation: { messages: [] }, identityHash } },
      "reserve",
    );
    if (!("reserved" in reserved)) {
      throw new ApiError(409, "workstream_import_already_open", "This import has already been opened");
    }
    return { workstreamId: reserved.reserved };
  }

  /** Initialize a Channel `reserveImport` reserved, under the same create key. */
  async openReservedImport(
    input: Omit<CreateInput, "openingMessage" | "attachmentIds" | "mentions">,
    conversation: PreparedConversation,
    identityHash: string,
  ) {
    return this.createPrepared(input, conversation, {
      reason: "session_import",
      contentIdentityHash: identityHash,
      chooseIcon: true,
    });
  }

  async create(input: CreateInput, options: CreateOptions = {}): Promise<{
    workstream: Workstream;
    turnId: string;
    harnessRunId: string | null;
  }> {
    const created = await this.createOrReserve(input, options, "open");
    if ("reserved" in created) throw new Error("workstream_create_stopped_at_reservation");
    return created;
  }

  private async createOrReserve(input: CreateInput, options: CreateOptions, stage: "reserve" | "open"): Promise<{
    workstream: Workstream;
    turnId: string;
    harnessRunId: string | null;
  } | { reserved: WorkstreamId }> {
    const span = options.span ?? noFlowSpan;
    const body = ((options.initialization?.kind === "history") ? WorkstreamCreationFieldsSchema : CreateWorkstreamRequestSchema).parse(input);
    // Named for the second read it is: `POST /workstreams` already resolved the
    // authority control row before choosing this service, and a span of its own
    // is where that duplicated round trip becomes visible instead of hiding
    // inside one aggregate number.
    const control = options.authorityControl ?? await span.step("workstream.create.authority.read_recheck", () =>
      readWorkstreamAuthorityControl(this.env));
    if (control.phase !== "durable_object_open") {
      throw new ApiError(503, "workstream_maintenance", "Work-stream maintenance is in progress");
    }
    // Resolved once, and part of the request rather than a property of it: two
    // creates under one `clientMessageId` that resolved different audiences are
    // different requests, and the receipt has to say so. A Slack event id is a
    // stable create key across the redeliveries Slack makes on an ack timeout,
    // while `resolveSlackChannelType` is re-run per delivery and answers
    // `unknown` — which fails closed to `personal` — whenever `conversations.info`
    // times out or the token has lost the scope for it. Left out of the hash, a
    // redelivery that resolved `private` would match the receipt of an attempt
    // that resolved `public`, replay it, and hand the caller back the
    // workspace-readable work stream the first attempt had already committed.
    // In the hash, that mismatch is the 409 the receipt exists to raise.
    const requestedScope = input.scope ?? "personal";
    const { mentions: requestMentions, workstreamId: namedId, ...hashBody } = body;
    const hashOf = (id: typeof namedId, scope: Scope = requestedScope) => workstreamImportHash({
      ...hashBody,
      ...(id ? { workstreamId: id } : {}),
      ...((options.initialization?.kind === "history") ? { initialization: options.initialization?.kind === "history" && options.initialization.identityHash
        ? { kind: "history", identityHash: options.initialization.identityHash } : options.initialization } : {}),
      // Keep empty mentions compatible with receipts reserved by the previous
      // Worker during a rolling deploy. Non-empty spans change the durable
      // message and therefore remain part of the idempotency identity.
      ...(requestMentions.length > 0 ? { mentions: requestMentions } : {}),
      descriptionSource: input.descriptionSource ?? "derived",
      scope,
    });
    const requestHash = hashOf(namedId);
    // A Worker from before `workstreamId` strips the field, so a receipt it
    // reserved hashed the request without it. A retry of that same create
    // reaching this Worker is still the same request, and replays that
    // receipt (under the id that Worker minted) rather than reading as a
    // conflict. The same rolling-deploy rule the empty mentions above follow.
    const legacyRequestHash = namedId ? hashOf(undefined) : requestHash;
    // `POST /workstreams` named no scope before every Space was
    // Organization-wide, so a create that Worker reserved hashed `personal`.
    // Its retry now asks for `workspace` and is still the same request. Only in
    // that direction: a private request never replays a public receipt.
    const legacyScopeHashes = requestedScope === "workspace"
      ? [hashOf(namedId, "personal"), hashOf(undefined, "personal")]
      : [];
    const at = new Date().toISOString();
    // A caller that listed the Channel before sending names the id it listed
    // it under. The reservation is where that id is claimed, and it is claimed
    // only if no conversation already has it: the receipt's own unique id
    // covers every create that went through a receipt, and the anchor table
    // covers the ones that did not (connector, import and Sidekick parents).
    // One statement, so nothing can anchor the id between the check and the
    // claim.
    if (body.annotations?.length && (await this.receipt(body.clientMessageId))?.state !== 'completed') {
      if (options.initialization?.kind === 'history' || options.openingStructuredContent) throw new ApiError(422,'annotation_opening_conflict','Annotations require an ordinary opening message');
      options = {...options,openingStructuredContent:await new ResourceService(this.env,this.auth).annotationContent(body.annotations)};
    }
    const proposedId = body.workstreamId ?? newId();
    await span.step("workstream.create.receipt.reserve", () => this.env.DB.prepare(
      `INSERT OR IGNORE INTO workstream_create_receipts
         (workspace_id, creator_user_id, client_message_id, workstream_id,
          generation, request_hash, state, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'reserved', ?7, ?8
        WHERE NOT EXISTS (SELECT 1 FROM workstreams WHERE id = ?4)`,
    ).bind(
      this.auth.workspaceId,
      this.auth.userId,
      body.clientMessageId,
      proposedId,
      control.generation,
      requestHash,
      at,
      at,
    ).run());
    const receipt = await span.step("workstream.create.receipt.read", () => this.receipt(body.clientMessageId));
    if (!receipt && body.workstreamId) {
      throw new ApiError(409, "workstream_id_unavailable", "This thread id is already in use");
    }
    if (!receipt || (receipt.request_hash !== requestHash && receipt.request_hash !== legacyRequestHash
      && !legacyScopeHashes.includes(receipt.request_hash))) {
      throw new ApiError(409, "workstream_create_idempotency_conflict", "This create key was already used");
    }
    if (receipt.generation !== control.generation) {
      throw new ApiError(409, "workstream_create_generation_stale", "Retry the create against the current authority generation");
    }
    // Only a discarded reservation is `failed`: its Channel is gone and its
    // create key may not bring it back.
    if (receipt.state === "failed") {
      throw new ApiError(409, "workstream_create_discarded", "This create was discarded; start a new one");
    }
    span.setAttributes({
      "rally.workstream.id": receipt.workstream_id,
      "rally.create.receipt_state": receipt.state,
    });
    // The object's own spans nest under this one automatically: a Durable
    // Object call is a traced binding call, and everything it runs happens in
    // this span's async context.
    const client = new WorkstreamObjectClient(
      this.env,
      this.auth,
      receipt.workstream_id,
      "0",
      options.span !== undefined,
    );
    const workspace = await durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      this.auth.workspaceId,
      workspaceDOName(this.env.AVALON_REGION, this.auth.workspaceId),
    );
    if (receipt.state === "completed" && receipt.message_id) {
      // A replayed create is a different latency question from a first one, so
      // it is labelled rather than folded into the same distribution.
      span.setAttributes({ "rally.create.path": "replayed_receipt" });
      const workstream = await span.step("workstream.create.replayed_detail.read", () => client.get());
      await span.step("workstream.create.replayed_space.reconcile", () =>
        reconcileReplayedSpaceMembership({
          spaces: new SpaceService(this.env, this.auth),
          spaceIds: body.spaceIds,
          workstreamId: asWorkstreamId(receipt.workstream_id),
        }));
      if (options.externalBinding) {
        await activateExternalBindingClaim(
          this.env, workspace, this.auth.workspaceId, options.externalBinding, receipt.workstream_id,
        );
      }
      return {
        workstream,
        turnId: receipt.message_id,
        harnessRunId: receipt.harness_run_id,
      };
    }
    span.setAttributes({ "rally.create.path": "fresh" });

    const authoredOpening = annotationCommentText(body.openingMessage,body.annotations);
    const workstreamId = asWorkstreamId(receipt.workstream_id);
    const objective = body.objective
      ?? provisionalWorkstreamDescription(authoredOpening, "Review the attached files");
    const title = body.title ?? provisionalWorkstreamTitle(objective, "New thread");
    const routeInput = {
      region: this.env.AVALON_REGION,
      workspaceId: this.auth.workspaceId,
      workstreamId: receipt.workstream_id,
    } as const;
    const emailRouting = new WorkstreamEmailRoutingService(this.env);
    const email = await span.step("workstream.create.email_address.reserve", () => emailRouting.reserve(routeInput));

    // Every Channel is born in a Space, so this runs on every create rather
    // than on the ones that chose a destination. One WorkspaceDO call commits
    // the memberships, the Space defaults the Channel inherits, and the parent
    // row with its provisional directory row, in one transaction. So a Channel is never listed
    // outside a Space, and a Space the caller may not reach, or that has been
    // archived, refuses here with nothing written.
    //
    // Before the D1 anchor, so that refusal leaves only the idempotency
    // receipt and the address reservation, both keyed to this id and reused
    // by a retry under the same create key. A failure *after* this call
    // leaves a placed, listed Channel whose conversation may never open, which
    // is the residue to prefer: the retry reuses the id and this call is
    // idempotent for it.
    const placement = await span.step("workstream.create.spaces.reserve", () =>
      this.reserveInSpaces(workspace, {
        ...(options.externalBinding ? { externalBinding: options.externalBinding } : {}),
        workspaceId: this.auth.workspaceId,
        userId: asUserId(this.auth.userId),
        workstreamId,
        spaceIds: [...body.spaceIds],
        requestedScope,
        requestedParticipantUserIds: body.participantUserIds.map(asUserId),
        ...(options.narrowInPrivateSpaces ? { narrowInPrivateSpaces: true } : {}),
        authorityGeneration: control.generation,
        ...(stage === "reserve" ? { reclaimUnopened: true as const } : {}),
        directory: {
          title,
          description: objective,
          emailAddress: email.emailAddress,
          titleStatus: body.title == null ? "naming" : "settled",
          createdAt: at,
        },
      }));
    // The same pure derivation the reservation wrote the directory row's scope
    // with, over the same Spaces, so the conversation opens with that scope.
    const start = resolveSpaceWorkstreamStart({
      spaces: placement.spaces,
      scope: requestedScope,
      requestedParticipantUserIds: body.participantUserIds,
      originResourceIds: options.originResourceIds ?? [],
      narrowInPrivateSpaces: options.narrowInPrivateSpaces === true,
    });
    const scope = start.scope;
    const participantUserIds = start.participantUserIds;
    const originResourceIds = start.originResourceIds;
    if (stage === "reserve") {
      // A child of this Channel runs before the Channel opens, and its parent
      // effects are refused unless the route is active; see
      // `writeAnchorAndRoute`. `openReserved` later finds both rows written.
      await span.step("workstream.create.d1_rows.write", () => this.writeAnchorAndRoute(
        receipt.workstream_id, control.generation, at, "active",
      ));
      return { reserved: workstreamId };
    }
    if (!options.externalBinding) {
      return this.openReserved(span, body, options, input, {
        receipt, client, control, workstreamId, title, objective, email, scope,
        participantUserIds, originResourceIds, requestHash, at, color: placement.color ?? null,
      });
    }
    // A failed creation must not leave a live binding to an absent
    // destination; a completed one makes the claim the thread's route.
    return openUnderExternalBindingClaim(
      this.env, workspace, this.auth.workspaceId, options.externalBinding, workstreamId,
      () => this.openReserved(span, body, options, input, {
        receipt, client, control, workstreamId, title, objective, email, scope,
        participantUserIds, originResourceIds, requestHash, at, color: placement.color ?? null,
      }),
    );
  }

  /**
   * Everything after the Organization-side reservation: the D1 anchors, the
   * conversation's `initialize`, route activation and receipt completion.
   */
  private async openReserved(
    span: FlowSpan,
    body: ReturnType<typeof WorkstreamCreationFieldsSchema.parse>,
    options: CreateOptions,
    input: CreateInput,
    reserved: {
      receipt: ReceiptRow;
      client: WorkstreamObjectClient;
      control: WorkstreamAuthorityControl;
      workstreamId: WorkstreamId;
      title: string;
      objective: string;
      email: { emailAddress: string | null };
      scope: Scope;
      participantUserIds: string[];
      originResourceIds: string[];
      requestHash: string;
      at: string;
      /** The Channel colour the reservation read; see `reserveChannelInSpaces`. */
      color: SpaceColorKey | null;
    },
  ): Promise<{ workstream: Workstream; turnId: string; harnessRunId: string | null }> {
    const {
      receipt, client, control, title, objective, email, scope, participantUserIds,
      originResourceIds, requestHash, at, color,
    } = reserved;

    // The claim that fences a discard: from here the receipt is `initialized`,
    // which a discard or an import's run-end reclaim no longer fails, so the
    // two cannot both win. A discard that won first is refused here, before
    // anything opens. An `initialized` receipt is a create that stopped
    // midway, which this retry finishes.
    const claimed = await span.step("workstream.create.receipt.claim", () => this.env.DB.prepare(
      `UPDATE workstream_create_receipts SET state = 'initialized', updated_at = ?
        WHERE workspace_id = ? AND creator_user_id = ? AND client_message_id = ?
          AND request_hash = ? AND state IN ('reserved', 'initialized')`,
    ).bind(new Date().toISOString(), this.auth.workspaceId, this.auth.userId, body.clientMessageId, requestHash).run());
    if (Number(claimed.meta.changes ?? 0) === 0) {
      throw new ApiError(409, "workstream_create_discarded", "This create was discarded; start a new one");
    }

    await span.step("workstream.create.d1_rows.write", () => this.writeAnchorAndRoute(
      receipt.workstream_id, control.generation, at, "verified",
    ));

    const created = await span.step("workstream.create.child.initialize", () => client.initialize({
      workspaceId: this.auth.workspaceId,
      workstreamId: asWorkstreamId(receipt.workstream_id),
      generation: control.generation,
      title,
      objective,
      descriptionSource: input.descriptionSource ?? "derived",
      titleStatus: body.title == null ? "naming" : "settled",
      emailAddress: email.emailAddress,
      creatorUserId: this.auth.userId,
      openingMessage: body.openingMessage,
      ...((options.initialization?.kind === "history") ? { initialization: options.initialization } : {}),
      mentions: body.mentions,
      openingStructuredContent: options.openingStructuredContent ?? null,
      clientMessageId: body.clientMessageId,
      participantUserIds,
      notifyParticipants: options.notifyParticipants ?? false,
      attachmentIds: body.attachmentIds,
      scope,
      originResourceIds,
      ...(color ? { color } : {}),
      modelOverride: body.modelOverride ?? null,
      systemKind: null,
      ...(options.seed ? { seed: options.seed } : {}),
      createdFromOpportunityId: options.opportunitySnapshot?.opportunityId ?? null,
      opportunityVersion: options.opportunitySnapshot?.version ?? null,
      opportunityDisplayPromptHash: options.opportunitySnapshot?.displayPromptHash ?? null,
      opportunityExecutionPromptHash: options.opportunitySnapshot?.executionPromptHash ?? null,
      executionPrincipal: options.executionPrincipal ?? { type: "user", userId: this.auth.userId },
      ...(options.slackOrigin ? { slackOrigin: options.slackOrigin } : {}),
      ...(options.slackSearchAuthorization ? {
        slackSearchAuthorization: options.slackSearchAuthorization,
      } : {}),
      ...(options.telemetryOperationId ? {
        telemetryOperationId: options.telemetryOperationId,
        telemetrySubjectUserId: this.auth.userId,
      } : {}),
      ...(options.telemetryRequestReceivedAt !== undefined ? {
        telemetryRequestReceivedAt: options.telemetryRequestReceivedAt,
        telemetryJourney: "workstream_create" as const,
      } : {}),
      reason: options.reason ?? "opening_message",
    }));
    span.setAttributes({ "rally.harness_run.id": created.harnessRunId });
    const activatedAt = new Date().toISOString();
    const activated = await span.step("workstream.create.route.activate", () => this.env.DB.prepare(
      `UPDATE workstream_authority_routes
          SET state = 'active', activated_at = COALESCE(activated_at, ?), updated_at = ?
        WHERE workspace_id = ? AND workstream_id = ? AND generation = ?
          AND state IN ('verified', 'active')`,
    ).bind(
      activatedAt,
      activatedAt,
      this.auth.workspaceId,
      receipt.workstream_id,
      control.generation,
    ).run());
    if (Number(activated.meta.changes ?? 0) !== 1) {
      throw new Error("workstream_create_route_activation_failed");
    }
    // The claim above keeps a discard from failing this receipt now; the
    // guard stays so a receipt that is somehow `failed` is never revived.
    const completedReceipt = await span.step("workstream.create.receipt.complete", () => this.env.DB.prepare(
      `UPDATE workstream_create_receipts
          SET state = 'completed', message_id = ?, harness_run_id = ?,
              error_code = NULL, updated_at = ?
        WHERE workspace_id = ? AND creator_user_id = ? AND client_message_id = ?
          AND request_hash = ? AND state <> 'failed'`,
    ).bind(
      created.turnId,
      created.harnessRunId,
      new Date().toISOString(),
      this.auth.workspaceId,
      this.auth.userId,
      body.clientMessageId,
      requestHash,
    ).run());
    if (Number(completedReceipt.meta.changes ?? 0) === 0) {
      throw new ApiError(409, "workstream_create_discarded", "This create was discarded; start a new one");
    }

    // The first naming pass. The legacy creation path schedules this and the
    // object path never did, so every post-cutover work stream kept its
    // provisional title in `naming` forever — a permanent skeleton shimmer in
    // the sidebar. Naming reaches transcript and identity through their typed
    // object ports; it does not need a database-shaped work-stream proxy.
    const naming = body.title == null
      ? nameWorkstream(
        this.env,
        {
          workspaceId: this.auth.workspaceId,
          workstreamId: receipt.workstream_id,
          userId: this.auth.userId,
          objective,
          openingMessage: annotationCommentText(body.openingMessage,body.annotations),
          provisionalTitle: title,
          useConversationContext: options.initialization?.kind === "history",
          ...((input.descriptionSource ?? "derived") === "derived" ? { provisionalDescription: objective } : {}),
        },
      )
      : options.chooseIcon
        ? chooseWorkstreamIcon(this.env, {
          workspaceId: this.auth.workspaceId,
          workstreamId: receipt.workstream_id,
          userId: this.auth.userId,
          objective,
        })
        : null;
    if (naming) {
      const settled = naming.catch((error: unknown) => {
        logWarn(this.env, "workstream_first_naming_failed", {
          workspace_id: this.auth.workspaceId,
          workstream_id: receipt.workstream_id,
          reason: error instanceof Error ? error.message : "unknown",
        });
      });
      // Deferred naming is off the caller's clock by design, so the trace
      // records which of the two happened rather than a duration that would
      // mean opposite things in the two cases.
      span.setAttributes({ "rally.create.first_naming": this.defer ? "deferred" : "awaited" });
      if (this.defer) this.defer(settled); else await span.step("workstream.create.naming.first_pass", () => settled);
    }
    return created;
  }

  /**
   * Place and reserve the Channel in its Spaces through the one WorkspaceDO
   * call, making General first in the one case that call cannot: a request
   * that named no Space in an Organization that has no General yet. Making
   * General provisions its own conversation, which is not a write the
   * Organization can take inside a transaction, and happens once per
   * Organization.
   */
  private async reserveInSpaces(
    workspace: WorkspaceStub,
    request: WorkspaceChannelReservationRequest,
  ): Promise<{ authorityGeneration: number; spaces: SpaceSummary[]; color?: SpaceColorKey | null | undefined }> {
    let result = WorkspaceChannelReservationResultSchema.parse(await workspace.reserveChannelInSpaces(request));
    if (result.status === "general_missing") {
      const general = await new SpaceService(this.env, this.auth).ensureGeneral();
      result = WorkspaceChannelReservationResultSchema.parse(
        await workspace.reserveChannelInSpaces({ ...request, spaceIds: [general.id] }),
      );
    }
    if (result.status === "reserved") return result;
    if (result.status === "refused") throw spaceRefusal(result.code, "");
    if (result.status === "binding_refused") throw externalBindingRefusal(result.outcome);
    // General was made above, so a second answer that it is missing is the
    // Organization contradicting itself rather than a state to wait out.
    throw new Error("workstream_create_general_space_missing");
  }

  /**
   * The Channel's D1 anchor and regional route. Written `verified` by an
   * ordinary create, which activates it once the conversation is initialized;
   * written `active` by an import reservation, whose child runs first. Both
   * statements ignore an existing row, so an open after a reservation keeps
   * the active route and its activation `UPDATE` still matches it.
   */
  private async writeAnchorAndRoute(
    workstreamId: string,
    generation: number,
    at: string,
    state: "verified" | "active",
  ): Promise<void> {
    await writeRegionalWorkstreamAnchorBatch(
      this.env,
      { workspaceId: this.auth.workspaceId, workstreamId },
      [
        this.env.DB.prepare(
          `INSERT OR IGNORE INTO workstream_authority_routes
             (workspace_id, workstream_id, generation, object_name, state, stage_index,
              source_cursor, source_fence_sequence, source_hash, target_hash,
              row_counts_json, imported_at, verified_at, activated_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 0, 0, 0, 'created_in_do', 'created_in_do',
                   '{}', ?, ?, ?, ?)`,
        ).bind(
          this.auth.workspaceId,
          workstreamId,
          generation,
          `${this.env.AVALON_REGION}:${this.auth.workspaceId}:${workstreamId}`,
          state,
          at,
          at,
          state === "active" ? at : null,
          at,
        ),
      ],
    );
  }

  private receipt(clientMessageId: string): Promise<ReceiptRow | null> {
    return this.env.DB.prepare(
      `SELECT workstream_id, generation, request_hash, state, message_id, harness_run_id
         FROM workstream_create_receipts
        WHERE workspace_id = ? AND creator_user_id = ? AND client_message_id = ?`,
    ).bind(this.auth.workspaceId, this.auth.userId, clientMessageId).first<ReceiptRow>();
  }
}
