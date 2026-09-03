import { asWorkspaceId, type WorkspaceId } from "@rally/contracts";
import { workspaceDOName } from "../durable-objects/names";
import { WorkspaceConnectorEventSchema } from "../durable-objects/workspace-connector-event-protocol";
import type { Env } from "../env";
import { activityContentAudience } from "../lib/activity-visibility";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";

interface EnqueueInput {
  workspaceId: WorkspaceId;
  partitionKey: string;
  audienceScope: "personal" | "workspace";
  audienceUserId: string | null;
  sourceKind: "activity" | "message";
  sourceId: string;
  occurredAt: string;
  inputCharacters: number;
}

async function enqueue(env: Env, input: EnqueueInput): Promise<void> {
  const workspace = await durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    input.workspaceId,
    workspaceDOName(env.AVALON_REGION, input.workspaceId),
  );
  await workspace.enqueueOpportunitySource({
    workspaceId: input.workspaceId,
    partitionKey: input.partitionKey,
    audience: { scope: input.audienceScope, userId: input.audienceUserId },
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    occurredAt: input.occurredAt,
    inputCharacters: input.inputCharacters,
  });
}

/**
 * Activity that never becomes Suggested Work, decided by event type before any
 * window is opened for it.
 *
 * Everything unclaimed used to be a candidate, and on 2 September 2026 the
 * Juno Labs workspace admitted 50,000 events in a day: 24,000 of them were CI
 * check runs and workflow-run status transitions. A check run is the status
 * of a commit, not a piece of work for a person, and a workflow run is the
 * same status a level up. Each one cost a frontier-model admission call whose
 * answer was, overwhelmingly, `ignore`.
 *
 * Calendar changes were the other 18,000 that day and are deliberately not
 * here. That volume was a connector defect — one edit to a recurring series
 * arrived as one `calendar.event_changed` per expanded instance — and it was
 * fixed where it arose: since 2026-09-02 a series edit is one activity per
 * connection. A meeting being moved or cancelled is the kind of thing that
 * produces work, so it stays a candidate.
 *
 * Every connector manifest already partitions its event types into
 * `digestible` and `operational`, and 142 of the 205 declared types are
 * operational — including exactly these two families. This list is not that
 * partition and must not become it. `activity-consumer.ts` records why:
 * Suggested Work reads the same activity independently and must not inherit
 * the digest's notification choice. The two questions differ, and the gap is
 * where a suggestion lives — "would a person want this read back to them on a
 * schedule" is No for `drive.file_changed` and `linear.comment.update`, while
 * "is there work here" may well be Yes. Inheriting the partition would
 * withhold all 142.
 *
 * What is borrowed instead is the *floor*: a type this gate withholds must be
 * one its connector already called operational, so this can never be the
 * stricter of the two, and it cannot drift into contradicting a manifest that
 * later reclassifies a type as news. `work-opportunity-batching.test.ts` binds
 * that to the registry rather than to a reviewer noticing.
 *
 * The shape is the digest gate's opposite on purpose. Digestibility is an
 * inclusion list that fails closed, because a withheld digest costs nothing.
 * This is an exclusion list that fails open, because a connector added later
 * should be offered as work until somebody finds a reason not to. Excluded
 * activity is still logged, still routes to watches and automations, and still
 * reaches the activity feed; only the speculative home-screen surface is
 * withheld.
 */
export const SUGGESTED_WORK_EXCLUDED_EVENT_TYPE_PREFIXES: readonly string[] = [
  "github.check_run.",
  "github.workflow_run.",
];

/** Whether an activity of this event type may become a Suggested Work candidate. */
export function isSuggestedWorkCandidateEventType(eventType: string): boolean {
  return !SUGGESTED_WORK_EXCLUDED_EVENT_TYPE_PREFIXES.some((prefix) => eventType.startsWith(prefix));
}

/**
 * What became of an activity offered to Suggested Work. Only `enqueued` opened
 * a window; the rest say why none was, so the consumer's terminal log can
 * record the truth rather than "unclaimed, therefore enqueued".
 */
export type SuggestedWorkEnqueueOutcome = "enqueued" | "excluded" | "missing" | "no_audience";

export async function enqueueActivityOpportunity(
  env: Env,
  activityId: string,
  knownWorkspaceId: WorkspaceId,
): Promise<SuggestedWorkEnqueueOutcome> {
  const durableActivity = WorkspaceConnectorEventSchema.nullable().parse(
    await durableObjectStubForWorkspace(
      env,
      env.WORKSPACE_DOS,
      knownWorkspaceId,
      workspaceDOName(env.AVALON_REGION, knownWorkspaceId),
    ).then((workspace) => workspace.connectorEvent({ workspaceId: knownWorkspaceId, eventId: activityId })),
  );
  if (!durableActivity) return "missing";
  if (!isSuggestedWorkCandidateEventType(durableActivity.activity.eventType)) return "excluded";
  const activity = {
    workspace_id: durableActivity.activity.workspaceId,
    connection_id: durableActivity.activity.connectionId,
    connection_scope: durableActivity.activity.connectionScope,
    connection_owner_user_id: durableActivity.activity.connectionOwnerUserId,
    occurred_at: durableActivity.activity.occurredAt,
    title: durableActivity.activity.title,
    summary: durableActivity.activity.summary,
    text_snippet: durableActivity.activity.textSnippet,
    actor_json: JSON.stringify(durableActivity.activity.actor),
    subject_json: JSON.stringify(durableActivity.activity.subject),
    visibility_json: JSON.stringify(durableActivity.activity.visibility),
    target_user_ids_json: JSON.stringify(durableActivity.activity.targetUserIds),
  };
  const workspaceId = asWorkspaceId(String(activity.workspace_id));
  const approximateCharacters = [activity.title, activity.summary, activity.text_snippet, activity.actor_json, activity.subject_json]
    .reduce<number>((sum, value) => sum + String(value ?? "").length, 0);
  const sourceAudience = activityContentAudience(activity);
  if (!sourceAudience) return "no_audience";
  const audienceUserIds = sourceAudience.scope === "users"
    ? sourceAudience.userIds
    : (await env.DB.prepare(
      `SELECT user_id FROM workspace_members
        WHERE workspace_id = ? AND status = 'active' ORDER BY user_id`,
    ).bind(workspaceId).all<{ user_id: string }>()).results.map((row) => row.user_id);
  await Promise.all(audienceUserIds.map((userId) => enqueue(env, {
    workspaceId,
    partitionKey: sourceAudience.scope === "workspace"
      ? `workspace:${userId}`
      : durableActivity.activity.connectionScope === "personal"
        ? `personal:${userId}`
        : `restricted:${String(activity.connection_id)}:${userId}`,
    audienceScope: "personal",
    audienceUserId: userId,
    sourceKind: "activity",
    sourceId: activityId,
    occurredAt: String(activity.occurred_at),
    inputCharacters: approximateCharacters,
  })));
  return audienceUserIds.length > 0 ? "enqueued" : "no_audience";
}

export async function enqueueMentionOpportunitySnapshot(
  env: Env,
  input: {
    workspaceId: WorkspaceId;
    messageId: string;
    targetUserIds: string[];
    occurredAt: string;
    inputCharacters: number;
  },
): Promise<void> {
  await Promise.all([...new Set(input.targetUserIds)].map((userId) => enqueue(env, {
    workspaceId: input.workspaceId,
    partitionKey: `mention:${userId}`,
    audienceScope: "personal",
    audienceUserId: userId,
    sourceKind: "message",
    sourceId: input.messageId,
    occurredAt: input.occurredAt,
    inputCharacters: input.inputCharacters,
  })));
}
