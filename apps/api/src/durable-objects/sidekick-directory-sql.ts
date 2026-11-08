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

