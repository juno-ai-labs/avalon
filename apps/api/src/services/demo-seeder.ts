/**
 * The seeder: plays a pack into a workspace through Rally's own write paths.
 *
 * Every seeded fact is written by the production path that writes it for a
 * person, as the cast member who did it. A Canvas is made by
 * `CanvasService.create` and shared by `CanvasService.setAudience`; a message
 * in its Chat or in a Sidekick's shared conversation is admitted by
 * `ConversationService.writableClient`, the conversation route's own
 * admission; a document a person attaches by `ResourceService.upload` and the
 * message that commits it; a version of a Canvas's artifact by the Terminal's
 * resource bridge, the path `publish_resource` takes, attributed to the run
 * that said it; a Sidekick by `createAutomation`, the same `saveDefinition` a
 * drafting conversation publishes through and `setAudience`; and an assistant
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
 * seeded turn, the id of every seeded Canvas, document and Sidekick, and the
 * receipt of every seeded publish are derived from the operation and the
 * action, so a replay after a crash meets the production path's own receipt
 * for the same request rather than writing it again.
 *
 * `docs/demo-workspaces.md` owns the feature.
 */
import {
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  type AutomationDraft,
  type DemoSeed,
  type WorkspaceId,
} from "@rally/contracts";

import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import { logInfo } from "../observability/logger";
import { AutomationService, createAutomation } from "./automation-service";
import { CanvasService } from "./canvas-service";
import { ConversationService } from "./conversation-service";
import { ResourceService } from "./resource-service";
import { canvasArtifactNoter, resolveTerminalPublicationHome } from "./terminal/authority";
import { createTerminalPortFactory } from "./terminal/object-port";
import { createTerminalResourceBridge } from "./terminal/resource-bridge";
import { attachWorkstreamRuntimeResource, WorkstreamObjectClient } from "./workstream-object-client";
import { withWorkspaceRuntimeDatabase } from "./workspace-runtime-database";
import {
  planDemoSeed,
  type DemoCast,
  type DemoPack,
  type DemoPackRole,
  type DemoSeedAction,
  type DemoSeedAudience,
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
  /**
   * The pack's name for the Canvas this action wrote, and the Canvas it got.
   * A Sidekick that wrote a Canvas records that Canvas's id here too.
   */
  canvas: string | null;
  canvasId: string | null;
  /** The pack's name for the Sidekick, the Sidekick, and the one run it seeded for it. */
  sidekick: string | null;
  sidekickId: string | null;
  sidekickRunId: string | null;
  /** The person's turn this action wrote. */
  turnId: string | null;
  /** The run the turn started, or the run a publish is attributed to, and how a started run settled. */
  harnessRunId: string | null;
  runOutcome: DemoSeedRunOutcome | null;
  elicitationId: string | null;
  /** The document an upload attached or a publish wrote. */
  resourceId: string | null;
  completedAt: string;
}

interface ReceiptRecord {
  operation_id: string;
  action_id: string;
  workspace_id: string;
  kind: DemoSeedAction["kind"];
  canvas: string | null;
  canvas_id: string | null;
  sidekick: string | null;
  sidekick_id: string | null;
  sidekick_run_id: string | null;
  turn_id: string | null;
  harness_run_id: string | null;
  run_outcome: DemoSeedRunOutcome | null;
  elicitation_id: string | null;
  resource_id: string | null;
  completed_at: string;
}

const RECEIPT_COLUMNS = `operation_id, action_id, workspace_id, kind, canvas, canvas_id,
  sidekick, sidekick_id, sidekick_run_id, turn_id, harness_run_id, run_outcome,
  elicitation_id, resource_id, completed_at`;

function toReceipt(record: ReceiptRecord): DemoSeedReceipt {
  return {
    operationId: record.operation_id,
    actionId: record.action_id,
    workspaceId: record.workspace_id,
    kind: record.kind,
    canvas: record.canvas,
    canvasId: record.canvas_id,
    sidekick: record.sidekick,
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
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (operation_id, action_id) DO NOTHING`,
  ).bind(
    receipt.operationId, receipt.actionId, receipt.workspaceId, receipt.kind,
    receipt.canvas, receipt.canvasId, receipt.sidekick, receipt.sidekickId, receipt.sidekickRunId,
    receipt.turnId, receipt.harnessRunId, receipt.runOutcome, receipt.elicitationId,
    receipt.resourceId, receipt.completedAt,
  ).run();
  return (await demoSeedReceipt(db, receipt.operationId, receipt.actionId)) ?? receipt;
}

/** The Canvas an earlier action made under this pack name, from its receipt. */
async function canvasIdFor(db: D1Database, operationId: string, canvas: string): Promise<string> {
  const row = await db.prepare(
    `SELECT canvas_id FROM demo_seed_receipts WHERE operation_id = ? AND canvas = ? AND kind = 'create_canvas'`,
  ).bind(operationId, canvas).first<{ canvas_id: string }>();
  if (!row) throw new ApiError(409, "demo_seed_canvas_not_created", `Canvas "${canvas}" has not been made yet`);
  return row.canvas_id;
}

/** The Sidekick an earlier action published under this pack name, from its receipt. */
async function sidekickIdFor(db: D1Database, operationId: string, sidekick: string): Promise<string> {
  const row = await db.prepare(
    `SELECT sidekick_id FROM demo_seed_receipts WHERE operation_id = ? AND sidekick = ? AND kind = 'sidekick'`,
  ).bind(operationId, sidekick).first<{ sidekick_id: string }>();
  if (!row) throw new ApiError(409, "demo_seed_sidekick_not_published", `Sidekick "${sidekick}" has not been published yet`);
  return row.sidekick_id;
}

/** The latest seeded run in a Canvas's Chat, which a `canvas_artifact` is attributed to. */
async function latestCanvasRunId(db: D1Database, operationId: string, canvas: string): Promise<string> {
  const row = await db.prepare(
    `SELECT harness_run_id FROM demo_seed_receipts
      WHERE operation_id = ? AND canvas = ? AND kind IN ('create_canvas', 'canvas_message') AND harness_run_id IS NOT NULL
      ORDER BY completed_at DESC, action_id DESC LIMIT 1`,
  ).bind(operationId, canvas).first<{ harness_run_id: string }>();
  if (!row) throw new ApiError(409, "demo_seed_canvas_never_ran", `Rally has not run in Canvas "${canvas}"`);
  return row.harness_run_id;
}

/**
 * The client message id of a seeded turn: the operation and the action, and
 * nothing that changes between attempts. The production path dedupes a
 * message on it, which is what makes replaying an action safe.
 */
export function demoSeedClientMessageId(operationId: string, actionId: string): string {
  return `${operationId}:${actionId}`;
}

/**
 * An id derived from the operation and the action rather than minted: a UUID
 * whose bits come from a hash of the two (RFC 9562 version 8, the custom-bits
 * version). A replayed action asks the production path for the same id it asked
 * for the first time, and meets that path's own receipt instead of writing a
 * second object. `purpose` keeps two objects made by one action from
 * colliding on one id.
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

/** The id of a seeded Canvas, so a replayed create answers the Canvas the first made. */
export function demoSeedCanvasId(operationId: string, actionId: string): Promise<string> {
  return demoSeedDerivedId("canvas", operationId, actionId);
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
 * must already be an active member of the workspace; a role bound to anybody
 * else is refused here, before the first write.
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
      /** A person's message in a Canvas's Chat whose run has been admitted but has not finished. */
      state: "run_pending";
      action: Extract<DemoSeedAction, { kind: "create_canvas" | "canvas_message" }>;
      canvasId: string;
      turnId: string;
      /** When the trigger turn was admitted; the run it started is created after it. */
      turnCreatedAt: string;
    }
  | {
      /** A published Sidekick whose one seeded run has been admitted but has not finished. */
      state: "sidekick_run_pending";
      action: Extract<DemoSeedAction, { kind: "sidekick" }>;
      sidekickId: string;
      /** The Sidekick's own run id, which the object hands back at admission. */
      sidekickRunId: string;
    };

function actorAuth(session: DemoSeedSession, actorUserId: string): AuthContext {
  const auth = session.auth.get(actorUserId);
  if (!auth) throw new ApiError(409, "demo_seed_actor_unbound", "The action's actor is not in the cast");
  return auth;
}

/** The Canvas vocabulary for a pack audience. */
function canvasAudience(audience: DemoSeedAudience) {
  if (audience === "organization") return { visibility: "workspace" as const, userIds: [] };
  return audience.userIds.length > 0
    ? { visibility: "participants" as const, userIds: audience.userIds.map(asUserId) }
    : { visibility: "creator" as const, userIds: [] };
}

/** One message through the conversation route's own admission, as the actor. */
async function admitMessage(env: Env, auth: AuthContext, parentId: string, input: {
  text: string;
  clientMessageId: string;
  attachmentIds?: string[];
  seed: DemoSeed;
}) {
  const client = await new ConversationService(env, auth).writableClient(parentId, "0");
  return client.createMessage({
    text: input.text,
    clientMessageId: input.clientMessageId,
    mentions: [],
    confirmedParticipantUserIds: [],
    attachmentIds: input.attachmentIds ?? [],
    seed: input.seed,
  });
}

/**
 * Apply one action through the production path it belongs to.
 *
 * Returns at once for an action that is confirmed by its own write — a message
 * that starts no run, an upload, a publish — and leaves a run-starting action
 * pending for `settleDemoSeedAction`. An action already recorded is returned
 * as it was recorded, without touching the workspace.
 */
export async function applyDemoSeedAction(
  env: Env,
  session: DemoSeedSession,
  action: DemoSeedAction,
): Promise<DemoSeedProgress> {
  const recorded = await demoSeedReceipt(env.DB, session.operationId, action.actionId);
  if (recorded) return { state: "confirmed", receipt: recorded };
  const auth = actorAuth(session, action.actorUserId);
  const clientMessageId = demoSeedClientMessageId(session.operationId, action.actionId);
  switch (action.kind) {
    case "create_canvas": {
      const canvases = new CanvasService(env, auth);
      const { canvasId } = await canvases.create({
        canvasId: asWorkstreamId(await demoSeedCanvasId(session.operationId, action.actionId)),
        title: action.title,
      });
      const audience = canvasAudience(action.audience);
      if (audience.visibility !== "creator") await canvases.setAudience(canvasId, audience);
      if (action.prompt === null) {
        return { state: "confirmed", receipt: await confirm(env, session, action, { canvas: action.canvas, canvasId }) };
      }
      const admitted = await admitMessage(env, auth, canvasId, { text: action.prompt.text, clientMessageId, seed: action.prompt.seed });
      if (action.prompt.seed.assistant === null) {
        return { state: "confirmed", receipt: await confirm(env, session, action, {
          canvas: action.canvas, canvasId, turnId: admitted.turn.turnId,
        }) };
      }
      return { state: "run_pending", action, canvasId, turnId: admitted.turn.turnId, turnCreatedAt: admitted.turn.createdAt };
    }
    case "canvas_message": {
      const canvasId = await canvasIdFor(env.DB, session.operationId, action.canvas);
      const admitted = await admitMessage(env, auth, canvasId, { text: action.text, clientMessageId, seed: action.seed });
      if (action.seed.assistant !== null) {
        return { state: "run_pending", action, canvasId, turnId: admitted.turn.turnId, turnCreatedAt: admitted.turn.createdAt };
      }
      return { state: "confirmed", receipt: await confirm(env, session, action, {
        canvas: action.canvas, canvasId, turnId: admitted.turn.turnId,
      }) };
    }
    case "canvas_artifact": {
      const canvasId = await canvasIdFor(env.DB, session.operationId, action.canvas);
      const harnessRunId = await latestCanvasRunId(env.DB, session.operationId, action.canvas);
      const published = await publishSeededArtifact(env, session, action, {
        executionUserId: action.actorUserId,
        harnessRunId,
        run: { parentKind: "canvas", parentId: canvasId, substreamId: "0" },
        path: action.path,
        title: action.title,
        content: action.content,
      });
      return { state: "confirmed", receipt: await confirm(env, session, action, {
        canvas: action.canvas, canvasId, harnessRunId, resourceId: published.resourceId,
      }) };
    }
    case "upload": {
      const canvasId = await canvasIdFor(env.DB, session.operationId, action.canvas);
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
      const admitted = await admitMessage(env, auth, canvasId, {
        text: "", clientMessageId, attachmentIds: [resourceId],
        seed: { packVersion: session.pack.version, actionId: action.actionId, assistant: null },
      });
      return { state: "confirmed", receipt: await confirm(env, session, action, {
        canvas: action.canvas, canvasId, resourceId, turnId: admitted.turn.turnId,
      }) };
    }
    case "sidekick": {
      const sidekickId = await demoSeedSidekickId(session.operationId, action.actionId);
      const scope = action.audience === "organization" ? "workspace" : "personal";
      await createAutomation(env, {
        workspaceId: session.workspaceId,
        authorUserId: action.actorUserId,
        scope,
        automationId: sidekickId,
      });
      const service = new AutomationService(env, auth);
      // Publishes as well as records: `saveDefinition` applies a ready
      // definition, which is what arms the schedule and puts the row in the
      // directory. A replay writes an identical second revision and applies
      // that, which lands on the same accepted state rather than a different
      // one; `create` above has already answered `created: false` for it.
      const { ready } = await service.saveDefinition(sidekickId, {
        draft: sidekickDraft(action, scope),
        evaluatorRules: null,
        submittedByRunId: null,
      });
      if (!ready) {
        throw new ApiError(409, "demo_seed_sidekick_not_published", `The Sidekick for "${action.actionId}" was not published`);
      }
      // After the definition: a draft's suggested scope that moves the
      // audience clears a people list, so the list is the last word.
      if (action.audience !== "organization" && action.audience.userIds.length > 0) {
        await service.setAudience(sidekickId, { audience: "people", userIds: action.audience.userIds.map(asUserId) });
      }
      if (action.firstRun === null) {
        return { state: "confirmed", receipt: await confirm(env, session, action, { sidekick: action.sidekick, sidekickId }) };
      }
      const admitted = await service.runSeeded(sidekickId, action.firstRun);
      return { state: "sidekick_run_pending", action, sidekickId, sidekickRunId: admitted.runId };
    }
    case "sidekick_message": {
      const sidekickId = await sidekickIdFor(env.DB, session.operationId, action.sidekick);
      const admitted = await admitMessage(env, auth, sidekickId, { text: action.text, clientMessageId, seed: action.seed });
      return { state: "confirmed", receipt: await confirm(env, session, action, {
        sidekick: action.sidekick, sidekickId, turnId: admitted.turn.turnId,
      }) };
    }
  }
}

/**
 * Publish one document version through the Terminal's resource bridge, as
 * Rally's `publish_resource` does from the run named: the same identity
 * (`(conversation, path)`), the same versioning, the same Canvas note. The
 * bytes are the pack's rather than a sandbox file's, which is the one thing a
 * seed replaces; the receipt the bridge requires is derived from the action,
 * so a replay meets the publication the first attempt made.
 *
 * In a Canvas's Chat the destination is the Canvas. From a Sidekick run it is
 * the Canvas the run writes, which `resolveTerminalPublicationHome` makes on
 * the first publish with the run's principal as its creator and the Sidekick
 * as its writer, exactly as a live run's first publish does.
 */
async function publishSeededArtifact(env: Env, session: DemoSeedSession, action: DemoSeedAction, input: {
  executionUserId: string;
  harnessRunId: string;
  run: { parentKind: "canvas" | "automation"; parentId: string; substreamId: string };
  path: string;
  title: string;
  content: string;
}): Promise<{ resourceId: string }> {
  const run = {
    workspaceId: session.workspaceId,
    parentKind: input.run.parentKind,
    parentId: input.run.parentId,
    substreamId: asSubstreamId(input.run.substreamId),
    executionPrincipal: { type: "user" as const, userId: asUserId(input.executionUserId) },
  };
  const sidekickRun = input.run.parentKind === "automation";
  const bridge = createTerminalResourceBridge(
    withWorkspaceRuntimeDatabase(env, session.workspaceId),
    createTerminalPortFactory(env, undefined, input.run.substreamId),
    // A Sidekick run's own conversation holds what it published, as the
    // run's in-object attacher records it in production.
    sidekickRun
      ? (attachment) => attachWorkstreamRuntimeResource(env, { ...attachment, substreamId: input.run.substreamId })
      : undefined,
    sidekickRun ? (request) => resolveTerminalPublicationHome(env, run, request) : null,
    null,
    // The person who asked for the run, as production passes it for a
    // Canvas's Chat: the revision is never news to them. A Sidekick run is
    // nobody's request.
    sidekickRun ? null : input.executionUserId,
    "0",
    canvasArtifactNoter(env, run),
  );
  const published = await bridge.publishResource({
    workspaceId: session.workspaceId,
    workstreamId: input.run.parentId,
    harnessRunId: input.harnessRunId,
    toolCallId: demoSeedClientMessageId(session.operationId, action.actionId),
    effectIntentId: await demoSeedDerivedId("publication", session.operationId, action.actionId),
    executionPrincipal: run.executionPrincipal,
    signal: new AbortController().signal,
  }, { filePath: input.path, displayName: input.title }, new TextEncoder().encode(input.content));
  return { resourceId: published.resourceId };
}

/**
 * The definition a Sidekick step publishes.
 *
 * Written here rather than in the pack because most of it is the same for every
 * seeded Sidekick and none of it is a product decision: no connector is bound,
 * no memory table is declared, and the only trigger is the pack's own schedule.
 * `ready` is true because a demo publishes what it seeds.
 */
function sidekickDraft(action: Extract<DemoSeedAction, { kind: "sidekick" }>, scope: "personal" | "workspace"): AutomationDraft {
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
    suggestedScope: scope,
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
    canvas?: string;
    canvasId?: string;
    sidekick?: string;
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
    canvas: outcome.canvas ?? null,
    canvasId: outcome.canvasId ?? null,
    sidekick: outcome.sidekick ?? null,
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
    canvas_id: outcome.canvasId ?? null,
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
 * Read as the actor, who is already in the Canvas. The run is recognised as
 * the Chat's latest run created after the trigger turn — the seeder is the
 * Canvas's only writer, so there is no other run it could be.
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
  const seed = action.kind === "create_canvas" ? action.prompt!.seed : action.seed;
  const expected: DemoSeedRunOutcome = seed.assistant?.kind === "ask" ? "needs_input" : "completed";
  const client = WorkstreamObjectClient.forParent(env, actorAuth(session, action.actorUserId), "canvas", progress.canvasId, "0");
  for (;;) {
    const detail = await client.get();
    const run = detail.latestHarnessRun ?? null;
    const ours = run !== null && Date.parse(run.createdAt) >= Date.parse(progress.turnCreatedAt);
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
        canvas: action.canvas,
        canvasId: progress.canvasId,
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
 * Wait for a seeded Sidekick's one run to finish, publish the Canvas it
 * writes when the pack gives it one, then record it.
 *
 * Read from the run's own conversation, a child under the Sidekick admitting
 * only the person it runs as. Not from the Sidekick's run history or the row
 * in its shared conversation — both are projections of this conversation,
 * delivered afterwards, and waiting on them is the readiness barrier's job.
 *
 * `completed` is the only success. A seeded run is a `say`, so there is no
 * other outcome to accept, and a failed or stopped run fails the action
 * rather than being skipped past. The Canvas is published only after the run
 * completed, attributed to it: a live run's publish happens inside it, but a
 * seeded run makes no tool calls, so the version names the run that said it
 * and lands once that run is over.
 */
async function settleSeededSidekickRun(
  env: Env,
  session: DemoSeedSession,
  progress: Extract<DemoSeedProgress, { state: "sidekick_run_pending" }>,
  options: { deadlineAt?: number },
): Promise<DemoSeedReceipt> {
  const { action } = progress;
  const conversation = WorkstreamObjectClient.forParent(
    env,
    actorAuth(session, action.actorUserId),
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
      if (action.canvas === null) {
        return confirm(env, session, action, {
          sidekick: action.sidekick, sidekickId: progress.sidekickId, sidekickRunId: progress.sidekickRunId,
          harnessRunId: run.id, runOutcome: "completed",
        });
      }
      const target = {
        workspaceId: session.workspaceId, parentKind: "automation" as const, parentId: progress.sidekickId,
        substreamId: asSubstreamId(progress.sidekickRunId),
        executionPrincipal: { type: "user" as const, userId: asUserId(action.actorUserId) },
      };
      const published = await publishSeededArtifact(env, session, action, {
        executionUserId: action.actorUserId,
        harnessRunId: run.id,
        run: { parentKind: "automation", parentId: progress.sidekickId, substreamId: progress.sidekickRunId },
        path: action.canvas.path,
        title: action.canvas.title,
        content: action.canvas.content,
      });
      // The Canvas the publish just made or found, named the way the run's
      // later publishes find it.
      const home = await resolveTerminalPublicationHome(env, target, { title: action.canvas.title });
      return confirm(env, session, action, {
        sidekick: action.sidekick, sidekickId: progress.sidekickId, sidekickRunId: progress.sidekickRunId,
        harnessRunId: run.id, runOutcome: "completed",
        ...(home ? { canvasId: home.parentId } : {}),
        resourceId: published.resourceId,
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
