/**
 * The preparation operation: one durable, resumable sequence per demo.
 *
 * The operator asks once, by an operation id, and everything hangs off that
 * identity: repeated submission returns the same progress rather than a second
 * workspace, a retry is a new attempt of the same operation, and abandoning it
 * retires whatever it made. The phases are the PRD's — check the template,
 * create the workspace, copy the connections, seed the conversations, wait for
 * the workspace — and each one is written so that running it again is safe:
 * the workspace id is allocated onto the row before the workspace is created,
 * creation replays through the onboarding journal, copying matches what it
 * already copied, seeding resumes from its receipts, and waiting is a read.
 *
 * One driver at a time. Every attempt has a number, the row carries the
 * current one, and a phase called by a driver whose attempt is no longer the
 * row's writes nothing and stops. That is what lets the operator retry an
 * operation whose driver died without a second driver racing the first, and
 * it is why every status write here is guarded by the attempt it belongs to.
 *
 * This module owns the rows and the phase functions. The Workflow in
 * `workflows/demo-preparation.ts` is the driver — one step per phase, and a
 * check-and-sleep loop for the wait — and nothing here knows it is running
 * inside one, which is what lets the whole sequence be proved on real objects
 * without a Workflow binding. `docs/demo-workspaces.md` owns the feature.
 */
import {
  DEMO_PREPARATION_PHASES,
  DemoOperationStatusSchema,
  type DemoCastEntry,
  asWorkspaceId,
  type DemoOperationPhaseStatus,
  type DemoOperationStatus,
  type DemoPreparationPhase,
} from "@rally/contracts";
import { zodDiagnosticCode, codeShaped, describeZodIssues } from "@rally/contracts/zod-diagnostics";

import { boundParameterChunks } from "../durable-objects/bound-parameters";
import { workspaceDOName } from "../durable-objects/names";
import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { uuidV7 } from "../lib/uuid-v7";
import { logInfo, logWarn } from "../observability/logger";
import { copyTemplateConnections } from "./demo-connection-copy";
import { DEMO_PRESENTER_ROLE, DemoPackSchema, PLACEHOLDER_DEMO_PACK, demoCastRoles, type DemoPack } from "./demo-pack";
import { DEMO_CAST_EMAIL_DOMAIN, assertDemoCastNamesDistinct, listDemoCastCandidates, mintDemoPersona, nameDemoPersonas, readDemoCast } from "./demo-cast";
import { checkDemoReadiness, demoReadinessManifest } from "./demo-readiness";
import {
  applyDemoSeedAction,
  demoSeedReceipts,
  openDemoSeedSession,
  settleDemoSeedAction,
} from "./demo-seeder";
import { DEMO_TEMPLATE_WORKSPACE_ID } from "./demo-workspace-visibility";
import { RegionalOnboardingService } from "./platform-onboarding-service";
import { workspaceRuntimeDatabase } from "./workspace-runtime-database";
import { retireWorkspaceGraph } from "./workspace-retirement-service";

let activePack: DemoPack | null = null;

/**
 * The one pack in service, checked against the schema the first time a demo
 * needs it rather than when the Worker's module graph loads. Swapping it is a
 * source change behind the schema; a pack the schema refuses fails the demo
 * route that asked, not every route in both regions at boot.
 */
export function activeDemoPack(): DemoPack {
  activePack ??= DemoPackSchema.parse(PLACEHOLDER_DEMO_PACK);
  return activePack;
}

function nowIso(): string {
  return new Date().toISOString();
}

interface OperationRecord {
  operation_id: string;
  company_name: string;
  presenter_user_id: string;
  presenter_name: string | null;
  pack_version: string;
  cast_json: string;
  workspace_id: string | null;
  workspace_name: string | null;
  status: DemoOperationStatus["status"];
  attempt: number;
  failed_phase: DemoPreparationPhase | null;
  error_code: string | null;
  error_message: string | null;
  ready_at: string | null;
  retired_at: string | null;
  created_at: string;
  updated_at: string;
}

interface PhaseRecord {
  operation_id: string;
  phase: DemoPreparationPhase;
  status: DemoOperationPhaseStatus["status"];
  attempt: number;
  detail_json: string;
  error_code: string | null;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
}

const OPERATION_SELECT = `
  SELECT op.operation_id, op.company_name, op.presenter_user_id, presenter.name AS presenter_name,
         op.pack_version, op.cast_json, op.workspace_id, workspace.name AS workspace_name,
         op.status, op.attempt, op.failed_phase, op.error_code, op.error_message,
         op.ready_at, op.retired_at, op.created_at, op.updated_at
    FROM demo_operations op
    LEFT JOIN users presenter ON presenter.id = op.presenter_user_id
    LEFT JOIN workspaces workspace ON workspace.id = op.workspace_id`;

const PHASE_SELECT = `
  SELECT operation_id, phase, status, attempt, detail_json, error_code, error_message, started_at, finished_at
    FROM demo_operation_phases`;

async function operationRecord(db: D1Database, operationId: string): Promise<OperationRecord | null> {
  return db.prepare(`${OPERATION_SELECT} WHERE op.operation_id = ?`).bind(operationId).first<OperationRecord>();
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/** The cast as the row stores it: a user id per role, which the status also carries. */
const CastSchema = DemoOperationStatusSchema.shape.cast;

/** The cast as stored — a row this module wrote, re-parsed rather than trusted. */
function castOf(record: OperationRecord): Record<string, string> {
  const parsed = CastSchema.safeParse(parseJsonObject(record.cast_json));
  // This is the reader a corrupt row actually meets, and it answers before
  // `operatorError` sees anything: the field rides behind the constant here.
  if (!parsed.success) {
    throw new ApiError(500, codeShaped(`demo_cast_unreadable:${describeZodIssues(parsed.error)}`), "The operation's cast could not be read");
  }
  return parsed.data;
}

function toStatus(
  record: OperationRecord,
  phases: PhaseRecord[],
  confirmed: number,
  names: ReadonlyMap<string, string>,
): DemoOperationStatus {
  const cast = parseJsonObject(record.cast_json);
  return DemoOperationStatusSchema.parse({
    operationId: record.operation_id,
    companyName: record.company_name,
    presenterUserId: record.presenter_user_id,
    presenterName: record.presenter_name,
    packVersion: record.pack_version,
    cast,
    // The directory's own name for each of them, which is what the demo shows
    // and what a mention is validated against; the id when the row names
    // somebody this region no longer has.
    castNames: Object.fromEntries(Object.entries(cast).map(
      ([role, userId]) => [role, typeof userId === "string" ? names.get(userId) ?? userId : String(userId)],
    )),
    workspaceId: record.workspace_id,
    workspaceName: record.workspace_name,
    status: record.status,
    attempt: record.attempt,
    failedPhase: record.failed_phase,
    error: record.error_code && record.error_message
      ? { code: record.error_code, message: record.error_message }
      : null,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    readyAt: record.ready_at,
    retiredAt: record.retired_at,
    phases: phases.map((phase) => ({
      phase: phase.phase,
      status: phase.status,
      attempt: phase.attempt,
      detail: parseJsonObject(phase.detail_json),
      error: phase.error_code && phase.error_message
        ? { code: phase.error_code, message: phase.error_message }
        : null,
      startedAt: phase.started_at,
      finishedAt: phase.finished_at,
    })),
    seeding: { confirmed, total: activeDemoPack().steps.length },
  });
}

/**
 * The statuses of a set of operations, in three queries however many there
 * are: the Demos page polls the list every few seconds, and a query per
 * operation would grow with every demo ever prepared.
 */
async function statusesOf(env: Env, records: OperationRecord[]): Promise<DemoOperationStatus[]> {
  if (records.length === 0) return [];
  const ids = records.map((record) => record.operation_id);
  const phasesByOperation = new Map<string, PhaseRecord[]>();
  const confirmedByOperation = new Map<string, number>();
  const names = new Map<string, string>();
  // In runs that fit one statement: every operation ever prepared is listed,
  // and D1 refuses a statement past its bound parameter ceiling — which would
  // have taken the whole list, live demos included, down for good once enough
  // had been prepared.
  for (const chunk of boundParameterChunks(ids)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const [phases, receipts] = await Promise.all([
      env.DB.prepare(`${PHASE_SELECT} WHERE operation_id IN (${placeholders})`)
        .bind(...chunk).all<PhaseRecord>(),
      env.DB.prepare(
        `SELECT operation_id, COUNT(*) AS confirmed FROM demo_seed_receipts
          WHERE operation_id IN (${placeholders}) GROUP BY operation_id`,
      ).bind(...chunk).all<{ operation_id: string; confirmed: number }>(),
    ]);
    for (const phase of phases.results ?? []) {
      const list = phasesByOperation.get(phase.operation_id) ?? [];
      list.push(phase);
      phasesByOperation.set(phase.operation_id, list);
    }
    for (const row of receipts.results ?? []) confirmedByOperation.set(row.operation_id, Number(row.confirmed));
  }
  // Who the cast are, by the name the directory carries: a name is read back
  // here for every demo ever prepared, so it is one read per chunk rather than
  // one per role.
  const castIds = [...new Set(records.flatMap(
    (record) => Object.values(parseJsonObject(record.cast_json)).filter((value): value is string => typeof value === "string"),
  ))];
  for (const chunk of boundParameterChunks(castIds)) {
    const rows = await env.DB.prepare(
      `SELECT id, name FROM users WHERE id IN (${chunk.map(() => "?").join(", ")})`,
    ).bind(...chunk).all<{ id: string; name: string }>();
    for (const row of rows.results ?? []) names.set(row.id, row.name);
  }
  // In pipeline order, not by clock: a retried attempt re-enters the first
  // phase with a fresh `started_at` while a stale later phase keeps its old
  // one, and the page reads the list in order to find where the operation is.
  const ordinal = new Map(DEMO_PREPARATION_PHASES.map((phase, index) => [phase, index]));
  for (const list of phasesByOperation.values()) {
    list.sort((a, b) => (ordinal.get(a.phase) ?? 0) - (ordinal.get(b.phase) ?? 0) || a.attempt - b.attempt);
  }
  return records.map((record) => toStatus(
    record,
    phasesByOperation.get(record.operation_id) ?? [],
    confirmedByOperation.get(record.operation_id) ?? 0,
    names,
  ));
}

/** The operation as the Demos page shows it, or null for an id nobody started. */
export async function demoOperationStatus(env: Env, operationId: string): Promise<DemoOperationStatus | null> {
  const record = await operationRecord(env.DB, operationId);
  return record ? (await statusesOf(env, [record]))[0]! : null;
}

/** Every operation, newest first — running, ready, failed and abandoned alike. */
export async function listDemoOperations(env: Env): Promise<DemoOperationStatus[]> {
  const rows = await env.DB.prepare(`${OPERATION_SELECT} ORDER BY op.created_at DESC, op.operation_id DESC`)
    .all<OperationRecord>();
  return statusesOf(env, rows.results ?? []);
}

/**
 * What the New demo form is built from: the pack's roles, the template's
 * active members, who the presenter is chosen from, and the colleagues every
 * other role can be cast from. The presenter comes from the first list
 * because they are handed the template's connections; the rest come from the
 * second, which is the whole company rather than whoever the template seats.
 */
export async function demoTemplate(env: Env): Promise<{
  workspaceId: string;
  pack: {
    version: string;
    roles: string[];
    presenterRole: string | null;
    roleLabels: Record<string, string>;
  };
  members: { userId: string; name: string; email: string; role: "owner" | "admin" | "member" }[];
  castCandidates: { userId: string; name: string; email: string }[];
  castEmailDomain: string;
}> {
  // Demos are prepared where the template lives, and this answer is the
  // company's directory: a regional call could do nothing with it but read out
  // every European colleague's name and address.
  requireDemoRegion(env);
  const rows = await env.DB.prepare(
    `SELECT member.user_id, user.name, user.email, member.role
       FROM workspace_members member JOIN users user ON user.id = member.user_id
      WHERE member.workspace_id = ? AND member.status = 'active'
      ORDER BY member.joined_at, user.name`,
  ).bind(DEMO_TEMPLATE_WORKSPACE_ID).all<{
    user_id: string; name: string; email: string; role: "owner" | "admin" | "member";
  }>();
  const pack = activeDemoPack();
  return {
    workspaceId: DEMO_TEMPLATE_WORKSPACE_ID,
    pack: {
      version: pack.version,
      roles: [...pack.roles],
      presenterRole: pack.roles.includes(DEMO_PRESENTER_ROLE) ? DEMO_PRESENTER_ROLE : null,
      roleLabels: { ...pack.roleLabels },
    },
    members: (rows.results ?? []).map((row) => ({
      userId: row.user_id,
      name: row.name,
      email: row.email,
      role: row.role,
    })),
    castCandidates: await listDemoCastCandidates(env),
    castEmailDomain: DEMO_CAST_EMAIL_DOMAIN,
  };
}

/** Demos are prepared where the template lives. The regional deployment carries the routes and refuses them. */
function requireDemoRegion(env: Env): void {
  if (env.AVALON_REGION !== "global") {
    throw new ApiError(409, "demo_region_unsupported", "Demos are prepared in the Global region");
  }
}

/** The driver binding, which production Global carries and a sandbox may not. */
function requireDriver(env: Env): Workflow {
  if (!env.DEMO_PREPARATION_WORKFLOW) {
    throw new ApiError(503, "demo_preparation_unavailable", "Demo preparation is not configured in this deployment");
  }
  return env.DEMO_PREPARATION_WORKFLOW;
}

/**
 * The presenter, who must be an active member of the template: the new
 * workspace is owned by them and receives copies of the template's
 * connections, so a presenter outside the template would be handed its
 * credentials. Answers their name, which the cast may not reuse.
 */
async function assertTemplatePresenter(env: Env, presenterUserId: string): Promise<{ name: string }> {
  const member = await env.DB.prepare(
    `SELECT user.name AS name
       FROM workspace_members member JOIN users user ON user.id = member.user_id
      WHERE member.workspace_id = ? AND member.user_id = ? AND member.status = 'active'`,
  ).bind(DEMO_TEMPLATE_WORKSPACE_ID, presenterUserId).first<{ name: string }>();
  if (!member) {
    throw new ApiError(422, "demo_presenter_not_in_template", "The presenter is not an active member of the template");
  }
  return { name: member.name };
}

/**
 * The Workflow instance id for one attempt of one operation.
 *
 * Cloudflare accepts an instance id only if it matches
 * `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$` and is at most 100 characters
 * (`workflows-shared/src/lib/validators.ts`, the validator Miniflare bundles
 * and production enforces). The first version joined the parts with colons,
 * which that pattern refuses, so every launch failed in production while the
 * Node tests — whose driver is a fake — passed. Hyphens only, like every other
 * Workflow id in this Worker; a UUID and a small integer keep it well under
 * the length limit.
 */
export function demoPreparationInstanceId(operationId: string, attempt: number): string {
  return `demo-preparation-${operationId}-${attempt}`;
}

/**
 * Start one attempt's driver. A launch that fails leaves the row saying so,
 * with Retry as the way back, rather than a `running` row nothing is running.
 */
async function launchAttempt(env: Env, operationId: string, attempt: number): Promise<void> {
  const workflow = requireDriver(env);
  try {
    await workflow.create({
      id: demoPreparationInstanceId(operationId, attempt),
      params: { region: env.AVALON_REGION, operationId, attempt },
    });
  } catch (error) {
    logWarn(env, "demo_operation_launch_failed", {
      operation_id: operationId,
      attempt,
      error: error instanceof Error ? error.message : String(error),
    });
    await markOperationFailed(env, operationId, attempt, null, {
      code: "demo_preparation_launch_failed",
      message: "The preparation's driver could not be started; retry the operation",
    });
    throw new ApiError(503, "demo_preparation_launch_failed", "The preparation could not be started; retry it");
  }
}

/**
 * Start one preparation, or return the one this operation id already started.
 *
 * Operation identity, not a concurrency limit: two different ids are two demos.
 * A submission of an id that already has a row is answered with that row's
 * progress and validates nothing, so a client retrying a lost response meets
 * its own preparation rather than a refusal about a directory that has moved.
 *
 * A first submission casts every role of the pack in service but the
 * presenter's and nothing else, each to a different colleague, and the
 * presenter must be an active member of the template — all refused here,
 * before a row is written, and checked again by the first phase in case either
 * moved in between.
 */
export async function startDemoOperation(
  env: Env,
  input: { operationId: string; companyName: string; presenterUserId: string; cast: Record<string, DemoCastEntry> },
  operator: { operatorId: string | null } = { operatorId: null },
): Promise<DemoOperationStatus> {
  requireDemoRegion(env);
  requireDriver(env);
  // A repeat of an operation id is that operation, answered before this
  // request is validated at all. The cast on the row was checked when it was
  // written, and checking what this submission says against a directory that
  // has moved since — somebody renamed, somebody's address changed — would
  // refuse a retry of a preparation that is running perfectly well. The
  // conflict-safe insert below is what settles two concurrent first requests;
  // this settles the second submission of one that already landed.
  const started = await demoOperationStatus(env, input.operationId);
  if (started) return started;
  const pack = activeDemoPack();
  const castRoles = demoCastRoles(pack.roles);
  for (const role of castRoles) {
    if (!input.cast[role]) throw new ApiError(422, "demo_pack_role_unbound", `Nobody is cast as "${role}"`);
  }
  for (const role of Object.keys(input.cast)) {
    if (role === DEMO_PRESENTER_ROLE) {
      // The presenter is named by their own field: they are cast from the
      // template's members, which is a narrower list than the cast's.
      throw new ApiError(422, "demo_presenter_cast", "The presenter is chosen from the template, not cast");
    }
    if (!castRoles.includes(role)) throw new ApiError(422, "demo_pack_role_unknown", `The pack has no role "${role}"`);
  }
  const presenter = await assertTemplatePresenter(env, input.presenterUserId);
  const presenterRole = pack.roles.includes(DEMO_PRESENTER_ROLE) ? DEMO_PRESENTER_ROLE : null;
  const chosen: Record<string, string> = {};
  const typed: Record<string, string> = {};
  for (const role of castRoles) {
    const entry = input.cast[role]!;
    if (typeof entry === "string") chosen[role] = entry;
    else typed[role] = entry.name;
  }
  // Every chosen id is a colleague, read here so the names below are the
  // directory's rather than the request's.
  const people = await readDemoCast(env, { cast: chosen, presenterRole });
  // One person cannot play two parts: the seeded conversation has them
  // answering themselves, and the readiness barrier reads one directory row
  // for two roles.
  const picked = [...(presenterRole ? [input.presenterUserId] : []), ...Object.values(chosen)];
  if (new Set(picked).size !== picked.length) {
    throw new ApiError(422, "demo_cast_duplicate", "Each pack role must be played by a different person");
  }
  assertDemoCastNamesDistinct([
    ...Object.values(people).map((person) => person.name),
    ...Object.values(typed),
    ...(presenterRole ? [presenter.name] : []),
  ]);
  // A typed name is played by a persona minted for this operation and role,
  // only once every check has passed.
  const bound: Record<string, string> = { ...chosen };
  for (const [role, name] of Object.entries(typed)) {
    bound[role] = (await mintDemoPersona(env, { operationId: input.operationId, role, name })).userId;
  }
  const cast = {
    ...(presenterRole ? { [presenterRole]: input.presenterUserId } : {}),
    ...bound,
  };
  const at = nowIso();
  const inserted = await env.DB.prepare(
    `INSERT INTO demo_operations
       (operation_id, company_name, presenter_user_id, pack_version, cast_json, workspace_id,
        status, attempt, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, 'running', 1, ?, ?)
     ON CONFLICT (operation_id) DO NOTHING`,
  ).bind(
    input.operationId, input.companyName, input.presenterUserId, pack.version,
    JSON.stringify(cast), at, at,
  ).run();
  // The insert's own answer decides who launches: exactly one submission of
  // an operation id writes the row, and only it starts the driver. Deciding
  // it from the row's timestamp instead let two submissions in the same
  // millisecond both launch, and the loser's duplicate instance marked the
  // operation failed under a driver that was running fine.
  if (inserted.meta.changes === 1) {
    await nameDemoPersonas(env, input.operationId, typed);
    await launchAttempt(env, input.operationId, 1);
    logInfo(env, "demo_operation_started", {
      operation_id: input.operationId,
      company_name: input.companyName,
      operator_id: operator.operatorId,
    });
  }
  return (await demoOperationStatus(env, input.operationId))!;
}

/**
 * Run an operation again as a new attempt; every phase resumes from what it
 * left. A failed operation is the ordinary case. A `running` one is allowed
 * too, for the driver that died without saying so — a step the platform ended,
 * an instance that never started — and the attempt number is what makes that
 * safe: the old driver, if it is still alive, is refused at its next phase.
 */
export async function retryDemoOperation(env: Env, operationId: string): Promise<DemoOperationStatus> {
  requireDemoRegion(env);
  // Before the row moves: without the driver, a bumped attempt would sit
  // `running` with nothing running it and its diagnosis erased.
  requireDriver(env);
  const record = await operationRecord(env.DB, operationId);
  if (!record) throw new ApiError(404, "demo_operation_not_found", "No such demo preparation");
  if (record.status !== "failed" && record.status !== "running") {
    throw new ApiError(409, "demo_operation_not_retryable", `A ${record.status} preparation cannot be retried`);
  }
  const attempt = record.attempt + 1;
  const result = await env.DB.prepare(
    `UPDATE demo_operations
        SET status = 'running', attempt = ?, failed_phase = NULL, error_code = NULL, error_message = NULL,
            updated_at = ?
      WHERE operation_id = ? AND attempt = ? AND status IN ('failed', 'running')`,
  ).bind(attempt, nowIso(), operationId, record.attempt).run();
  if (!result.meta.changes) {
    throw new ApiError(409, "demo_operation_changed", "The preparation changed while retrying it; read it again");
  }
  await launchAttempt(env, operationId, attempt);
  logInfo(env, "demo_operation_retried", { operation_id: operationId, attempt });
  return (await demoOperationStatus(env, operationId))!;
}

/**
 * Abandon an unfinished candidate: close the operation, then retire what it made.
 *
 * A demo that is already published is closed from the workspaces tab like any
 * other workspace; this is for the one that never got there, and it is refused
 * for one that did — by the row's status and by `ready_at`, which the wait
 * phase writes in the same fenced statement as `status = 'ready'`, so neither
 * can say "published" while the other does not.
 *
 * The row is claimed first. Claiming it is what stops a live driver: every
 * phase refuses an operation that is not `running`, so a driver still seeding
 * the candidate meets that refusal at its next phase rather than writing into
 * a workspace the walk is closing. And the claim is the check, made in one
 * statement: a wait phase that publishes between a read and a write would
 * otherwise have its demo retired anyway, with the row left saying `ready`.
 * A claimed operation whose walk was interrupted is asked again with the same
 * call, and returns to what remains.
 *
 * The confirmation names the operation, compared with the path as retirement's
 * is: a consistency check on the request, made in Ace and again here.
 */
export async function abandonDemoOperation(
  env: Env,
  operationId: string,
  input: { confirmOperationId: string; operatorId?: string | null },
): Promise<DemoOperationStatus> {
  requireDemoRegion(env);
  if (input.confirmOperationId !== operationId) {
    throw new ApiError(409, "demo_abandon_unconfirmed", "The confirmation does not name this preparation");
  }
  const record = await operationRecord(env.DB, operationId);
  if (!record) throw new ApiError(404, "demo_operation_not_found", "No such demo preparation");
  const at = nowIso();
  const claimed = await env.DB.prepare(
    `UPDATE demo_operations SET status = 'abandoned', updated_at = ?
      WHERE operation_id = ? AND status IN ('running', 'failed') AND ready_at IS NULL`,
  ).bind(at, operationId).run();
  if (claimed.meta.changes === 0) {
    const current = await operationRecord(env.DB, operationId);
    // Already abandoned and already closed: nothing left to do.
    if (current?.status === "abandoned" && (current.retired_at !== null || current.workspace_id === null)) {
      return (await demoOperationStatus(env, operationId))!;
    }
    if (current?.status !== "abandoned") {
      throw new ApiError(409, "demo_operation_ready", "A published demo is retired from the workspaces tab");
    }
    // Abandoned earlier, walk unfinished: fall through and ask again.
  }
  if (record.workspace_id) {
    const created = await env.DB.prepare("SELECT id FROM workspaces WHERE id = ? AND region = ?")
      .bind(record.workspace_id, env.AVALON_REGION).first<{ id: string }>();
    if (created) {
      // The same D1 fence the operator door writes: a candidate nobody was
      // ever offered still has its cast seated, and the fence is what keeps
      // it out of their discovery and their sign-in from here on.
      await env.DB.prepare(
        "UPDATE workspaces SET abandoned_at = ?, updated_at = ? WHERE id = ? AND region = ? AND abandoned_at IS NULL",
      ).bind(at, at, record.workspace_id, env.AVALON_REGION).run();
      const receipt = await retireWorkspaceGraph(env, {
        workspaceId: asWorkspaceId(record.workspace_id),
        retiredAt: Date.now(),
        operationId,
        actorUserId: null,
        reason: "demo_abandoned",
        ...(input.operatorId ? { operatorId: input.operatorId } : {}),
      });
      if (!receipt.complete) {
        throw new ApiError(409, "demo_abandon_incomplete", `${receipt.remaining} objects are still open; ask again`);
      }
    }
  }
  logInfo(env, "demo_operation_abandoned", {
    operation_id: operationId,
    workspace_id: record.workspace_id,
    operator_id: input.operatorId ?? null,
  });
  return (await demoOperationStatus(env, operationId))!;
}

/**
 * Write one phase's row. `started_at` is the instant the phase's current run
 * began: a phase re-entered by the same attempt while still running — the
 * wait, once per round — keeps it, and everything else resets it. The detail
 * is kept when the write carries none, so a failure recorded over a waiting
 * phase leaves the last gaps on the row for the operator to read.
 */
async function recordPhase(
  env: Env,
  operationId: string,
  phase: DemoPreparationPhase,
  update: {
    status: DemoOperationPhaseStatus["status"];
    attempt: number;
    detail?: Record<string, unknown>;
    error?: { code: string; message: string } | null;
  },
): Promise<void> {
  const at = nowIso();
  const finished = update.status === "running" ? null : at;
  await env.DB.prepare(
    `INSERT INTO demo_operation_phases
       (operation_id, phase, status, attempt, detail_json, error_code, error_message, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (operation_id, phase) DO UPDATE SET
       status = excluded.status, attempt = excluded.attempt,
       detail_json = CASE WHEN excluded.detail_json = '{}'
                          THEN demo_operation_phases.detail_json ELSE excluded.detail_json END,
       error_code = excluded.error_code, error_message = excluded.error_message,
       started_at = CASE
                      WHEN excluded.status = 'running'
                       AND demo_operation_phases.status = 'running'
                       AND demo_operation_phases.attempt = excluded.attempt
                      THEN demo_operation_phases.started_at
                      WHEN excluded.status = 'running' THEN excluded.started_at
                      ELSE demo_operation_phases.started_at END,
       finished_at = excluded.finished_at`,
  ).bind(
    operationId, phase, update.status, update.attempt, JSON.stringify(update.detail ?? {}),
    update.error?.code ?? null, update.error?.message ?? null, at, finished,
  ).run();
}

/**
 * What the operator reads when a phase stops. An `ApiError` names its cause;
 * anything else is an internal fault whose text belongs in the log, not on a
 * page that quotes it.
 */
function operatorError(error: unknown): { code: string; message: string } {
  if (error instanceof ApiError) return { code: error.code, message: error.message.slice(0, 1200) };
  // A record this repository wrote that no longer parses names its field; the
  // rejection's text stays in the log.
  const rejected = zodDiagnosticCode(error, "demo_phase");
  if (rejected) return { code: rejected, message: "A stored demo record no longer matches its schema; the code names the field and the log has the detail" };
  return { code: "demo_internal_error", message: "An internal error stopped this phase; the log has the detail" };
}

/**
 * Mark the operation failed, if this attempt is still the one running it. A
 * superseded driver's failure is not the operation's.
 */
async function markOperationFailed(
  env: Env,
  operationId: string,
  attempt: number,
  phase: DemoPreparationPhase | null,
  error: { code: string; message: string },
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE demo_operations
        SET status = 'failed', failed_phase = ?, error_code = ?, error_message = ?, updated_at = ?
      WHERE operation_id = ? AND attempt = ? AND status = 'running'`,
  ).bind(phase, error.code, error.message, nowIso(), operationId, attempt).run();
  return Boolean(result.meta.changes);
}

async function failPhase(
  env: Env,
  operationId: string,
  phase: DemoPreparationPhase,
  attempt: number,
  error: unknown,
): Promise<never> {
  const shown = operatorError(error);
  await recordPhase(env, operationId, phase, { status: "failed", attempt, error: shown });
  await markOperationFailed(env, operationId, attempt, phase, shown);
  logWarn(env, "demo_operation_phase_failed", {
    operation_id: operationId,
    phase,
    attempt,
    error_code: shown.code,
    error: error instanceof Error ? error.message : String(error),
  });
  throw error;
}

export type DemoPhaseOutcome =
  | { outcome: "completed"; detail: Record<string, unknown> }
  | { outcome: "waiting"; detail: Record<string, unknown> }
  | { outcome: "ready"; detail: Record<string, unknown> };

/**
 * Run one phase of one attempt, recording it. Every phase is safe to run
 * again: a retry after a crash resumes rather than repeats.
 *
 * `waiting_for_workspace` answers `waiting` with the open gaps until the
 * projection matches, then `ready` — and publishing Ready is part of that
 * phase, so there is no moment where the check has passed and the row has not
 * heard. How long the driver keeps asking is the driver's decision.
 */
export async function runDemoPreparationPhase(
  env: Env,
  operationId: string,
  phase: DemoPreparationPhase,
  options: { attempt: number; deadlineAt?: number },
): Promise<DemoPhaseOutcome> {
  const record = await operationRecord(env.DB, operationId);
  if (!record) throw new ApiError(404, "demo_operation_not_found", "No such demo preparation");
  if (record.attempt !== options.attempt) {
    // A later attempt owns this operation. Stop without writing: the row is
    // theirs, and a stale driver that kept going would be a second one.
    throw new ApiError(409, "demo_operation_superseded", `Attempt ${options.attempt} was superseded by ${record.attempt}`);
  }
  if (record.status === "abandoned") throw new ApiError(409, "demo_operation_abandoned", "This preparation was abandoned");
  if (record.status !== "running") throw new ApiError(409, `demo_operation_${record.status}`, `This preparation is ${record.status}`);
  await recordPhase(env, operationId, phase, { status: "running", attempt: options.attempt });
  try {
    const result = await phaseBody(env, record, phase, options);
    if (result.outcome !== "waiting") {
      await recordPhase(env, operationId, phase, { status: "completed", attempt: options.attempt, detail: result.detail });
    } else {
      await recordPhase(env, operationId, phase, { status: "running", attempt: options.attempt, detail: result.detail });
    }
    return result;
  } catch (error) {
    return failPhase(env, operationId, phase, options.attempt, error);
  }
}

/**
 * The driver stopped outside a phase body — a step the platform ended, an
 * error between steps — and would otherwise leave the row `running` with
 * nothing running it. Recorded against the phase that was running, if one
 * was, and only if this attempt still owns the operation.
 */
export async function failDemoPreparationDriver(
  env: Env,
  operationId: string,
  attempt: number,
  error: unknown,
): Promise<void> {
  const shown = error instanceof ApiError
    ? operatorError(error)
    : { code: "demo_driver_failed", message: "The preparation's driver stopped; retry the operation" };
  const running = await env.DB.prepare(
    `${PHASE_SELECT} WHERE operation_id = ? AND attempt = ? AND status = 'running'`,
  ).bind(operationId, attempt).first<PhaseRecord>();
  const failed = await markOperationFailed(env, operationId, attempt, running?.phase ?? null, shown);
  if (failed && running) {
    await recordPhase(env, operationId, running.phase, { status: "failed", attempt, error: shown });
  }
  if (failed) {
    logWarn(env, "demo_operation_driver_failed", {
      operation_id: operationId,
      attempt,
      phase: running?.phase ?? null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The wait reached the driver's last round without the workspace matching.
 * Fails the phase with the gaps its last round recorded still on the row.
 */
export async function exhaustDemoProjectionWait(
  env: Env,
  operationId: string,
  attempt: number,
  wait: { rounds: number; minutes: number },
): Promise<never> {
  const error = new ApiError(
    409,
    "demo_projection_wait_exhausted",
    `The workspace did not match the pack within ${wait.rounds} readiness checks (about ${wait.minutes} minutes)`,
  );
  return failPhase(env, operationId, "waiting_for_workspace", attempt, error);
}

async function phaseBody(
  env: Env,
  record: OperationRecord,
  phase: DemoPreparationPhase,
  options: { attempt: number; deadlineAt?: number },
): Promise<DemoPhaseOutcome> {
  const pack = activeDemoPack();
  if (record.pack_version !== pack.version) {
    throw new ApiError(409, "demo_pack_changed", `The pack in service is ${pack.version}, not ${record.pack_version}`);
  }
  const cast = castOf(record);
  switch (phase) {
    case "checking_template": {
      const template = await env.DB.prepare(
        `SELECT id FROM workspaces WHERE id = ? AND region = ? AND abandoned_at IS NULL`,
      ).bind(DEMO_TEMPLATE_WORKSPACE_ID, env.AVALON_REGION).first<{ id: string }>();
      if (!template) throw new ApiError(409, "demo_template_missing", "The template workspace is not in this region");
      const presenter = await env.DB.prepare(
        `SELECT id FROM users WHERE id = ? AND platform_user_id IS NOT NULL`,
      ).bind(record.presenter_user_id).first<{ id: string }>();
      if (!presenter) throw new ApiError(409, "demo_presenter_unknown", "The presenter is not a signed-in member of this region");
      const presenterMember = await assertTemplatePresenter(env, record.presenter_user_id);
      const people = await readDemoCast(env, {
        cast,
        operationId: record.operation_id,
        presenterRole: pack.roles.includes(DEMO_PRESENTER_ROLE) ? DEMO_PRESENTER_ROLE : null,
      });
      // Against the directory as it reads now, not as the start request found
      // it: everybody's name is rewritten from their platform identity each
      // time they sign in, and this operation may be a retry days later.
      assertDemoCastNamesDistinct([
        ...Object.values(people).map((person) => person.name),
        ...(pack.roles.includes(DEMO_PRESENTER_ROLE) ? [presenterMember.name] : []),
      ]);
      const connections = await workspaceRuntimeDatabase(env, DEMO_TEMPLATE_WORKSPACE_ID).prepare(
        `SELECT COUNT(*) AS count FROM connector_connections WHERE workspace_id = ? AND scope = 'workspace'`,
      ).bind(DEMO_TEMPLATE_WORKSPACE_ID).first<{ count: number }>();
      return { outcome: "completed", detail: { templateConnections: Number(connections?.count ?? 0), roles: pack.roles } };
    }
    case "creating_workspace": {
      let workspaceId = record.workspace_id;
      if (!workspaceId) {
        workspaceId = uuidV7();
        // Onto the row before the workspace exists, so a crash between the two
        // retries the same id rather than allocating a second workspace.
        await env.DB.prepare(
          `UPDATE demo_operations SET workspace_id = ?, updated_at = ? WHERE operation_id = ? AND workspace_id IS NULL`,
        ).bind(workspaceId, nowIso(), record.operation_id).run();
        const stored = await operationRecord(env.DB, record.operation_id);
        workspaceId = stored?.workspace_id ?? workspaceId;
      }
      await new RegionalOnboardingService(env).createWorkspaceForMember({
        operationId: record.operation_id,
        workspaceId: asWorkspaceId(workspaceId),
        name: `${record.company_name}-demo`,
        userId: record.presenter_user_id,
      });
      const at = nowIso();
      const seated = new Set([record.presenter_user_id, ...Object.values(cast)]);
      for (const userId of seated) {
        if (userId === record.presenter_user_id) continue;
        await env.DB.prepare(
          `INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
           VALUES (?, ?, 'member', 'active', ?)
           ON CONFLICT (workspace_id, user_id) DO UPDATE SET status = 'active'`,
        ).bind(workspaceId, userId, at).run();
      }
      const people = [...seated];
      await (await durableObjectStubForWorkspace(
        env,
        env.WORKSPACE_DOS,
        asWorkspaceId(workspaceId),
        workspaceDOName(env.AVALON_REGION, asWorkspaceId(workspaceId)),
      )).upsertImpersonationRelationships({
        workspaceId,
        relationships: demoImpersonationRelationships(people, record.operation_id),
      });
      return {
        outcome: "completed",
        detail: { workspaceId, members: seated.size, impersonationRelationships: people.length ** 2 },
      };
    }
    case "copying_connections": {
      const workspaceId = requireWorkspace(record);
      const result = await copyTemplateConnections(env, {
        sourceWorkspaceId: DEMO_TEMPLATE_WORKSPACE_ID,
        destinationWorkspaceId: workspaceId,
        sourceDb: workspaceRuntimeDatabase(env, DEMO_TEMPLATE_WORKSPACE_ID),
        destinationDb: workspaceRuntimeDatabase(env, workspaceId),
        now: nowIso(),
      });
      return {
        outcome: "completed",
        detail: {
          copied: result.copied.map((copy) => ({ connectorType: copy.connectorType, displayName: copy.displayName })),
          skipped: result.skipped.map((skip) => ({ connectorType: skip.connectorType, reason: skip.reason })),
        },
      };
    }
    case "seeding_conversations": {
      const workspaceId = requireWorkspace(record);
      const session = await openDemoSeedSession(env, {
        operationId: record.operation_id,
        workspaceId,
        pack,
        roles: cast,
      });
      let confirmed = 0;
      for (const action of session.actions) {
        const progress = await applyDemoSeedAction(env, session, action);
        await settleDemoSeedAction(env, session, progress, options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt });
        confirmed += 1;
        await recordPhase(env, record.operation_id, phase, {
          status: "running",
          attempt: options.attempt,
          detail: { confirmed, total: session.actions.length, lastAction: action.actionId },
        });
      }
      return { outcome: "completed", detail: { confirmed, total: session.actions.length } };
    }
    case "waiting_for_workspace": {
      const workspaceId = requireWorkspace(record);
      const session = await openDemoSeedSession(env, {
        operationId: record.operation_id,
        workspaceId,
        pack,
        roles: cast,
      });
      const manifest = demoReadinessManifest(pack, session.cast, await demoSeedReceipts(env.DB, record.operation_id));
      const report = await checkDemoReadiness(env, { operationId: record.operation_id, workspaceId, manifest });
      if (!report.ready) return { outcome: "waiting", detail: { gaps: report.gaps, checkedAt: report.checkedAt } };
      const at = nowIso();
      // Published and `ready` in one fenced statement. `ready_at` is what
      // discovery reads and `status` is what the page and abandon read; a
      // driver superseded between the check above and here writes neither,
      // rather than publishing a workspace whose row still says `running`.
      await env.DB.prepare(
        `UPDATE demo_operations SET status = 'ready', ready_at = COALESCE(ready_at, ?), updated_at = ?
          WHERE operation_id = ? AND attempt = ? AND status = 'running'`,
      ).bind(at, at, record.operation_id, options.attempt).run();
      logInfo(env, "demo_operation_ready", { operation_id: record.operation_id, workspace_id: workspaceId });
      return { outcome: "ready", detail: { checkedAt: report.checkedAt, readyAt: at } };
    }
  }
}

function requireWorkspace(record: OperationRecord): string {
  if (!record.workspace_id) throw new ApiError(409, "demo_workspace_not_created", "The workspace has not been created yet");
  return record.workspace_id;
}

function demoImpersonationRelationships(userIds: string[], operationId: string) {
  return userIds.flatMap((impersonatorUserId) => userIds.map((representedUserId) => ({
    impersonatorUserId,
    representedUserId,
    authorityBasis: `demo:${operationId}`,
  })));
}

export const __demoPreparationTesting = { castOf, demoImpersonationRelationships, operatorError };
