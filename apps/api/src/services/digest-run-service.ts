import { ExecutionPrincipalSchema } from "@avalon/contracts";
import { createDatabase, newId, nowIso } from "@avalon/db";

import type { Env } from "../env";
import { truncateUtf16Safe } from "../lib/text";
import {
  latestActivityEventCursor,
  listActivityEventsForUser,
  type ActivityEventCursor,
  type ActivityEventRow,
} from "./activity-event-service";
import { publishWorkstreamEvent } from "./integrations";
import { launchWorkstreamHarness } from "./workstream-service";

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
  system_workstream_id: string | null;
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
  const schedule = await env.DB.prepare(
    `SELECT d.id, d.workspace_id, d.user_id, u.timezone, d.enabled,
            d.system_workstream_id, d.execution_principal_json,
            u.name AS user_name, w.name AS workspace_name
       FROM digest_schedules d
       JOIN users u ON u.id = d.user_id
       JOIN workspaces w ON w.id = d.workspace_id
       JOIN workspace_members m
         ON m.workspace_id = d.workspace_id AND m.user_id = d.user_id AND m.status = 'active'
      WHERE d.id = ? AND d.workspace_id = ?`,
  ).bind(input.scheduleId, input.workspaceId).first<DigestScheduleRow>();
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

  const latest = await latestActivityEventCursor(env, schedule.workspace_id);
  const from = await previousCursor(env, schedule.id);
  const notBefore = from ? null : new Date(Date.now() - FIRST_DIGEST_LOOKBACK_MS).toISOString();

  const events = await listActivityEventsForUser(env, {
    workspaceId: schedule.workspace_id,
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

  try {
    const workstreamId = await ensureDigestWorkstream(env, schedule);
    const messageId = await appendDigestBriefMessage(env, {
      workspaceId: schedule.workspace_id,
      workstreamId,
      deliveryId,
      brief: renderDigestBrief(schedule, events),
    });
    const harnessRunId = await launchWorkstreamHarness(env, {
      workspaceId: schedule.workspace_id,
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
    // Only a claim that never reached a harness is released, so the scheduler's
    // retry gets another attempt at this occurrence. A `running` row is left
    // alone deliberately: if the launch succeeded and only the status write
    // failed, deleting it would strand the live run — settlement would find no
    // delivery, drop the digest, and the retry would start a second run with no
    // uniqueness left to catch it.
    await env.DB.prepare("DELETE FROM digest_deliveries WHERE id = ? AND status = 'planned'")
      .bind(deliveryId).run().catch(() => undefined);
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
 * The hidden work stream a person's digest runs execute in.
 *
 * The agent loop is work-stream shaped end to end — transcript, compaction, tool
 * invocations, artifacts and the realtime room all key off `workstream_id` — so
 * running the *normal* loop rather than a bespoke one means having a work
 * stream. `system_kind` keeps it out of every listing surface, and it is created
 * once per person rather than once per run, so the sidebar gains nothing and a
 * later digest can see what earlier ones already said.
 */
async function ensureDigestWorkstream(env: Env, schedule: DigestScheduleRow): Promise<string> {
  if (schedule.system_workstream_id) return schedule.system_workstream_id;
  const workstreamId = newId();
  const at = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO workstreams
         (id, workspace_id, title, objective, origin_type, created_by_user_id,
          harness_status, last_activity_at, created_at, updated_at, system_kind, scope)
       VALUES (?, ?, ?, ?, 'ad_hoc', ?, 'idle', ?, ?, ?, 'digest', 'personal')`,
    ).bind(
      workstreamId,
      schedule.workspace_id,
      `Digest · ${schedule.user_name}`,
      "Write this person's scheduled digest of what changed since the last one.",
      schedule.user_id,
      at, at, at,
    ),
    // The recipient is the sole participant, which is what makes every tool the
    // run reaches for resolve against their own access and nobody else's.
    env.DB.prepare(
      `INSERT OR IGNORE INTO workstream_participants
         (workstream_id, user_id, added_by_user_id, participation_reason, joined_at, removed_at)
       VALUES (?, ?, ?, 'creator', ?, NULL)`,
    ).bind(workstreamId, schedule.user_id, schedule.user_id, at),
    env.DB.prepare(
      "UPDATE digest_schedules SET system_workstream_id = ?, updated_at = ? WHERE id = ? AND system_workstream_id IS NULL",
    ).bind(workstreamId, at, schedule.id),
  ]);
  const stored = await env.DB.prepare(
    "SELECT system_workstream_id FROM digest_schedules WHERE id = ?",
  ).bind(schedule.id).first<{ system_workstream_id: string | null }>();
  // A concurrent firing may have won the claim; its work stream is canonical.
  if (stored?.system_workstream_id && stored.system_workstream_id !== workstreamId) {
    await env.DB.prepare("DELETE FROM workstreams WHERE id = ? AND system_kind = 'digest'")
      .bind(workstreamId).run();
    return stored.system_workstream_id;
  }
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
  const messageId = newId();
  const clientMessageId = `digest:${input.deliveryId}`;
  const at = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages
         (id, client_message_id, workspace_id, workstream_id, author_type, author_user_id,
          message_type, text_content, structured_content_json, sequence_number, created_at)
       SELECT ?, ?, ?, w.id, 'system', NULL, 'system', ?, NULL, w.next_sequence_number, ?
         FROM workstreams w WHERE w.id = ? AND w.workspace_id = ?
       ON CONFLICT(workstream_id, client_message_id) DO NOTHING`,
    ).bind(messageId, clientMessageId, input.workspaceId, input.brief, at, input.workstreamId, input.workspaceId),
    env.DB.prepare(
      `UPDATE workstreams
          SET next_sequence_number = next_sequence_number + 1, last_activity_at = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ?
          AND EXISTS (SELECT 1 FROM messages WHERE id = ?)`,
    ).bind(at, at, input.workstreamId, input.workspaceId, messageId),
  ]);
  const stored = await createDatabase(env.DB).workstreams.getMessageByClientId(
    input.workspaceId,
    input.workstreamId,
    clientMessageId,
  );
  if (stored) {
    await publishWorkstreamEvent(env, input.workspaceId, input.workstreamId, {
      type: "message_created",
      message: stored,
    });
    return stored.id;
  }
  return messageId;
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
 * The output contract is Markdown rather than a structured schema, because the
 * run is the ordinary agent loop and its product is a message. The instructions
 * name the small subset the email renderer styles richly — `##` sections,
 * bullets, links, bold, blockquote — and anything outside it degrades to
 * readable text rather than breaking the layout.
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
    "- Summarize only what is new. Earlier digests in this work stream that were actually sent are marked as delivered; do not restate those. A summary with no delivery note never reached them, so cover it again.",
    "- If an item below is only a fragment and the detail matters, use your tools to read the full context before summarizing it.",
    "- No sign-off, no restating these instructions, no commentary about being an assistant.",
    "",
    `## Source material (${events.length} item${events.length === 1 ? "" : "s"})`,
    ...sections,
  ].join("\n");
  return truncateUtf16Safe(brief, MAX_PROMPT_CHARACTERS);
}
