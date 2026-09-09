import { z } from "zod";

/**
 * What a seeded run says instead of inferring it.
 *
 * A demo workspace's history is written through Rally's ordinary paths, and a
 * seeded assistant turn is produced by an ordinary run: the same admission, the
 * same Bind loop, the same reserved turn and the same settlement. The one thing
 * that differs is where the model's bytes come from — the run's provider `fetch`
 * is answered from this script instead of from OpenRouter. This is that script,
 * carried on the message that starts the run and, from there, on the run's own
 * execution context. `docs/demo-workspaces.md` owns the feature.
 *
 * Exactly one turn, deliberately. A seeded run makes no tool calls — a stale
 * tool name in seeded history is a wrong claim about what Rally did, and the
 * feature rejects fabricated tool history outright — and without tool calls Bind
 * asks the provider once: a text answer ends the loop, and a question opens a
 * real elicitation and parks the run on it. There is nothing a second scripted
 * turn could be served to, so the seam refuses a second request outright rather
 * than repeating the turn.
 */
export const DemoSeedTurnSchema = z.discriminatedUnion("kind", [
  /** One assistant turn whose whole content is text. The run completes. */
  z.strictObject({
    kind: z.literal("say"),
    text: z.string().min(1).max(20_000),
  }),
  /**
   * One assistant turn that ends in a blocking question, through the real
   * `core_request_elicitation` tool with the arguments it validates. It is
   * addressed to the room: the elicitation contract has no addressee, and this
   * feature does not add one. The run settles as `needs_input`, and whoever
   * answers starts an ordinary, unseeded run.
   */
  z.strictObject({
    kind: z.literal("ask"),
    prompt: z.string().min(1).max(4_000),
    /** Radio options, each its own value and label. */
    options: z.array(z.string().min(1).max(200)).min(2).max(8),
  }),
]);
export type DemoSeedTurn = z.infer<typeof DemoSeedTurnSchema>;

/**
 * The seed a demo message carries.
 *
 * Its presence is what makes a message a seed action. The object then decides
 * addressing from `assistant` rather than by asking a classifier model: `null`
 * says this human turn starts no run, a turn says it starts one that answers
 * from the turn. Pack and action identity are what a log line or a stuck run is
 * traced back to. There is deliberately no instant here — a seeded fact is
 * stamped with the real clock like any other.
 */
export const DemoSeedSchema = z.strictObject({
  packVersion: z.string().min(1).max(80),
  actionId: z.string().min(1).max(80),
  assistant: DemoSeedTurnSchema.nullable(),
});
export type DemoSeed = z.infer<typeof DemoSeedSchema>;
