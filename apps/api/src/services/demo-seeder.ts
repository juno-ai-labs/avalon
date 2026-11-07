/**
 * The seeder: plays a pack into a workspace through Rally's own write paths.
 *
 * Every seeded fact is written by the production path that writes it for a
 * person, as the cast member who did it. A work stream is created by
 * `WorkstreamObjectCreationService`, a message by the room's own admission
 * through `WorkstreamObjectClient`, a document by `ResourceService.upload` and
 * `attach_resource`, a Sidekick by `createAutomation` and the same
 * `saveDefinition` a drafting conversation publishes through, and an assistant
 * turn by an ordinary harness run whose provider bytes come from the seed
 * instead of OpenRouter. Nothing here writes a transcript row, and none of
 * those paths know they were seeding.
 *
 * Two things this module owns that they do not:
 *
 * - **The order and the outcome.** Actions are applied one at a time, each
 *   confirmed before the next: a run has to settle the way its turn said it
 *   would — `completed` for prose, `needs_input` with a real open elicitation
 *   for a question. Merely ceasing to run is not success, and a failed run
 *   fails the action rather than being skipped past.
 * - **The receipts.** An action is recorded only once it is confirmed, with
 *   every destination id it produced. Preparation resumes from the receipts and
 *   the readiness barrier builds its expectations from them.
 *
 * Applying and settling are separate calls because they are separate waits: a
 * write returns as soon as the object admitted it, and the run it started is
 * driven by the object's own alarm afterwards. The preparation operation calls
 * both inside one step; a test can force the alarm between them.
 *
 * Replaying an action is safe by construction. The client message id of every
 * seeded turn, the resource id of every seeded document and the id of every
 * seeded Sidekick are derived from the operation and the action, so a replay
 * after a crash meets the production path's own receipt for the same request
 * rather than writing it again.
 *
 * `docs/demo-workspaces.md` owns the feature.
 */
import {
  asSpaceId,
  asUserId,
  asWorkspaceId,
  type AutomationDraft,
  type WorkspaceId,
} from "@rally/contracts";

import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import { logInfo } from "../observability/logger";
import { AutomationService, createAutomation } from "./automation-service";
import { demoSeedSummaryGateway } from "./demo-seed-provider";
import { SpaceService } from "./space-service";
import { ResourceService } from "./resource-service";
import { SubstreamCreationService } from "./substream-creation-service";
import { WorkstreamObjectClient } from "./workstream-object-client";
import { WorkstreamObjectCreationService } from "./workstream-object-creation-service";
import {
  planDemoSeed,
  type DemoCast,
  type DemoPack,
  type DemoPackRole,
  type DemoSeedAction,
  type DemoSeedRoomAction,
} from "./demo-pack";

/** Why a seeded run says it exists; the run's `reason` and the create's origin. */
export const DEMO_SEED_REASON = "demo_seed";

export type DemoSeedRunOutcome = "completed" | "needs_input";

/** One confirmed action, as the register records it. */
export interface DemoSeedReceipt {
  operationId: string;
  actionId: string;
  workspaceId: string;
  kind: DemoSeedAction["kind"];
  /** The pack's name for the room, and the work stream it got. Null for a Sidekick. */
  room: string | null;
  workstreamId: string | null;
  /**
   * The pack's name for the substream this wrote to, and the conversation it
   * actually wrote to. `null` and `"0"` for a room's main conversation; both
   * null for a Sidekick, which is in no room and so in no conversation.
   */
  substream: string | null;
  substreamId: string | null;
  /** The Sidekick this action published, and the one run it seeded for it. */
  sidekickId: string | null;
  sidekickRunId: string | null;
  turnId: string | null;
  harnessRunId: string | null;
  runOutcome: DemoSeedRunOutcome | null;
  elicitationId: string | null;
  resourceId: string | null;
  completedAt: string;
}

interface ReceiptRecord {
  operation_id: string;
  action_id: string;
  workspace_id: string;
  kind: DemoSeedAction["kind"];
  room: string | null;
  workstream_id: string | null;
  substream: string | null;
  substream_id: string | null;
  sidekick_id: string | null;
  sidekick_run_id: string | null;
  turn_id: string | null;
  harness_run_id: string | null;
  run_outcome: DemoSeedRunOutcome | null;
  elicitation_id: string | null;
  resource_id: string | null;
  completed_at: string;
}

const RECEIPT_COLUMNS = `operation_id, action_id, workspace_id, kind, room, workstream_id,
  substream, substream_id, sidekick_id, sidekick_run_id, turn_id,
  harness_run_id, run_outcome, elicitation_id, resource_id, completed_at`;

function toReceipt(record: ReceiptRecord): DemoSeedReceipt {
  return {
    operationId: record.operation_id,
    actionId: record.action_id,
    workspaceId: record.workspace_id,
    kind: record.kind,
    room: record.room,
    workstreamId: record.workstream_id,
    substream: record.substream,
    substreamId: record.substream_id,
    sidekickId: record.sidekick_id,
    sidekickRunId: record.sidekick_run_id,
    turnId: record.turn_id,
    harnessRunId: record.harness_run_id,
    runOutcome: record.run_outcome,
    elicitationId: record.elicitation_id,
    resourceId: record.resource_id,
    completedAt: record.completed_at,
  };
}

/** Every confirmed action of one operation, in the order they were confirmed. */
export async function demoSeedReceipts(db: D1Database, operationId: string): Promise<DemoSeedReceipt[]> {
  const rows = await db.prepare(
    `SELECT ${RECEIPT_COLUMNS} FROM demo_seed_receipts WHERE operation_id = ? ORDER BY completed_at, action_id`,
  ).bind(operationId).all<ReceiptRecord>();
  return (rows.results ?? []).map(toReceipt);
}

async function demoSeedReceipt(db: D1Database, operationId: string, actionId: string): Promise<DemoSeedReceipt | null> {
  const row = await db.prepare(
    `SELECT ${RECEIPT_COLUMNS} FROM demo_seed_receipts WHERE operation_id = ? AND action_id = ?`,
  ).bind(operationId, actionId).first<ReceiptRecord>();
  return row ? toReceipt(row) : null;
}

/**
 * Record one confirmed action. Keyed by operation and action, and a second
 * write of the same key keeps the first: the first is the one whose
 * destination ids the barrier has already been handed. Exported for the
 * readiness barrier's tests, which need receipts without a seeded workspace;
 * production writes come only through `applyDemoSeedAction` and
 * `settleDemoSeedAction`.
 */
export async function recordDemoSeedReceipt(db: D1Database, receipt: DemoSeedReceipt): Promise<DemoSeedReceipt> {
  await db.prepare(
    `INSERT INTO demo_seed_receipts (${RECEIPT_COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (operation_id, action_id) DO NOTHING`,
  ).bind(
    receipt.operationId, receipt.actionId, receipt.workspaceId, receipt.kind, receipt.room,
    receipt.workstreamId, receipt.substream, receipt.substreamId,
    receipt.sidekickId, receipt.sidekickRunId, receipt.turnId,
    receipt.harnessRunId, receipt.runOutcome,
    receipt.elicitationId, receipt.resourceId, receipt.completedAt,
  ).run();
  return (await demoSeedReceipt(db, receipt.operationId, receipt.actionId)) ?? receipt;
}

/** The work stream an earlier action created for this room, from its receipt. */
async function roomWorkstreamId(db: D1Database, operationId: string, room: string): Promise<string> {
  const row = await db.prepare(
    `SELECT workstream_id FROM demo_seed_receipts
      WHERE operation_id = ? AND room = ? AND kind = 'create_workstream'`,
  ).bind(operationId, room).first<{ workstream_id: string }>();
  if (!row) throw new ApiError(409, "demo_seed_room_not_created", `Room "${room}" has not been created yet`);
  return row.workstream_id;
}

/**
 * Where an action writes: the work stream, and the conversation inside it.
 *
 * Both come from earlier receipts rather than from the plan, because both are
 * ids the platform minted. A pack names its room and its substream; the create
 * that ran first is what turns those names into the pair every later action
 * addresses.
 */
async function actionConversation(
  db: D1Database,
  operationId: string,
  action: DemoSeedRoomAction,
): Promise<{ workstreamId: string; substreamId: string }> {
  const workstreamId = await roomWorkstreamId(db, operationId, action.room);
  if (action.substream === null) return { workstreamId, substreamId: "0" };
  const row = await db.prepare(
    `SELECT substream_id FROM demo_seed_receipts
      WHERE operation_id = ? AND room = ? AND substream = ? AND kind = 'create_substream'`,
  ).bind(operationId, action.room, action.substream).first<{ substream_id: string }>();
  if (!row) {
    throw new ApiError(409, "demo_seed_substream_not_created", `Substream "${action.substream}" has not been created yet`);
  }
  return { workstreamId, substreamId: row.substream_id };
}

/**
 * The client message id of a seeded turn: the operation and the action, and
 * nothing that changes between attempts. The production path dedupes a create
 * and a message on it, which is what makes replaying an action safe.
 */
export function demoSeedClientMessageId(operationId: string, actionId: string): string {
  return `${operationId}:${actionId}`;
}

/**
 * The ids a seeded substream's creation is keyed by.
 *
 * Creation is a parent-owned operation and adding each participant is another,
 * and both resume rather than repeat when the operation id comes back the same.
 * Deriving them from the demo operation and the action is what makes an
 * interrupted `create_substream` finish the child it started instead of opening
 * a second one beside it. 180 characters is what the parent allows; a UUID
 * operation id, an 80-character action id and a UUID member fit.
 */
function demoSeedSubstreamOperationId(operationId: string, actionId: string): string {
  return `demo-seed-substream:${operationId}:${actionId}`;
}
function demoSeedSubstreamMemberOperationId(operationId: string, actionId: string, userId: string): string {
  return `demo-seed-member:${operationId}:${actionId}:${userId}`;
}

/**
 * An id derived from the operation and the action rather than minted: a UUID
 * whose bits come from a hash of the two (RFC 9562 version 8, the custom-bits
 * version). A replayed action asks the production path for the same id it asked
 * for the first time, and meets that path's own receipt instead of writing a
 * second object. `purpose` keeps two kinds of object made by one action — a
 * document and a Sidekick — from colliding on one id.
 */
async function demoSeedDerivedId(purpose: string, operationId: string, actionId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`demo-seed-${purpose} ${operationId} ${actionId}`),
  ));
  digest[6] = (digest[6]! & 0x0f) | 0x80;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = [...digest.subarray(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** A stable Space identity lets interrupted preparation resume without creating duplicates. */
export async function demoSeedSpaceId(operationId: string, key: string) {
  return asSpaceId(await demoSeedDerivedId("space", operationId, key));
}

/** The resource id of a seeded document, so a replayed upload attaches the draft it already made. */
export function demoSeedResourceId(operationId: string, actionId: string): Promise<string> {
  return demoSeedDerivedId("resource", operationId, actionId);
}

/**
 * The id of a seeded Sidekick, so a replayed publication meets the object that
 * already exists: `createAutomation` answers `created: false` for it, and the
 * definition is submitted against the Sidekick the first attempt made.
 */
export function demoSeedSidekickId(operationId: string, actionId: string): Promise<string> {
  return demoSeedDerivedId("sidekick", operationId, actionId);
}

/** One demo's worth of seeding: the pack, who plays whom, and how they act. */
export interface DemoSeedSession {
  operationId: string;
  workspaceId: WorkspaceId;
  pack: DemoPack;
  cast: DemoCast;
  /** The actions in pack order, already bound to the cast. */
  actions: DemoSeedAction[];
  /** How each cast member acts: a membership-verified, session-less authority. */
  auth: ReadonlyMap<string, AuthContext>;
}

/**
 * Bind a pack's roles to workspace members and resolve how each one acts.
 *
 * A cast member acts under the `demo_seed` principal: no session, because the
 * cast never signs in, and the object verifies their current membership
 * instead — the same verification a connector ingress gets. Every bound member
 * must already be an active member of the workspace, with the name the
 * directory will validate a mention's visible text against; a role bound to
 * anybody else is refused here, before the first write.
 */
export async function openDemoSeedSession(env: Env, input: {
  operationId: string;
  workspaceId: string;
  pack: DemoPack;
  roles: Readonly<Record<DemoPackRole, string>>;
}): Promise<DemoSeedSession> {
  const cast: Record<string, DemoCast[string]> = {};
  const auth = new Map<string, AuthContext>();
  for (const role of input.pack.roles) {
    const userId = input.roles[role];
    if (!userId) throw new ApiError(422, "demo_pack_role_unbound", `Nobody is cast as "${role}"`);
    const member = await demoMemberAuth(env, {
      operationId: input.operationId,
      workspaceId: input.workspaceId,
      userId,
    });
    if (!member) {
      throw new ApiError(409, "demo_cast_not_member", `The member cast as "${role}" is not an active member of the workspace`);
    }
    cast[role] = { userId, displayName: member.displayName };
    auth.set(userId, member.auth);
  }
  return {
    operationId: input.operationId,
    workspaceId: asWorkspaceId(input.workspaceId),
    pack: input.pack,
    cast,
    actions: planDemoSeed(input.pack, cast),
    auth,
  };
}

/**
 * How the seeder — and the readiness barrier after it — acts as one member.
 *
 * Under the `demo_seed` principal: no session, because the cast never signs
 * in, and the object verifies current membership instead. The role has to be
 * the one D1 holds, because the object compares them. `null` when the person
 * is not an active member here, which the caller turns into its own refusal.
 */
export async function demoMemberAuth(env: Env, input: {
  operationId: string;
  workspaceId: string;
  userId: string;
}): Promise<{ auth: AuthContext; displayName: string } | null> {
  const member = await env.DB.prepare(
    `SELECT member.role AS role, user.name AS name
       FROM workspace_members member JOIN users user ON user.id = member.user_id
      WHERE member.workspace_id = ? AND member.user_id = ? AND member.status = 'active'`,
  ).bind(input.workspaceId, input.userId).first<{ role: "owner" | "admin" | "member"; name: string }>();
  if (!member) return null;
  return {
    displayName: member.name,
    auth: {
      sessionId: `demo-seed:${input.operationId}`,
      userId: asUserId(input.userId),
      workspaceId: asWorkspaceId(input.workspaceId),
      region: env.AVALON_REGION,
      role: member.role,
      principal: "demo_seed",
    },
  };
}

/** What `applyDemoSeedAction` leaves for `settleDemoSeedAction` to confirm. */
export type DemoSeedProgress =
  | { state: "confirmed"; receipt: DemoSeedReceipt }
  | {
      state: "run_pending";
      action: Extract<DemoSeedAction, { kind: "create_workstream" | "message" }>;
      workstreamId: string;
      /** The conversation the run belongs to; `"0"` for a room's main one. */
      substreamId: string;
      turnId: string;
      /** When the trigger turn was admitted; the run it started is created after it. */
      turnCreatedAt: string;
      /** Known for an opening run; a message-started run's id is minted at activation. */
      harnessRunId: string | null;
    }
  | {
      /** A published Sidekick whose one seeded run has been admitted but has not finished. */
      state: "sidekick_run_pending";
      action: Extract<DemoSeedAction, { kind: "sidekick" }>;
      sidekickId: string;
      /** The Sidekick's own run id, which the object hands back at admission. */
      sidekickRunId: string;
    };

function actorAuth(session: DemoSeedSession, action: DemoSeedAction): AuthContext {
  const auth = session.auth.get(action.actorUserId);
  if (!auth) throw new ApiError(409, "demo_seed_actor_unbound", "The action's actor is not in the cast");
  return auth;
}

/**
 * Apply one action through the production path it belongs to.
 *
 * Returns at once for an action that is confirmed by its own write — a message
 * that starts no run, an upload — and leaves a run-starting action pending
 * for `settleDemoSeedAction`. An action already recorded is returned as it
 * was recorded, without touching the workspace.
 */
export async function applyDemoSeedAction(
  env: Env,
  session: DemoSeedSession,
  action: DemoSeedAction,
): Promise<DemoSeedProgress> {
  const recorded = await demoSeedReceipt(env.DB, session.operationId, action.actionId);
  if (recorded) return { state: "confirmed", receipt: recorded };
  const auth = actorAuth(session, action);
  const clientMessageId = demoSeedClientMessageId(session.operationId, action.actionId);
  switch (action.kind) {
    case "create_workstream": {
      // A `personal` room has not been seeded and checked for readiness end
      // to end since a Space stopped granting its audience, so it is refused
      // rather than seeded unproven; `docs/demo-workspaces.md` says why.
      if (action.scope === "personal") throw new Error("demo_seed_personal_room_unsupported");
      const space = action.space ? session.pack.spaces?.[action.space] : undefined;
      const spaceIds = [];
      if (space && action.space) {
        const creator = session.cast[space.as]!;
        const spaceAuth = session.auth.get(creator.userId)!;
        const createdSpace = await new SpaceService(env, spaceAuth).create({
          name: space.name, iconKey: space.iconKey, colorKey: space.colorKey, scope: "workspace",
        }, await demoSeedSpaceId(session.operationId, action.space));
        spaceIds.push(createdSpace.id);
      }
      if (action.execution === "history") {
        if (action.seed.assistant?.kind !== "say") throw new Error("prepared_demo_requires_text");
        const conversation = { messages: [
          { role: "user" as const, text: action.openingMessage },
          { role: "assistant" as const, text: action.seed.assistant.text },
        ] };
        const created = await new WorkstreamObjectCreationService(env, auth).createPrepared({
          title: action.title, clientMessageId, participantUserIds: action.participantUserIds,
          descriptionSource: "authored", scope: action.scope, spaceIds,
        }, conversation, { reason: DEMO_SEED_REASON, notifyParticipants: false });
        const boot = await new WorkstreamObjectClient(env, auth, created.workstream.id).boot();
        const turns = boot.transcript.ranges.flatMap((range) => range.turns);
        if (turns.length !== conversation.messages.length || turns.some((turn, index) =>
          turn.actor !== (conversation.messages[index]?.role === "user" ? "human" : "assistant")
          || turn.blocks.filter((block) => block.type === "text").map((block) => block.text).join("") !== conversation.messages[index]?.text)) {
          throw new Error("prepared_demo_transcript_mismatch");
        }
        return { state: "confirmed", receipt: await confirm(env, session, action, {
          workstreamId: created.workstream.id, substreamId: "0", turnId: created.turnId,
        }) };
      }
      const created = await new WorkstreamObjectCreationService(env, auth).create({
        title: action.title,
        openingMessage: action.openingMessage,
        mentions: action.mentions,
        clientMessageId,
        participantUserIds: action.participantUserIds,
        attachmentIds: [],
        spaceIds,
        descriptionSource: "authored",
        scope: action.scope,
      }, {
        reason: DEMO_SEED_REASON,
        notifyParticipants: false,
        seed: action.seed,
      });
      return {
        state: "run_pending",
        action,
        workstreamId: created.workstream.id,
        substreamId: "0",
        turnId: created.turnId,
        turnCreatedAt: created.workstream.createdAt,
        harnessRunId: created.harnessRunId,
      };
    }
    case "create_substream": {
      const workstreamId = await roomWorkstreamId(env.DB, session.operationId, action.room);
      const operationId = demoSeedSubstreamOperationId(session.operationId, action.actionId);
      // The production flow exactly: prepare freezes the parent conversation
      // and resolves the starting context, confirm provisions the child and
      // installs it. The one substitution is where the context's prose comes
      // from — the pack, not a model — and it is passed in rather than decided
      // here, so nothing about creation branches on this being a demo. No
      // deferral, because seeding has no request to hand the naming pass off
      // to and no opening message to run one over anyway.
      const service = new SubstreamCreationService(env, auth, undefined, demoSeedSummaryGateway(action.startingContext));
      await service.prepare(workstreamId, { operationId, title: action.title, throughTurnId: null });
      // No opening message: the pack says what is said in the child as its own
      // `message` steps, so the child opens on the starting context alone and
      // keeps the title the pack reserved for it.
      const { substreamId } = await service.confirm(workstreamId, operationId);
      // A substream opens creator-only, so the pack's roster is one add each,
      // by the creator, who is the only participant there is to make them.
      for (const userId of action.participantUserIds) {
        await service.changeParticipant(workstreamId, substreamId, {
          userId,
          operationId: demoSeedSubstreamMemberOperationId(session.operationId, action.actionId, userId),
        }, true);
      }
      return { state: "confirmed", receipt: await confirm(env, session, action, {
        workstreamId,
        substreamId,
      }) };
    }
    case "message": {
      const { workstreamId, substreamId } = await actionConversation(env.DB, session.operationId, action);
      const admitted = await new WorkstreamObjectClient(env, auth, workstreamId, substreamId).createMessage({
        text: action.text,
        clientMessageId,
        mentions: action.mentions,
        confirmedParticipantUserIds: action.confirmedParticipantUserIds,
        attachmentIds: [],
        seed: action.seed,
      });
      if (action.seed.assistant !== null) {
        return {
          state: "run_pending",
          action,
          workstreamId,
          substreamId,
          turnId: admitted.turn.turnId,
          turnCreatedAt: admitted.turn.createdAt,
          harnessRunId: null,
        };
      }
      return { state: "confirmed", receipt: await confirm(env, session, action, {
        workstreamId,
        substreamId,
        turnId: admitted.turn.turnId,
      }) };
    }
    case "upload": {
      const { workstreamId, substreamId } = await actionConversation(env.DB, session.operationId, action);
      const resourceId = await demoSeedResourceId(session.operationId, action.actionId);
      const file = new File([action.content], action.fileName, { type: action.mimeType });
      try {
        await new ResourceService(env, auth).upload(file, action.title, resourceId);
      } catch (error) {
        // The draft this id names already exists: an earlier attempt uploaded
        // it and was interrupted before message admission or recording.
        // Replay the same admission below; its client ID prevents a second turn.
        if (!(error instanceof ApiError && error.code === "attachment_draft_exists")) throw error;
      }
      // Uploads enter a conversation through ordinary message admission, which
      // reserves the author's draft and commits its attachment with the turn.
      // Bypassing this with attachResource would leave an unclaimed draft that
      // can be deleted or reaped independently of the conversation.
      const admitted = await new WorkstreamObjectClient(env, auth, workstreamId, substreamId).createMessage({
        text: "",
        clientMessageId,
        mentions: [],
        confirmedParticipantUserIds: [],
        attachmentIds: [resourceId],
        seed: { packVersion: session.pack.version, actionId: action.actionId, assistant: null },
      });
      return { state: "confirmed", receipt: await confirm(env, session, action, {
        workstreamId,
        substreamId,
        resourceId,
        turnId: admitted.turn.turnId,
      }) };
    }
    case "sidekick": {
      const sidekickId = await demoSeedSidekickId(session.operationId, action.actionId);
      await createAutomation(env, {
        workspaceId: session.workspaceId,
        authorUserId: action.actorUserId,
        scope: action.scope,
        automationId: sidekickId,
        // The operator-authored demo plays this creation as its cast member,
        // including creator opt-in, before starting the scripted briefing.
      });
      const service = new AutomationService(env, auth);
      // Publishes as well as records: `saveDefinition` applies a ready
      // definition, which is what arms the schedule and puts the row in the
      // directory. A replay writes an identical second revision and applies
      // that, which lands on the same accepted state rather than a different
      // one; `create` above has already answered `created: false` for it.
      const { ready } = await service.saveDefinition(sidekickId, {
        draft: sidekickDraft(action),
        evaluatorRules: null,
        submittedByRunId: null,
      });
      if (!ready) {
        throw new ApiError(409, "demo_seed_sidekick_not_published", `The Sidekick for "${action.actionId}" was not published`);
      }
      if (action.firstRun === null) {
        return { state: "confirmed", receipt: await confirm(env, session, action, { sidekickId }) };
      }
      const admitted = await service.runSeeded(sidekickId, action.firstRun);
      return {
        state: "sidekick_run_pending",
        action,
        sidekickId,
        sidekickRunId: admitted.runId,
      };
    }
  }
}

/**
 * The definition a Sidekick step publishes.
 *
 * Written here rather than in the pack because most of it is the same for every
 * seeded Sidekick and none of it is a product decision: no connector is bound,
 * no memory table is declared, and the only trigger is the pack's own schedule.
 * `ready` is true because a demo publishes what it seeds — an unready draft
 * would leave a Sidekick in the library that never runs and never appears in
 * the strip.
 */
function sidekickDraft(action: Extract<DemoSeedAction, { kind: "sidekick" }>): AutomationDraft {
  return {
    name: action.definition.name,
    description: action.definition.description,
    overview: action.definition.overview,
    instructions: action.definition.instructions,
    definitionVersion: 2,
    triggers: [{
      type: "calendar",
      rrule: action.schedule.rrule,
      timezone: action.schedule.timezone,
      summary: action.schedule.summary,
    }],
    requiredCapabilities: [],
    expectedOutputs: [],
    defaultBehavior: {},
    recommendedPlugins: [],
    memoryTables: [],
    customTools: [],
    suggestedScope: action.scope,
    followUpQuestion: null,
    elicitation: null,
    ready: true,
  };
}

async function confirm(
  env: Env,
  session: DemoSeedSession,
  action: DemoSeedAction,
  outcome: {
    workstreamId?: string;
    substreamId?: string;
    sidekickId?: string;
    sidekickRunId?: string;
    turnId?: string;
    harnessRunId?: string;
    runOutcome?: DemoSeedRunOutcome;
    elicitationId?: string;
    resourceId?: string;
  },
): Promise<DemoSeedReceipt> {
  const receipt = await recordDemoSeedReceipt(env.DB, {
    operationId: session.operationId,
    actionId: action.actionId,
    workspaceId: session.workspaceId,
    kind: action.kind,
    room: action.kind === "sidekick" ? null : action.room,
    workstreamId: outcome.workstreamId ?? null,
    substream: action.kind === "sidekick" ? null : action.substream,
    substreamId: outcome.substreamId ?? null,
    sidekickId: outcome.sidekickId ?? null,
    sidekickRunId: outcome.sidekickRunId ?? null,
    turnId: outcome.turnId ?? null,
    harnessRunId: outcome.harnessRunId ?? null,
    runOutcome: outcome.runOutcome ?? null,
    elicitationId: outcome.elicitationId ?? null,
    resourceId: outcome.resourceId ?? null,
    completedAt: new Date().toISOString(),
  });
  logInfo(env, "demo_seed_action_confirmed", {
    operation_id: session.operationId,
    action_id: action.actionId,
    workspace_id: session.workspaceId,
    workstream_id: outcome.workstreamId ?? null,
    substream_id: outcome.substreamId ?? null,
    sidekick_id: outcome.sidekickId ?? null,
    kind: action.kind,
    run_outcome: outcome.runOutcome ?? null,
  });
  return receipt;
}

const SETTLE_POLL_INTERVAL_MS = 250;

/**
 * Wait for a pending action's run to reach the outcome its turn specified,
 * then record it.
 *
 * Read as the actor, never as anyone whose unopened state the pack preserves:
 * a detail read settles `first_opened_at` for whoever asks. The run is
 * recognised by id when the create handed one back, and otherwise as the
 * room's latest run created after the trigger turn — the seeder is the room's
 * only writer, so there is no other run it could be.
 *
 * `deadlineAt` is the caller's; this module sets no ceiling of its own. In
 * production none is passed: the poll is bounded by the driver's step, whose
 * timeout the driver records on the operation as a failure the operator can
 * retry, and by the run itself, which the harness fails or stops on its own
 * ceilings — either way the loop ends with a named outcome, not a number
 * guessed here.
 */
export async function settleDemoSeedAction(
  env: Env,
  session: DemoSeedSession,
  progress: DemoSeedProgress,
  options: { deadlineAt?: number } = {},
): Promise<DemoSeedReceipt> {
  if (progress.state === "confirmed") return progress.receipt;
  if (progress.state === "sidekick_run_pending") return settleSeededSidekickRun(env, session, progress, options);
  const { action } = progress;
  const expected: DemoSeedRunOutcome = action.seed.assistant?.kind === "ask" ? "needs_input" : "completed";
  const client = new WorkstreamObjectClient(env, actorAuth(session, action), progress.workstreamId, progress.substreamId);
  for (;;) {
    const detail = await client.get();
    const run = detail.latestHarnessRun ?? null;
    const ours = run !== null && (progress.harnessRunId !== null
      ? run.id === progress.harnessRunId
      : Date.parse(run.createdAt) >= Date.parse(progress.turnCreatedAt));
    if (ours && (run.status === "failed" || run.status === "stopped")) {
      throw new ApiError(
        409,
        "demo_seed_run_failed",
        `The run for "${action.actionId}" ${run.status}${run.error ? ` (${run.error.code})` : ""}`,
      );
    }
    if (ours && (run.status === "completed" || run.status === "needs_input")) {
      if (run.status !== expected) {
        throw new ApiError(
          409,
          "demo_seed_run_outcome_mismatch",
          `The run for "${action.actionId}" settled as ${run.status}, not ${expected}`,
        );
      }
      const elicitation = expected === "needs_input"
        ? detail.openElicitations.find((open) => open.harnessRunId === run.id) ?? null
        : null;
      if (expected === "needs_input" && !elicitation) {
        throw new ApiError(
          409,
          "demo_seed_elicitation_missing",
          `The run for "${action.actionId}" is waiting for input but opened no question`,
        );
      }
      return confirm(env, session, action, {
        workstreamId: progress.workstreamId,
        substreamId: progress.substreamId,
        turnId: progress.turnId,
        harnessRunId: run.id,
        runOutcome: run.status,
        ...(elicitation ? { elicitationId: elicitation.id } : {}),
      });
    }
    if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
      throw new ApiError(
        409,
        "demo_seed_run_unsettled",
        `The run for "${action.actionId}" has not settled (${run ? run.status : "not started"})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_INTERVAL_MS));
  }
}

/**
 * Wait for a seeded Sidekick's one briefing to finish, then record it.
 *
 * The same shape as a room's settlement, and read the same way: from the run's
 * own conversation, which is a child substream under the Sidekick admitting
 * only the person it runs as. Not from the Sidekick's run history — that row is
 * a projection of this conversation, delivered afterwards through the effect
 * Queue, so waiting on it here would make seeding wait for a hop that is the
 * readiness barrier's to wait for, and would report "still running" for a run
 * that had already finished.
 *
 * `completed` is the only success. A briefing is a `say`, so there is no other
 * outcome to accept: `needs_input` would mean the run opened a question in a
 * conversation the demo never shows anybody, and a failed or stopped run fails
 * the action rather than being skipped past.
 */
async function settleSeededSidekickRun(
  env: Env,
  session: DemoSeedSession,
  progress: Extract<DemoSeedProgress, { state: "sidekick_run_pending" }>,
  options: { deadlineAt?: number },
): Promise<DemoSeedReceipt> {
  const { action } = progress;
  // A Sidekick's run conversation, addressed as the Sidekick's: the parent is
  // an automation, and a product request that said `workstream` is refused.
  const conversation = WorkstreamObjectClient.forParent(
    env,
    actorAuth(session, action),
    "automation",
    progress.sidekickId,
    progress.sidekickRunId,
  );
  for (;;) {
    // The conversation does not exist yet at the first ask. A Sidekick admits
    // an occurrence and provisions its run's conversation on its own alarm
    // afterwards, so "not there" is a stage of starting rather than a failure,
    // and the deadline below is what ends the wait if it never arrives.
    const run = await conversationRunOrNull(conversation);
    if (run && (run.status === "failed" || run.status === "stopped")) {
      throw new ApiError(
        409,
        "demo_seed_sidekick_run_failed",
        `The seeded run for "${action.actionId}" ${run.status}${run.error ? ` (${run.error.code})` : ""}`,
      );
    }
    if (run && (run.status === "completed" || run.status === "needs_input")) {
      if (run.status !== "completed") {
        throw new ApiError(
          409,
          "demo_seed_sidekick_run_outcome_mismatch",
          `The seeded run for "${action.actionId}" settled as ${run.status}, not completed`,
        );
      }
      return confirm(env, session, action, {
        sidekickId: progress.sidekickId,
        sidekickRunId: progress.sidekickRunId,
        runOutcome: "completed",
      });
    }
    if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
      throw new ApiError(
        409,
        "demo_seed_sidekick_run_unsettled",
        `The seeded run for "${action.actionId}" has not settled (${run ? run.status : "not started"})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_INTERVAL_MS));
  }
}

/** The run a conversation is on, or null while that conversation is still being provisioned. */
async function conversationRunOrNull(
  conversation: WorkstreamObjectClient,
): Promise<Awaited<ReturnType<WorkstreamObjectClient["get"]>>["latestHarnessRun"]> {
  try {
    return (await conversation.get()).latestHarnessRun ?? null;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}
