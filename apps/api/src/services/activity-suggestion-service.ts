import type { WorkspaceId, WorkstreamId } from "@rally/contracts";
import { newId } from "@rally/db";
import { substreamAgentName } from "../durable-objects/substream-agent";
import type { Env } from "../env";
import type { ContentAudience } from "../lib/audience-containment";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { truncateUtf16Safe } from "../lib/text";
import { createWorkstreamRuntimeSuggestion } from "./workstream-object-client";

/**
 * Which decision produced this card.
 *
 * Required rather than defaulted, because the two producers write rows that are
 * identical in the transcript and are resolved by the same endpoint, and the
 * routing feedback in `activity-routing-feedback.ts` reads a resolution as
 * evidence about *the producer that made it*. A new producer that forgets to say
 * who it is would silently donate its dismissals to contextual routing's gates.
 */
export type ActivitySuggestionSource = "contextual_routing" | "suggested_work";

interface CreateActivitySuggestionInput {
  region: "global" | "eu";
  workspaceId: WorkspaceId;
  activityId: string;
  activityTitle: string;
  activitySummary: string;
  workstreamId: WorkstreamId;
  confidence: number;
  reason: string;
  matchedEntities: string[];
  source: ActivitySuggestionSource;
  sourceAudience: ContentAudience;
}

export async function publishSubstreamAgentEvent(
  env: Env,
  region: "global" | "eu",
  workspaceId: WorkspaceId,
  workstreamId: WorkstreamId,
  event: unknown,
): Promise<void> {
  const agent = await durableObjectStubForWorkspace(
    env,
    env.SUBSTREAM_AGENTS,
    workspaceId,
    substreamAgentName(region, workspaceId, workstreamId),
  );
  const response = await agent.publishEvent({ workspaceId, workstreamId, event });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`workstream_event_rejected:${response.status}`);
  }
}

export async function createActivitySuggestion(
  env: Env,
  input: CreateActivitySuggestionInput,
): Promise<boolean> {
  const id = newId();
  const title = truncateUtf16Safe(input.activityTitle, 300);
  const summary = truncateUtf16Safe(input.activitySummary, 2_000);
  const reason = truncateUtf16Safe(input.reason, 1_200);
  const result = await createWorkstreamRuntimeSuggestion(env, {
    workspaceId: input.workspaceId,
    workstreamId: input.workstreamId,
    suggestion: {
      id,
      activityId: input.activityId,
      title,
      summary,
      confidence: Math.max(0, Math.min(1, input.confidence)),
      reason,
      matchedEntities: input.matchedEntities.slice(0, 100),
      source: input.source,
      sourceAudience: input.sourceAudience,
    },
  });
  return result.inserted;
}
