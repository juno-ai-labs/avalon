import { asAutomationId, type WorkspaceId } from "@rally/contracts";
import { automationAgentName } from "../durable-objects/names";
import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";

/** Content-free attribution read from the object that owns the run envelope. */
export async function automationRunTelemetryEnvelope(
  env: Env,
  input: { workspaceId: WorkspaceId; automationId: string; runId: string },
): Promise<{ automationId: string; triggerType: string } | null> {
  const automationId = asAutomationId(input.automationId);
  const agent = await durableObjectStubForWorkspace(
    env,
    env.AUTOMATION_AGENTS,
    input.workspaceId,
    automationAgentName(env.AVALON_REGION, input.workspaceId, automationId),
  );
  return agent.readRunTelemetry({
    automationId,
    workspaceId: input.workspaceId,
    runId: input.runId,
  });
}
