/**
 * The seeder: plays a pack into a workspace through Rally's own write paths.
 *
 * Every seeded fact is written by the production path that writes it for a
 * person, as the cast member who did it. A work stream is created by
 * `WorkstreamObjectCreationService`, a message by the room's own admission
 * through `WorkstreamObjectClient`, a document by `ResourceService.upload` and
 * `attach_resource`, and an assistant turn by an ordinary harness run whose
 * provider bytes come from the seed instead of OpenRouter. Nothing here writes
 * a transcript row, and none of those paths know they were seeding.
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
 * seeded turn and the resource id of every seeded document are derived from the
 * operation and the action, so a replay after a crash meets the production
 * path's own receipt for the same request rather than writing it again.
 *
 * `docs/demo-workspaces.md` owns the feature.
 */
import {
  asUserId,
  asWorkspaceId,
  type WorkspaceId,
} from "@rally/contracts";

import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import { logInfo } from "../observability/logger";
import { ResourceService } from "./resource-service";
import { WorkstreamObjectClient } from "./workstream-object-client";
import { WorkstreamObjectCreationService } from "./workstream-object-creation-service";
import { planDemoSeed, type DemoCast, type DemoPack, type DemoPackRole, type DemoSeedAction } from "./demo-pack";

/** Why a seeded run says it exists; the run's `reason` and the create's origin. */
export const DEMO_SEED_REASON = "demo_seed";

export type DemoSeedRunOutcome = "completed" | "needs_input";

/** One confirmed action, as the register records it. */
export interface DemoSeedReceipt {
  operationId: string;
  actionId: string;
  workspaceId: string;
  kind: DemoSeedAction["kind"];
  room: string;
  workstreamId: string;
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
  room: string;
  workstream_id: string;
  turn_id: string | null;
  harness_run_id: string | null;
  run_outcome: DemoSeedRunOutcome | null;
  elicitation_id: string | null;
  resource_id: string | null;
  completed_at: string;
}

const RECEIPT_COLUMNS = `operation_id, action_id, workspace_id, kind, room, workstream_id, turn_id,
  harness_run_id, run_outcome, elicitation_id, resource_id, completed_at`;

function toReceipt(record: ReceiptRecord): DemoSeedReceipt {
  return {
    operationId: record.operation_id,
    actionId: record.action_id,
    workspaceId: record.workspace_id,
    kind: record.kind,
    room: record.room,
    workstreamId: record.workstream_id,
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
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (operation_id, action_id) DO NOTHING`,
  ).bind(
    receipt.operationId, receipt.actionId, receipt.workspaceId, receipt.kind, receipt.room,
    receipt.workstreamId, receipt.turnId, receipt.harnessRunId, receipt.runOutcome,
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
 * The client message id of a seeded turn: the operation and the action, and
 * nothing that changes between attempts. The production path dedupes a create
 * and a message on it, which is what makes replaying an action safe.
 */
export function demoSeedClientMessageId(operationId: string, actionId: string): string {
  return `${operationId}:${actionId}`;
}

/**
 * The resource id of a seeded document, derived the same way: a UUID whose
 * bits come from a hash of the operation and action (RFC 9562 version 8, the
 * custom-bits version), so a replayed upload asks for the draft that already
 * exists rather than minting a second document.
 */
export async function demoSeedResourceId(operationId: string, actionId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`demo-seed-resource ${operationId} ${actionId}`),
  ));
  digest[6] = (digest[6]! & 0x0f) | 0x80;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = [...digest.subarray(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
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
      turnId: string;
      /** When the trigger turn was admitted; the run it started is created after it. */
      turnCreatedAt: string;
      /** Known for an opening run; a message-started run's id is minted at activation. */
      harnessRunId: string | null;
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
      const created = await new WorkstreamObjectCreationService(env, auth).create({
        title: action.title,
        openingMessage: action.openingMessage,
        mentions: action.mentions,
        clientMessageId,
        participantUserIds: action.participantUserIds,
        attachmentIds: [],
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
        turnId: created.turnId,
        turnCreatedAt: created.workstream.createdAt,
        harnessRunId: created.harnessRunId,
      };
    }
    case "message": {
      const workstreamId = await roomWorkstreamId(env.DB, session.operationId, action.room);
      const admitted = await new WorkstreamObjectClient(env, auth, workstreamId, "0").createMessage({
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
          turnId: admitted.turn.turnId,
          turnCreatedAt: admitted.turn.createdAt,
          harnessRunId: null,
        };
      }
      return { state: "confirmed", receipt: await confirm(env, session, action, {
        workstreamId,
        turnId: admitted.turn.turnId,
      }) };
    }
    case "upload": {
      const workstreamId = await roomWorkstreamId(env.DB, session.operationId, action.room);
      const resourceId = await demoSeedResourceId(session.operationId, action.actionId);
      const file = new File([action.content], action.fileName, { type: action.mimeType });
      try {
        await new ResourceService(env, auth).upload(file, action.title, resourceId);
      } catch (error) {
        // The draft this id names already exists: an earlier attempt uploaded
        // it and was interrupted before attaching or recording. Attach it.
        if (!(error instanceof ApiError && error.code === "attachment_draft_exists")) throw error;
      }
      await new WorkstreamObjectClient(env, auth, workstreamId, "0").attachResource(resourceId);
      return { state: "confirmed", receipt: await confirm(env, session, action, { workstreamId, resourceId }) };
    }
  }
}

async function confirm(
  env: Env,
  session: DemoSeedSession,
  action: DemoSeedAction,
  outcome: {
    workstreamId: string;
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
    room: action.room,
    workstreamId: outcome.workstreamId,
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
    workstream_id: outcome.workstreamId,
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
  const { action } = progress;
  const expected: DemoSeedRunOutcome = action.seed.assistant?.kind === "ask" ? "needs_input" : "completed";
  const client = new WorkstreamObjectClient(env, actorAuth(session, action), progress.workstreamId, "0");
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
