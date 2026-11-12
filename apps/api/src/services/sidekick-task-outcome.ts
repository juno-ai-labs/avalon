import type { HarnessPlugin } from "@rally/agent-harness";
import type { WorkstreamWorkflowInput } from "@rally/contracts";
import { z } from "zod";

import type { ToolReceiptRecord } from "../durable-objects/workstream-tool-receipt-storage";
import { parseRpcInput } from "../lib/rpc-input";
import { SIDEKICK_TASK_OUTCOME_SYSTEM_MESSAGE } from "../prompts/sidekick-task-outcome-plugin";

export const SIDEKICK_TASK_OUTCOME_CAPABILITY = "rally.sidekick.report_outcome";
export const SidekickTaskOutcomeSchema = z.strictObject({
  outcome: z.enum(["succeeded", "blocked", "failed"]).describe("succeeded means all requested outputs and required tool deliveries are confirmed; blocked means a dependency prevents completion; failed means the task failed."),
  summary: z.string().min(1).describe("What completed and what remains unresolved, with a concrete recovery step when needed; exclude secrets and raw provider errors."),
});
export type SidekickTaskOutcome = z.infer<typeof SidekickTaskOutcomeSchema>;

export function reportsSidekickTaskOutcome(input: Pick<WorkstreamWorkflowInput,
  "automationRun" | "backgroundAgent" | "automationDelegation">): boolean {
  return Boolean(input.automationRun && !input.backgroundAgent && !input.automationDelegation);
}

/** The ordinary tool receipt is the durable outcome; there is no second ledger. */
export function createSidekickTaskOutcomePlugin(input: WorkstreamWorkflowInput): HarnessPlugin | null {
  if (!reportsSidekickTaskOutcome(input)) return null;
  return {
    canonicalId: "rally:sidekick-outcome", modelId: "rally_sidekick_outcome", shortWireName: "sidekick",
    displayName: "Sidekick task outcome", description: "Record whether this activation accomplished its task.",
    preload: true, explicit: true,
    systemMessage: SIDEKICK_TASK_OUTCOME_SYSTEM_MESSAGE,
    tools: [{
      definition: {
        name: "report_outcome", capability: SIDEKICK_TASK_OUTCOME_CAPABILITY,
        description: "Record the final task outcome after work and delivery attempts. This records an outcome; it does not deliver a notification.",
        // Serial with task writes, but safe to replay: the receipt is the only effect.
        mode: "write", idempotency: "safe", inputSchema: z.toJSONSchema(SidekickTaskOutcomeSchema),
      },
      serial: true,
      validateInput: (raw) => { const result = SidekickTaskOutcomeSchema.safeParse(raw); return result.success ? null : result.error; },
      execute: async (raw) => {
        const result = SidekickTaskOutcomeSchema.parse(raw);
        return { output: result, summary: result.summary };
      },
    }],
  };
}

/** Only a completed receipt establishes that the model's declaration committed. */
export function sidekickTaskOutcomeFromReceipts(receipts: readonly Pick<ToolReceiptRecord, "status" | "inputJson">[]): SidekickTaskOutcome | null {
  const latest = receipts.at(-1);
  return latest?.status === "completed"
    ? parseRpcInput(SidekickTaskOutcomeSchema, JSON.parse(latest.inputJson), "sidekick_task_outcome") : null;
}
