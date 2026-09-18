import { z } from "zod";

/**
 * One member of a Choice question's closed set.
 *
 * The three fields are the shape `docs/jev-best-practices.md` requires of every
 * criterion, expressed as a type so a new question cannot ship with the easy
 * centre of a class described and its boundaries left to the model: `meaning`
 * is the positive definition, `include` the situations that belong, and
 * `exclude` the nearest confusing situations that do not.
 */
export interface JevChoiceCriterion {
  meaning: string;
  include: readonly string[];
  exclude: readonly string[];
}

/** The three layers of a Choice instruction: the decision, what to judge, and the demand for exactly one answer. */
export interface JevChoiceInstructions {
  question: string;
  focus: string;
  decision: string;
}

/**
 * A Choice question, keyed by the closed set of answers it admits.
 *
 * `Choice` is a union of string literals, so the criteria record is exhaustive
 * by construction and the answer schema below is derived from the same union
 * rather than written a second time.
 */
export interface JevChoiceQuestion<Choice extends string> {
  readonly type: "choice";
  readonly instructions: JevChoiceInstructions;
  readonly criteria: Readonly<Record<Choice, JevChoiceCriterion>>;
}

/**
 * Declare one Choice question.
 *
 * The literal it returns is what goes on the wire under `questions.<name>`, so
 * a question is data a caller can hold, compare, and hand to an evaluation
 * unchanged. That matters more than it looks: the whole application request is
 * what an ablation compares, and a question assembled inline at the call site
 * cannot be preserved next to the answer it produced.
 */
export function jevChoiceQuestion<const Choice extends string>(definition: {
  instructions: JevChoiceInstructions;
  criteria: Readonly<Record<Choice, JevChoiceCriterion>>;
}): JevChoiceQuestion<Choice> {
  return { type: "choice", instructions: definition.instructions, criteria: definition.criteria };
}

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
