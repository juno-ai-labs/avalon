import { ExecutionPrincipalSchema, asWorkspaceId, asWorkstreamId, type WorkstreamId } from "@rally/contracts";
import { newId, nowIso } from "@rally/db";

import type { Env } from "../env";
import { truncateUtf16Safe } from "../lib/text";
import {
  latestActivityEventCursor,
  listActivityEventsForUser,
  type ActivityEventCursor,
  type ActivityEventRow,
} from "./activity-event-service";
import { publishWorkstreamEvent } from "./integrations";
import { workflowInstanceWasCreated } from "../lib/workflow-launch-signal";
import { createMessageObjectPort } from "../runtime/message-port";
import { readMessage } from "../runtime/message-projection";
import { launchWorkstreamHarness } from "./workstream-service";
import {
  bootstrapWorkstreamRuntimeEnvironment,
  provisionWorkstreamObject,
} from "./workstream-runtime-database";
import {
  withWorkspaceRuntimeDatabase,
  workspaceRegionalDatabase,
} from "./workspace-runtime-database";
import { createIdentityObjectPort } from "../runtime/identity-port";

/**
 * How far back a person's first ever digest reads. Without a floor, switching a
 * digest on would summarize the entire history of the workspace; with one, the
 * first digest is the same shape as every later one.
 */
const FIRST_DIGEST_LOOKBACK_MS = 72 * 60 * 60_000;
/**
 * The context ceiling. Whichever of "the last 72 hours" and "the last 200
 * events" is larger is what the model sees, so a quiet window still carries
 * enough history to summarize against and a busy one is not truncated to a
 * handful of lines.
 */
const MAX_DIGEST_EVENTS = 200;
const MAX_EVENT_BODY_CHARACTERS = 1_200;
const MAX_PROMPT_CHARACTERS = 120_000;

export interface DigestScheduleFireInput {
  scheduleId: string;
  workspaceId: string;
  /** The occurrence instant, which is what makes a re-fired alarm idempotent. */
  plannedFor: string;
}

interface DigestScheduleRow {
  id: string;
  workspace_id: string;
  user_id: string;
  timezone: string;
  enabled: number;
  execution_principal_json: string;
  user_name: string;
  workspace_name: string;
}

interface DeliveryCursorRow {
  cursor_through: number | null;
}

export type DigestFireOutcome =
  | { started: true; deliveryId: string; harnessRunId: string }
  | { started: false; reason: "already_planned" | "disabled" | "unauthorized" | "empty" };

/**
 * Starts the run for one due digest occurrence.
 *
 * The shape mirrors a due wake-up on purpose: re-validate the principal, claim
 * the occurrence, take the window, then launch. The claim is the
 * `digest_deliveries` row — its `(digest_schedule_id, planned_for)` uniqueness is
 * what stops a retried alarm from digesting the same window twice, and its
 * frozen `cursor_through` is what stops events arriving mid-run from being
 * skipped rather than carried into the next digest.
 */
export async function fireDigestSchedule(
  env: Env,
  input: DigestScheduleFireInput,
): Promise<DigestFireOutcome> {
  env = withWorkspaceRuntimeDatabase(env, input.workspaceId);
  const digest = await env.DB.prepare(
    `SELECT id, workspace_id, user_id, enabled, execution_principal_json
       FROM digest_schedules WHERE id = ? AND workspace_id = ?`,
  ).bind(input.scheduleId, input.workspaceId).first<Pick<
    DigestScheduleRow,
    "id" | "workspace_id" | "user_id" | "enabled" | "execution_principal_json"
  >>();
  const identity = digest ? await workspaceRegionalDatabase(env).prepare(
    `SELECT u.timezone, u.name AS user_name, w.name AS workspace_name
       FROM users u JOIN workspaces w ON w.id = ?
       JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = u.id AND m.status = 'active'
      WHERE u.id = ?`,
  ).bind(input.workspaceId, digest.user_id).first<Pick<
    DigestScheduleRow,
    "timezone" | "user_name" | "workspace_name"
  >>() : null;
  const schedule: DigestScheduleRow | null = digest && identity ? { ...digest, ...identity } : null;
  // A revoked membership or a deleted schedule is a decision, not a failure:
  // retrying would only reach the same answer.
  if (!schedule) return { started: false, reason: "unauthorized" };
  if (schedule.enabled !== 1) return { started: false, reason: "disabled" };

  // The principal is re-validated rather than trusted: a schedule saved months
  // ago must not still act as somebody who is no longer that person. The join
  // above already proved the membership is active.
  const principal = ExecutionPrincipalSchema.parse(JSON.parse(schedule.execution_principal_json));
  if (principal.type !== "user" || principal.userId !== schedule.user_id) {
    return { started: false, reason: "unauthorized" };
  }

  const latest = await latestActivityEventCursor(env, asWorkspaceId(schedule.workspace_id));
  const from = await previousCursor(env, schedule.id);
  const notBefore = from ? null : new Date(Date.now() - FIRST_DIGEST_LOOKBACK_MS).toISOString();

  const events = await listActivityEventsForUser(env, {
    workspaceId: asWorkspaceId(schedule.workspace_id),
    userId: schedule.user_id,
    from,
    through: latest,
    notBefore,
    // A digest interrupts somebody on a schedule, so it reads only what a
    // connector positively confirmed is worth interrupting them with. The
    // window below still ends at the log's top rather than at the last
    // digestible event: the cursor has to step over what was withheld, or every
    // later occurrence would re-scan it forever.
    digestibleOnly: true,
    limit: MAX_DIGEST_EVENTS,
  });
  // The window ends where the read actually stopped, not where the log happens
  // to end. A busy window returns the oldest `MAX_DIGEST_EVENTS`; recording the
  // log's top as covered would step the cursor straight over the remainder and
  // nobody would ever be told about it. Stopping short means the next
  // occurrence picks up exactly where this one left off.
  const through = events.length === MAX_DIGEST_EVENTS
    ? events[events.length - 1]!.log_sequence
    : latest;

  const deliveryId = newId();
  const at = nowIso();
  const claimed = await env.DB.prepare(
    `INSERT INTO digest_deliveries
       (id, workspace_id, digest_schedule_id, user_id, planned_for,
        cursor_from, cursor_through, event_count, highlight_count,
        harness_run_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
     ON CONFLICT DO NOTHING
     RETURNING id`,
  ).bind(
    deliveryId,
    schedule.workspace_id,
    schedule.id,
    schedule.user_id,
    input.plannedFor,
    from,
    through,
    events.length,
    events.filter((event) => event.is_target === 1).length,
    // Nothing happened, so nothing is written and nothing is sent — but the
    // cursor still advances, so the next digest does not re-scan this window.
    events.length === 0 ? "empty" : "planned",
    at,
    at,
  ).first<{ id: string }>();
  if (!claimed) return { started: false, reason: "already_planned" };
  if (events.length === 0) return { started: false, reason: "empty" };

  let workstreamId: WorkstreamId | null = null;
  let harnessRunId: string | null = null;
  try {
    workstreamId = await createDigestWorkstream(env, schedule, {
      deliveryId,
      plannedFor: input.plannedFor,
    });
    const messageId = await appendDigestBriefMessage(env, {
      workspaceId: schedule.workspace_id,
      workstreamId,
      deliveryId,
      brief: renderDigestBrief(schedule, events),
    });
    harnessRunId = await launchWorkstreamHarness(env, {
      workspaceId: asWorkspaceId(schedule.workspace_id),
      workstreamId,
      triggerMessageId: messageId,
      origin: "scheduled_digest",
      executionPrincipal: principal,
      digestDeliveryId: deliveryId,
    });
    await env.DB.prepare(
      `UPDATE digest_deliveries SET status = 'running', harness_run_id = ?, updated_at = ?
        WHERE id = ? AND status = 'planned'`,
    ).bind(harnessRunId, nowIso(), deliveryId).run();
    return { started: true, deliveryId, harnessRunId };
  } catch (error) {
    // An attempt that started nothing undoes itself completely — the claim, so
    // the scheduler's retry gets another go at this occurrence, and the work
    // stream with it, since it belongs to this occurrence alone and a retry
    // makes its own. Otherwise every launch outage would leave an empty
    // transcript behind, and those are never reaped.
    //
    // An attempt that *did* start something undoes nothing. `launchWorkstreamHarness`
    // inserts the run row, creates the Cloudflare Workflow instance, and only
    // then records the instance id, so a failure in that last write throws with
    // a live run already executing. Releasing the claim there would let a retry
    // digest the same window twice with no uniqueness left to catch it, and
    // deleting the work stream would cascade the transcript, run row and frozen
    // memory context away beneath the run still reading them.
    //
    // Which of the two happened is asked of the error rather than inferred from
    // a row: the launcher marks its own run `failed` in both cases, so neither
    // `harness_runs.status` nor the row's existence can answer it. `harnessRunId`
    // covers the failures that happen before the launcher is reached at all.
    if (harnessRunId === null && !workflowInstanceWasCreated(error)) {
      await env.DB.prepare("DELETE FROM digest_deliveries WHERE id = ? AND status = 'planned'")
        .bind(deliveryId).run().catch(() => undefined);
      // Legacy D1 rows cascade. The DO path leaves a durable, unlistable
      // tombstone because its object identity cannot join this transaction.
      if (workstreamId) {
        await createIdentityObjectPort(env, schedule.workspace_id, workstreamId)
          .archiveSystemWorkstream({ systemKind: "digest", now: Date.now() })
          .catch(() => undefined);
        // A Durable Object identity cannot be deleted transactionally with
        // its parent delivery claim. This authoritative tombstone keeps the
        // never-started system stream unlistable and is safer than a
        // cross-object purge that could race a late Workflow creation.
      
      }
    }
    throw error;
  }
}

/**
 * Where the next digest starts reading: the highest point this schedule has
 * committed to covering.
 *
 * "Committed" includes a delivery that is still `planned` or `running`, not just
 * a settled one. Two configured times a minute apart, or one slow run, would
 * otherwise both start from the last *settled* cursor and summarize the same
 * events into consecutive emails — the window is frozen before the harness is
 * queued, so the second occurrence cannot see that the first already claimed it.
 *
 * `failed` is excluded, which is what folds an undelivered window into the next
 * digest rather than losing it.
 *
 * The maximum rather than the newest row: `planned_for` orders occurrences, but
 * a retried or late one can settle out of order, and the cursor must never move
 * backwards.
 */
async function previousCursor(env: Env, scheduleId: string): Promise<ActivityEventCursor | null> {
  const row = await env.DB.prepare(
    `SELECT MAX(cursor_through) AS cursor_through
       FROM digest_deliveries
      WHERE digest_schedule_id = ?
        AND status IN ('delivered', 'empty', 'planned', 'running')`,
  ).bind(scheduleId).first<DeliveryCursorRow>();
  return row?.cursor_through == null ? null : Number(row.cursor_through);
}

/**
 * What one occurrence's work stream is called.
 *
 * Deliberately not `occurrenceLabel`, which the email uses: that renders
 * "Tuesday 11 August · 5:00 PM", which is right above a message somebody is
 * reading and far too long for a sidebar row. A row title is ellipsized to
 * roughly thirty characters, and the clipped end is the *time* — the one part
 * that tells two occurrences on the same day apart. So the weekday goes and the
 * month abbreviates, leaving both distinguishing parts inside the box.
 *
 * The recipient's name is not in it either. It would sit in front of the date,
 * so it would be the part that survives truncation, and it identifies nobody to
 * the only person who can open one: a digest work stream is `personal` with its
 * recipient as its sole participant.
 */
function digestWorkstreamTitle(plannedFor: string, timezone: string): string {
  const at = new Date(plannedFor);
  if (Number.isNaN(at.getTime())) return "Digest";
  try {
    const day = new Intl.DateTimeFormat("en-GB", {
      day: "numeric", month: "short", timeZone: timezone,
    }).format(at);
    const time = new Intl.DateTimeFormat("en-US", {
      hour: "numeric", minute: "2-digit", timeZone: timezone,
    }).format(at);
    return `Digest · ${day} · ${time}`;
  } catch {
    // A stored timezone this runtime does not know must not stop the digest.
    return "Digest";
  }
}

/**
 * The hidden work stream one digest occurrence executes in.
 *
 * The agent loop is work-stream shaped end to end — transcript, compaction, tool
 * invocations and the realtime room all key off `workstream_id` — so
 * running the *normal* loop rather than a bespoke one means having a work
 * stream. `system_kind` keeps it out of every listing surface.
 *
 * One per occurrence, not one per person. A digest run is a pure function from a
 * frozen window to a summary, and the only thing that has to survive between
 * occurrences is the cursor, which lives on `digest_deliveries`. Sharing one
 * work stream instead gave every run the previous months of digests as replayed
 * assistant history — unlabelled, and uncheckable against the windows it came
 * from, which the protocol projector drops as UI state. A fresh work stream is
 * what makes each occurrence's context exactly its own window.
 *
 * No claim race to resolve: the caller reaches this only after winning the
 * `digest_deliveries` insert, so exactly one attempt per occurrence gets here.
 */
async function createDigestWorkstream(
  env: Env,
  schedule: DigestScheduleRow,
  occurrence: { deliveryId: string; plannedFor: string },
): Promise<WorkstreamId> {
  const workstreamId = asWorkstreamId(newId());
  const at = nowIso();
  await bootstrapWorkstreamRuntimeEnvironment(
    env,
    schedule.workspace_id,
    workstreamId,
  );
  await provisionWorkstreamObject(env, {
    workspaceId: asWorkspaceId(schedule.workspace_id),
    workstreamId,
    // The occurrence is the title because these are no longer one row per
    // person: a listing with Debug enabled is a list of occurrences, and a
    // column of identical names would say nothing about which is which. In
    // their own timezone, because a digest is a time of *their* day.
    title: digestWorkstreamTitle(occurrence.plannedFor, schedule.timezone),
    objective: "Write this person's scheduled digest of what changed since the last one.",
    scope: "personal",
    originType: "ad_hoc",
    createdByUserId: schedule.user_id,
    // The recipient is the sole participant, which is what makes every tool the
    // run reaches for resolve against their own access and nobody else's.
    participantUserIds: [schedule.user_id],
    harnessStatus: "idle",
    emailAddress: null,
    emailRouteStatus: null,
    systemKind: "digest",
    automationSubscriptionId: null,
    automationRunId: null,
    plannedFor: null,
    modelOverride: null,
    now: Date.parse(at),
  });
  // The occurrence is regional coordination state; it references the D1
  // identity anchor but never owns the work-stream record.
  await env.DB.prepare(
    "UPDATE digest_deliveries SET workstream_id = ?, updated_at = ? WHERE id = ?",
  ).bind(workstreamId, at, occurrence.deliveryId).run();
  return workstreamId;
}

/**
 * Puts the window in the transcript as a system message and returns its id, so
 * the run is triggered exactly the way a human message triggers one. Nothing
 * about the loop is special-cased for digests: the model gets a brief and the
 * whole tool surface, and can go read anything the brief only summarizes.
 */
async function appendDigestBriefMessage(
  env: Env,
  input: { workspaceId: string; workstreamId: string; deliveryId: string; brief: string },
): Promise<string> {
  const clientMessageId = `digest:${input.deliveryId}`;
  const messages = createMessageObjectPort(env, input.workspaceId, input.workstreamId);
  const appended = await messages.appendMessage({
    messageId: newId(),
    clientMessageId,
    authorType: "system",
    authorUserId: null,
    externalActorJson: null,
    messageType: "system",
    text: input.brief,
    structuredContentJson: null,
    producedByRunId: null,
    now: Date.now(),
  });
  const stored = await readMessage(
    messages,
    { workspaceId: input.workspaceId, workstreamId: input.workstreamId },
    clientMessageId,
  );
  if (stored) {
    await publishWorkstreamEvent(env, input.workspaceId, input.workstreamId, {
      type: "message_created",
      message: stored,
    });
    return stored.id;
  }
  // Only reachable if the row went away between the append and the read, since
  // `readMessage` resolves by client message id and answers on a redelivery
  // too. A redelivery publishes `message_created` again, which is what the
  // routed path did — the reader it used had no way to know either.
  return appended.messageId;
}

/**
 * The brief the run is triggered with.
 *
 * It states the job, then lays out the window grouped by subject, because "what
 * moved in this work stream" is what a person wants read back to them — not a
 * flat chronological list. Events the reader is a named target of are marked, so
 * the model can lead with them rather than infer importance, and each group
 * carries its canonical link so the digest can point at the real thing instead
 * of describing it.
 *
 * The window is the only thing it is told to write from, and since each
 * occurrence runs in its own work stream there is nothing else there to write
 * from. Two earlier versions of this instruction tried to reconcile the brief
 * with a shared transcript: one asked the model to skip what a previous digest
 * had already sent, judged by a delivery note that is a `system` row the
 * protocol projector drops, so every earlier digest read as undelivered and was
 * restated; the next told it that earlier digests above were for continuity of
 * voice only. Both were reasoning about a transcript the run no longer has. What
 * made them unnecessary in the first place still holds: `cursor_from` guarantees
 * the windows do not overlap, and a failed delivery leaves its window
 * unconsumed, so its events are in *this* brief rather than only in an older
 * summary.
 *
 * The output contract is Markdown rather than a structured schema, because the
 * run is the ordinary agent loop and its product is a message. The instructions
 * name the shape a digest reads best in — `##` sections and one bullet per
 * development — and the email renderer covers the full common set (lists,
 * tables, fenced code, links) should the model reach past it. The general
 * formatting rules are not restated here: a digest run is an ordinary
 * work-stream run, and its system prompt already carries
 * `RESPONSE_FORMATTING_POLICY`; a second copy in the brief once competed with
 * the shape above and invited tables where a bullet was asked for.
 */
export function renderDigestBrief(
  schedule: Pick<DigestScheduleRow, "user_name" | "workspace_name" | "timezone">,
  events: ActivityEventRow[],
): string {
  const bySubject = new Map<string, ActivityEventRow[]>();
  for (const event of events) {
    const key = `${event.subject_type}:${event.subject_id ?? event.id}`;
    bySubject.set(key, [...bySubject.get(key) ?? [], event]);
  }

  const sections = [...bySubject.values()].map((group) => {
    const first = group[0]!;
    const heading = first.canonical_url
      ? `### ${first.title} — ${first.subject_type} — link: ${first.canonical_url}`
      : `### ${first.title} — ${first.subject_type}`;
    const lines = group.map((event) => {
      const target = event.is_target === 1
        ? ` [${event.target_relations ?? "involves you"} — THIS NAMES THEM]`
        : "";
      const body = truncateUtf16Safe(event.body.replace(/\s+/gu, " ").trim(), MAX_EVENT_BODY_CHARACTERS);
      return `  - ${event.occurred_at} · ${event.actor_label || "someone"}${target}: ${body || event.title}`;
    });
    return [heading, ...lines].join("\n");
  });

  const targeted = events.filter((event) => event.is_target === 1).length;
  const brief = [
    `You are writing the scheduled digest for ${schedule.user_name} in the ${schedule.workspace_name} workspace.`,
    `Their timezone is ${schedule.timezone}. Everything below happened since their last digest and is already filtered to what they are allowed to see.`,
    "",
    "Your final message in this run is the digest, and its text is mailed verbatim. There is nowhere else to put it: do not summarize what you wrote, do not report that you wrote it, and do not close with a sentence about the task. If your last message is anything but the digest itself, that is what they receive instead of it.",
    "",
    "Write the digest as Markdown addressed to them. It is rendered into an email, so structure is what makes it readable:",
    "",
    "- Open with one short sentence naming the single most important thing. No greeting — the email adds one.",
    targeted > 0
      ? `- Use \`## \` for each section. Start with \`## Needs you\` covering the ${targeted} item${targeted === 1 ? "" : "s"} marked THIS NAMES THEM.`
      : "- Use `## ` for each section. Nothing below names them directly, so do not write a \"Needs you\" section.",
    "- Group the rest by what it is about, one `## ` section each, most consequential first. Name the section after the thing, not the tool it came from.",
    "- Under each section use `- ` bullets, one per real development. Say what changed and what it means, never who clicked what.",
    "- Where an item below carries a `link:`, link its name with `[name](url)` the first time it appears in that section. Never invent a URL.",
    "- Lead a bullet with a single emoji only where it earns its place — a decision needed, a blocker, something shipped. Most bullets take none.",
    "- Bold the few phrases that carry the decision. Use `> ` for a quote worth reading verbatim.",
    "- Write this digest from the source material below and nothing else. This work stream holds this occurrence alone — there is no earlier digest above it, and nothing else to draw on.",
    "- If an item below is only a fragment and the detail matters, use your tools to read the full context before summarizing it.",
    "- No sign-off, no restating these instructions, no commentary about being an assistant.",
    "",
    `## Source material (${events.length} item${events.length === 1 ? "" : "s"})`,
    ...sections,
  ].join("\n");
  return truncateUtf16Safe(brief, MAX_PROMPT_CHARACTERS);
}
