/**
 * SPIKE — throwaway. Not production code, not on the release path.
 *
 * The internal replay context a demo-pack seeder threads through Rally's own
 * mutation paths so a seeded fact can carry a historical instant instead of the
 * instant it was written.
 *
 * Two rules this file exists to hold:
 *
 * - `occurredAt` is for *visible event timestamps and time-derived identities*
 *   only. Alarms, leases, retries, and expiry keep reading real system time, so
 *   nothing seeded can wedge a lease in the past or arm an alarm that never
 *   fires. `Date.now()` is never globally stubbed.
 * - The context is internal. No public HTTP route accepts one. The spike's own
 *   dev-gated route accepts a workspace id and nothing else; every instant in
 *   the pack is derived from the seeding moment by a fixed offset held in
 *   `pack.ts`.
 */
import { z } from "zod";

/** A recorded provider turn: what the model "said" at this step. */
export const SpikeFixtureTurnSchema = z.discriminatedUnion("kind", [
  /** One assistant turn whose whole content is text, ending the loop. */
  z.strictObject({ kind: z.literal("say"), text: z.string().min(1) }),
  /**
   * One assistant turn that emits tool calls. Every call names a plugin the
   * spike registers for this run and carries the result the provider *would*
   * have got back, so nothing outbound happens and no connector is required.
   */
  z.strictObject({
    kind: z.literal("tools"),
    calls: z.array(z.strictObject({
      id: z.string().min(1),
      /** Model-facing plugin id, e.g. `plugin_google_drive`. */
      pluginModelId: z.string().min(1),
      toolName: z.string().regex(/^[a-z][a-z0-9_.-]*$/u),
      arguments: z.record(z.string(), z.unknown()),
      /** The recorded provider answer, verbatim, as the tool's output. */
      result: z.string().min(1),
      summary: z.string().min(1),
      /** How long the recorded call took; the transcript renders it. */
      durationMs: z.number().int().nonnegative().max(600_000),
    })).min(1).max(6),
  }),
  /**
   * One assistant turn that ends in a blocking question, through the real
   * `core_request_elicitation` core tool.
   */
  z.strictObject({
    kind: z.literal("elicit"),
    id: z.string().min(1),
    prompt: z.string().min(1),
    options: z.array(z.string().min(1)).min(1).max(8),
    allowFreeText: z.boolean(),
  }),
]);
export type SpikeFixtureTurn = z.infer<typeof SpikeFixtureTurnSchema>;

/** A plugin the spike registers so recorded connector calls have a home. */
export const SpikeFixturePluginSchema = z.strictObject({
  modelId: z.string().min(1),
  shortWireName: z.string().min(1).max(20),
  displayName: z.string().min(1).max(80),
  description: z.string().min(1).max(400),
  tools: z.array(z.strictObject({
    name: z.string().regex(/^[a-z][a-z0-9_.-]*$/u),
    description: z.string().min(1).max(400),
  })).min(1).max(6),
});
export type SpikeFixturePlugin = z.infer<typeof SpikeFixturePluginSchema>;

/** The recorded model output one harness run replays instead of inferring. */
export const SpikeAssistantFixtureSchema = z.strictObject({
  plugins: z.array(SpikeFixturePluginSchema).max(6).default([]),
  turns: z.array(SpikeFixtureTurnSchema).min(1).max(8),
  /**
   * Who an elicitation this run opens is addressed to.
   *
   * `elicitation_requests.target_user_id` exists in the object schema and in
   * `openPreparedElicitation`'s input, and no production caller has ever set
   * it — `core_request_elicitation` passes `null` unconditionally. The spike
   * passes it, at that one call site, to find out whether the rest of the
   * product honours a targeted question. See SPIKE-REPORT.md.
   */
  elicitationTargetUserId: z.string().uuid().nullable().default(null),
});
export type SpikeAssistantFixture = z.infer<typeof SpikeAssistantFixtureSchema>;

/**
 * The value threaded through the canonical mutation paths a seed touches.
 *
 * `packRunId` and `actionId` are not decoration: a replayed pack writes the
 * same shapes twice (W1 and W2), and without them a log line or a stuck row
 * cannot be traced back to which pack run and which step produced it.
 */
export const ReplayContextSchema = z.strictObject({
  /** Unix ms the seeded event should claim to have happened at. */
  occurredAt: z.number().int().positive(),
  packRunId: z.string().uuid(),
  actionId: z.string().min(1).max(120),
  workspaceId: z.string().uuid(),
  /** Recorded model output for the run this mutation starts, when it starts one. */
  assistant: SpikeAssistantFixtureSchema.optional(),
});
export type ReplayContext = z.infer<typeof ReplayContextSchema>;

/**
 * The one accessor every production edit goes through.
 *
 * A single named function is what makes the spike's blast radius greppable:
 * `spikeOccurredAt` is the whole list of places production time was replaced.
 */
export function spikeOccurredAt(replay: ReplayContext | undefined, fallback: number): number {
  return replay?.occurredAt ?? fallback;
}
