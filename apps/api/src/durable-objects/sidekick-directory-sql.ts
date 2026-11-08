import type { AutomationSummary, WorkstreamAppearance } from "@rally/contracts";
import { WorkstreamAppearanceSchema } from "@rally/contracts";
import { zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";

/**
 * The Sidekick list's directory row, the summary it draws, and the SQL the
 * sidebar and the library list share to say who a Sidekick is listed to and
 * whether it is unread. Moved here from `channel-rails.ts` when the Channel
 * rail that also read it was deleted (plan step C-2).
 */

export type InvalidAppearanceReport = (automationId: string, code: string) => void;

export interface AutomationDirectoryRow extends Record<string, SqlStorageValue> {
  loadable: number | null;
  appearance_json: string | null;
  automation_id: string;
  lifecycle: "draft" | "active" | "paused";
  scope: "personal" | "workspace";
  title: string;
  description: string;
  next_run_at: number | null;
  projected_at: number;
}

/** A stored appearance, or undefined with the reason reported when it no longer parses. */
export function parsedAppearance(json: string | null, prefix: string, report: (code: string) => void): WorkstreamAppearance | undefined {
  if (!json) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    report(`${prefix}_invalid:-root-:invalid_json`);
    return undefined;
  }
  const parsed = WorkstreamAppearanceSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  report(zodDiagnosticCode(parsed.error, prefix) ?? `${prefix}_invalid`);
  return undefined;
}

function storedAppearance(row: AutomationDirectoryRow, report: InvalidAppearanceReport): WorkstreamAppearance | undefined {
  return parsedAppearance(row.appearance_json, "automation_appearance", (code) => report(row.automation_id, code));
}

/** A directory row as a summary; an appearance that no longer parses is left out and reported. */
export function automationSummary(
  row: AutomationDirectoryRow & {
    last_run_at?: number | null;
    /** Rows on the `people` list (`AUTOMATION_AUDIENCE_SQL`); absent from a read that did not ask. */
    shared_count?: number;
    /** The viewer's read state of the shared conversation (`AUTOMATION_VIEWER_SQL`); sidebar reads only. */
    unread?: number;
    needs_input?: number;
    /** `AUTOMATION_RUN_STATE_SQL`; absent from a read that did not ask. */
    run_state?: "working" | "needs_input" | null;
    pending_question?: string | null;
    /** `AUTOMATION_RUNNING_SQL`; absent from a read that did not ask. */
    running?: number;
    /** `AUTOMATION_TRIGGER_KINDS_SQL`, a JSON array; absent from a read that did not ask. */
    trigger_kinds?: string | null;
    /** `AUTOMATION_SCHEDULE_TIME_ZONE_SQL`; absent from a read that did not ask. */
    schedule_time_zone?: string | null;
  },
  report: InvalidAppearanceReport,
): AutomationSummary {
  const appearance = storedAppearance(row, report);
  return {
    id: row.automation_id,
    loadable: row.loadable === 1,
    ...(appearance ? { appearance } : {}),
    name: row.title || "New Sidekick",
    description: row.description,
    emailAddress: null,
    scope: row.scope,
    status: row.lifecycle,
    nextRunAt: row.next_run_at === null ? null : new Date(row.next_run_at).toISOString(),
    lastRunAt: row.last_run_at == null ? null : new Date(row.last_run_at).toISOString(),
    updatedAt: new Date(row.projected_at).toISOString(),
    ...(row.shared_count === undefined ? {} : {
      audience: row.shared_count > 0 ? "people" as const : row.scope === "workspace" ? "workspace" as const : "personal" as const,
    }),
    ...(row.unread === undefined ? {} : { unread: row.unread === 1 }),
    ...(row.needs_input === undefined ? {} : { needsInput: row.needs_input === 1 }),
    ...(row.run_state === undefined ? {} : { runState: row.run_state }),
    ...(row.running === undefined ? {} : { running: row.running === 1 }),
    ...(row.pending_question === undefined ? {} : { pendingQuestion: row.pending_question }),
    ...(row.trigger_kinds === undefined ? {} : { triggerKinds: JSON.parse(row.trigger_kinds ?? "[]") as AutomationSummary["triggerKinds"] }),
    ...(row.schedule_time_zone == null ? {} : { scheduleTimeZone: row.schedule_time_zone }),
  };
}

/** `shared_count` for `automationSummary`, over an `automation_directory` aliased `directory`. */
export const AUTOMATION_AUDIENCE_SQL = `(SELECT COUNT(*) FROM sidekick_audience shared
   WHERE shared.sidekick_id = directory.automation_id) AS shared_count`;

/**
 * `unread` and `needs_input` for `automationSummary`, for the viewer bound to
 * `?1`, over an `automation_directory` aliased `directory`.
 *
 * Unread is the shared conversation's own read state as it last reported it
 * for this viewer (`sidekick_viewer_reads`) against its latest attention
 * ordinal (its `directory_common` projection): a manual unread mark, or a
 * message past what they saw. A viewer who has never opened the conversation
 * has no read state there and reads as unread, as a Channel they have not
 * opened is `unseen`; its author, who wrote it in that conversation, does not.
 * Needs input is the delegation attention, the shared conversation waiting on
 * input, or any of its runs waiting on input (`sidekick_runs`, which a run's
 * own conversation moves through its projection): a run that asks a question
 * is what most often needs someone, and its question is asked in the run, not
 * in `"0"`. The primary key's `sidekick_id` prefix bounds the run probe to
 * this Sidekick's rows.
 */
export const AUTOMATION_VIEWER_SQL = `CASE
     WHEN reads.user_id IS NULL THEN CASE WHEN directory.author_user_id = ?1 THEN 0 ELSE 1 END
     WHEN reads.manual_unread_from_ordinal IS NOT NULL THEN 1
     WHEN COALESCE(json_extract(main.effect_json, '$.latestAttentionOrdinal'), 0) > reads.seen_attention_ordinal THEN 1
     ELSE 0 END AS unread,
   CASE WHEN directory.delegation_attention_code IS NOT NULL
          OR json_extract(main.effect_json, '$.state') = 'needs_input'
          OR EXISTS (SELECT 1 FROM sidekick_runs waiting
                      WHERE waiting.sidekick_id = directory.automation_id AND waiting.state = 'needs_input')
        THEN 1 ELSE 0 END AS needs_input`;

/**
 * `run_state` and `pending_question` for `automationSummary`, over an
 * `automation_directory` aliased `directory`.
 *
 * The run state is the newest run's live state: `working` while it is queued
 * or running, `needs_input` while it waits, and null once it has finished or
 * when there is no run. The pending question is what the newest *waiting* run
 * waits on, whichever run is newest: its summary, which for a run that asked
 * is the question it asked (`commonEffect` sends the open elicitation's prompt
 * as a waiting run's reply), and for a run admitted with no delegate is that
 * notice. The two are read from different runs on purpose: a Sidekick whose
 * older run still waits while a later one works reads Working with the old
 * question as its second line, because the question is still open and is
 * what a person needs to see; reading it from the newest run only lost it
 * after a later run started (vis2-v2 R2-1). The probe reads this Sidekick's
 * runs through `sidekick_runs_history_idx`'s prefix, newest first, and stops
 * at the first waiting one; when none waits it reads all of them, as the
 * Needs input probe beside it already does.
 */
export const AUTOMATION_RUN_STATE_SQL = `CASE WHEN latest_run.state IN ('pending', 'running') THEN 'working'
          WHEN latest_run.state = 'needs_input' THEN 'needs_input' END AS run_state,
   (SELECT waiting.summary FROM sidekick_runs waiting
     WHERE waiting.sidekick_id = directory.automation_id AND waiting.state = 'needs_input'
     ORDER BY waiting.created_at DESC, waiting.run_id DESC LIMIT 1) AS pending_question`;

/**
 * `running` for `automationSummary`, over an `automation_directory` aliased
 * `directory`: whether any run of the Sidekick is working now, queued or
 * running, whichever run is newest. `run_state` reads the newest run alone,
 * so an older run still working behind a finished newer one read as idle;
 * the row and the Sidekicks home read Working from this instead (the owner,
 * 2026-11-08: "add this"). The states are the ones `sidekickRowRunState`
 * calls working, so every transition that moves this already sends the list
 * again. Bounded to this Sidekick's runs by the primary key's prefix.
 */
export const AUTOMATION_RUNNING_SQL = `EXISTS (SELECT 1 FROM sidekick_runs live
     WHERE live.sidekick_id = directory.automation_id AND live.state IN ('pending', 'running')) AS running`;

/**
 * The join `AUTOMATION_RUN_STATE_SQL` reads for the run state: the newest
 * run, found by one probe of `sidekick_runs_history_idx` and read by its
 * primary key.
 */
export const AUTOMATION_RUN_STATE_JOINS = `LEFT JOIN sidekick_runs latest_run
     ON latest_run.sidekick_id = directory.automation_id
    AND latest_run.run_id = (SELECT newest.run_id FROM sidekick_runs newest
                              WHERE newest.sidekick_id = directory.automation_id
                              ORDER BY newest.created_at DESC, newest.run_id DESC LIMIT 1)`;

/**
 * `trigger_kinds` for `automationSummary`, over an `automation_directory`
 * aliased `directory`: what wakes the Sidekick, as a JSON array in the run
 * trigger vocabulary (`AutomationRunSchema.triggerType`), each kind once, in
 * the order the definition first names it. A calendar or interval trigger is
 * `schedule`; a connector, semantic, resource-watch or webhook trigger is
 * `external_event`, the run kind each of them starts. Read from the accepted
 * definition, or for a draft the newest one submitted, so the Sidekicks home
 * can say "On alert", "On email" or "On request" where a schedule would say
 * when. A trigger type this server does not map is left out.
 */
export const AUTOMATION_TRIGGER_KINDS_SQL = `(SELECT json_group_array(kind ORDER BY first_named) FROM (
     SELECT CASE json_extract(named.value, '$.type')
              WHEN 'manual' THEN 'manual'
              WHEN 'inbound_email' THEN 'inbound_email'
              WHEN 'calendar' THEN 'schedule' WHEN 'interval' THEN 'schedule'
              WHEN 'connector_activity' THEN 'external_event' WHEN 'semantic_activity' THEN 'external_event'
              WHEN 'resource_watch' THEN 'external_event' WHEN 'webhook' THEN 'external_event'
            END AS kind, MIN(CAST(named.key AS INTEGER)) AS first_named
       FROM sidekick_revisions revision, json_each(revision.definition_json, '$.triggers') named
      WHERE revision.sidekick_id = directory.automation_id
        AND revision.definition_revision = COALESCE(directory.accepted_definition_revision,
          (SELECT MAX(newest.definition_revision) FROM sidekick_revisions newest
            WHERE newest.sidekick_id = directory.automation_id))
      GROUP BY kind HAVING kind IS NOT NULL)) AS trigger_kinds`;

/**
 * `schedule_time_zone` for `automationSummary`, over an `automation_directory`
 * aliased `directory`: the zone of the schedule that comes due next, the one
 * `next_run_at` is (`touchDirectory` takes the earliest `next_due_at`), as
 * its stored definition resolved it when the revision was accepted (the
 * trigger's own zone, else the owner's or the Organization's). Null for an
 * interval, which has no wall-clock time, and when there is no schedule.
 * Without it the sidebar and the home formatted `nextRunAt` in the machine's
 * zone while the details read the schedule's own summary, so one schedule
 * showed two times (vis2-v2 R2-7). The probe is bounded to this Sidekick's
 * schedules by the primary key's prefix.
 */
export const AUTOMATION_SCHEDULE_TIME_ZONE_SQL = `(SELECT json_extract(schedule.definition_json, '$.timezone')
     FROM sidekick_schedules schedule
    WHERE schedule.sidekick_id = directory.automation_id AND schedule.next_due_at IS NOT NULL
    ORDER BY schedule.next_due_at, schedule.schedule_id LIMIT 1) AS schedule_time_zone`;

/** The live run state a run's own state contributes to its Sidekick's row (`AUTOMATION_RUN_STATE_SQL`). */
export function sidekickRowRunState(state: string | null | undefined): "working" | "needs_input" | null {
  return state === "pending" || state === "running" ? "working" : state === "needs_input" ? "needs_input" : null;
}

/** The joins `AUTOMATION_VIEWER_SQL` reads, for the viewer bound to `?1`. */
export const AUTOMATION_VIEWER_JOINS = `LEFT JOIN sidekick_viewer_reads reads
     ON reads.sidekick_id = directory.automation_id AND reads.user_id = ?1
   LEFT JOIN sidekick_child_projections main
     ON main.sidekick_id = directory.automation_id AND main.substream_id = '0'`;

/**
 * Whether the sidebar lists a Sidekick to the viewer bound to `?1`, in the
 * Organization bound to `?2`, over an `automation_directory` aliased
 * `directory`: the viewer's own, the Organization's, and those shared with them.
 */
export const SIDEBAR_SIDEKICK_LISTED_SQL = `directory.workspace_id = ?2 AND directory.lifecycle <> 'deleted'
   AND (directory.scope = 'workspace' OR directory.author_user_id = ?1 OR directory.run_as_user_id = ?1
     OR EXISTS (SELECT 1 FROM sidekick_audience audience
                 WHERE audience.sidekick_id = directory.automation_id AND audience.user_id = ?1))`;

