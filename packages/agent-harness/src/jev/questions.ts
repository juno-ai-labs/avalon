import { z } from "zod";

export {
  jevChoiceQuestion,
  type JevChoiceCriterion,
  type JevChoiceInstructions,
  type JevChoiceQuestion,
} from "@rally/prompts/harness/jev-question";

/**
 * The answer schema for one Choice question.
 *
 * `probabilities` is optional because the provider may omit it; `confidence` is
 * not, because every threshold in this tree is applied to it and a missing one
 * has to be a schema failure that names the field rather than a silent zero.
 */
export function jevChoiceAnswerSchema<Choice extends string>(
  choices: readonly [Choice, ...Choice[]],
) {
  return z.object({
    type: z.literal("choice"),
    choice: z.enum(choices),
    confidence: z.number().min(0).max(1),
    probabilities: z.record(z.string(), z.number()).optional(),
  });
}

export type JevChoiceAnswer<Choice extends string> = z.infer<ReturnType<typeof jevChoiceAnswerSchema<Choice>>>;

/** The answer schema for a single-question request, ready to hand to `askJev`. */
export function jevSingleChoiceAnswers<Name extends string, Choice extends string>(
  name: Name,
  choices: readonly [Choice, ...Choice[]],
) {
  return z.object({ [name]: jevChoiceAnswerSchema(choices) } as Record<Name, ReturnType<typeof jevChoiceAnswerSchema<Choice>>>);
}
