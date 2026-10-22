import type { HarnessPlugin, HarnessToolContext, HarnessToolPolicyIdentity, HarnessToolReplayRefusal } from "@rally/agent-harness";

/** Read-only gate before loading or emitting a historical completed result. */
export async function validateCompletedToolReplay(
  plugins: readonly HarnessPlugin[],
  policy: { pluginId: string } & HarnessToolPolicyIdentity,
  recordedInput: unknown,
  context: HarnessToolContext,
): Promise<HarnessToolReplayRefusal | null> {
  const tool = plugins.find((plugin) => plugin.canonicalId === policy.pluginId)?.tools.find((candidate) =>
    candidate.definition.name === policy.canonicalToolName && candidate.definition.capability === policy.capability
    && candidate.definition.mode === policy.mode && candidate.definition.idempotency === policy.idempotency);
  const decision = await tool?.validateCompletedReplay?.(recordedInput, context);
  return decision?.allowed === false ? { refusal: { code: decision.code, message: decision.message } } : null;
}
