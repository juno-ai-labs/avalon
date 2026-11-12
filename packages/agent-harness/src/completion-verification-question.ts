import { z } from "zod";
import { jevSingleChoiceAnswers } from "./jev";
export { questions } from "./prompts/completion-verification-question";

export const choices = ["announces_unfinished_work", "answer_or_result", "blocker_or_question", "unclear"] as const;
export type Choice = (typeof choices)[number];
export const answers = jevSingleChoiceAnswers("stopping", choices);
const contextSchema = z.object({ id: z.string(), role: z.string(), text: z.string(), relation: z.string() });
export const completionStateSchema = z.object({
    triggering_request: z.object({ id: z.string(), text: z.string(), origin: z.string() }),
    linked_context: z.array(contextSchema), candidate_final: z.string(),
    tool_receipts: z.array(z.object({
      id: z.string(), operation: z.string(), target: z.record(z.string(), z.unknown()),
      status: z.string(), summary: z.string().nullable(), output_refs: z.array(z.string()),
    })),
    context_status: z.enum(["resolved", "unresolved"]), evidence_coverage: z.string(),
  });
export type CompletionState = z.infer<typeof completionStateSchema>;
export type CompletionAnswer = { choice: Choice; confidence: number };
