import { IdSchema } from "@rally/contracts";
import { z } from "zod";

/**
 * The workspace's Terminal network policy, as questions rather than SQL.
 *
 * The policy row, its custom domains, and the mutation ledger that records a
 * preview and its outcome are all WorkspaceDO tables, and the settings service
 * used to reach them as fifteen statements through the workspace runtime
 * facade. That facade routes by table name and sends anything it does not
 * recognise to the regional database; and it splits what is logically one
 * decision into a statement per round trip, which is what made the apply path
 * need compensating writes when a claim half-succeeded.
 */

const TimestampSchema = z.string().datetime({ offset: true });
const TerminalNetworkModeSchema = z.enum(["trusted_only", "full_internet"]);
const VerificationStateSchema = z.enum(["pending", "verified", "failed"]);

export const WorkspaceTerminalNetworkPolicySchema = z.object({
  mode: TerminalNetworkModeSchema,
  revision: z.number().int().positive(),
  verificationState: VerificationStateSchema,
  baselineManifestVersion: z.string().min(1),
  failureCode: z.string().min(1).nullable(),
  /**
   * The compiled allow-list the last verified policy published.
   *
   * Stored rather than recompiled on read, because it is what the sandbox
   * provider was actually told: recompiling would answer what the current code
   * *would* send, which is the same thing right up until the manifest changes.
   */
  effectiveDomains: z.array(z.string().min(1)),
}).strict();

/**
 * The policy and its domains together, because nothing ever wants one alone.
 *
 * Every caller that read the policy also read the domain list to compile it,
 * which was two statements and is one question. The read creates the workspace's
 * default policy when there is none, so a workspace that has never opened the
 * setting still answers.
 */
export const WorkspaceTerminalNetworkSettingsRequestSchema = z.object({
  workspaceId: IdSchema,
  /** The default row's manifest version, when this read is the one that creates it. */
  baselineManifestVersion: z.string().min(1),
  defaultEffectiveDomains: z.array(z.string().min(1)),
  at: TimestampSchema,
}).strict();

export const WorkspaceTerminalNetworkSettingsSchema = z.object({
  policy: WorkspaceTerminalNetworkPolicySchema,
  customDomains: z.array(z.string().min(1)),
}).strict();

/**
 * The mode alone, without creating anything.
 *
 * The Terminal plugin reads it on every agent turn to tell the model what
 * egress it has. That is a read on a hot path, so it does not take the
 * creating read above: a workspace that has never opened the setting answers
 * `null` and the caller uses the same default the settings screen would have
 * written, rather than the agent loop writing a row as a side effect.
 */
export const WorkspaceTerminalNetworkModeSchema = z.object({
  mode: TerminalNetworkModeSchema.nullable(),
}).strict();

export const WorkspaceTerminalPolicyPreviewRequestSchema = z.object({
  workspaceId: IdSchema,
  mutationId: IdSchema,
  requestedByUserId: IdSchema,
  expectedRevision: z.number().int().positive(),
  proposedMode: TerminalNetworkModeSchema,
  proposedDomains: z.array(z.string().min(1)),
  effectiveDomains: z.array(z.string().min(1)),
  affectedWorkstreamIds: z.array(IdSchema),
  at: TimestampSchema,
}).strict();

export const WorkspaceTerminalPolicyClaimRequestSchema = z.object({
  workspaceId: IdSchema,
  mutationId: IdSchema,
  requestedByUserId: IdSchema,
  expectedRevision: z.number().int().positive(),
  at: TimestampSchema,
}).strict();

/**
 * Why the claim ended, and the mutation it claimed.
 *
 * As four separate statements the claim could take the policy row and then
 * fail to take the mutation row, which is why the service carried a
 * `restoreCurrentPolicy` compensation. One transaction cannot half-succeed, so
 * a refusal here means nothing was written and there is nothing to undo.
 */
export const WorkspaceTerminalPolicyClaimResultSchema = z.object({
  outcome: z.enum(["claimed", "preview_stale", "revision_conflict"]),
  mutation: z.object({
    proposedMode: TerminalNetworkModeSchema,
    proposedDomains: z.array(z.string().min(1)),
    effectiveDomains: z.array(z.string().min(1)),
  }).strict().nullable(),
  /** The policy as it stood when the claim was decided. */
  current: WorkspaceTerminalNetworkPolicySchema.nullable(),
  currentCustomDomains: z.array(z.string().min(1)),
}).strict();

export const WorkspaceTerminalPolicyFailRequestSchema = z.object({
  workspaceId: IdSchema,
  mutationId: IdSchema,
  revision: z.number().int().positive(),
  failureCode: z.string().min(1),
  at: TimestampSchema,
}).strict();

export const WorkspaceTerminalPolicyCommitRequestSchema = z.object({
  workspaceId: IdSchema,
  mutationId: IdSchema,
  createdByUserId: IdSchema,
  mode: TerminalNetworkModeSchema,
  claimedRevision: z.number().int().positive(),
  resultingRevision: z.number().int().positive(),
  customDomains: z.array(z.string().min(1)),
  effectiveDomains: z.array(z.string().min(1)),
  at: TimestampSchema,
}).strict();

export type WorkspaceTerminalNetworkMode = z.infer<typeof WorkspaceTerminalNetworkModeSchema>;
export type WorkspaceTerminalNetworkPolicy = z.infer<typeof WorkspaceTerminalNetworkPolicySchema>;
export type WorkspaceTerminalNetworkSettings = z.infer<typeof WorkspaceTerminalNetworkSettingsSchema>;
export type WorkspaceTerminalNetworkSettingsRequest = z.infer<
  typeof WorkspaceTerminalNetworkSettingsRequestSchema
>;
export type WorkspaceTerminalPolicyPreviewRequest = z.infer<
  typeof WorkspaceTerminalPolicyPreviewRequestSchema
>;
export type WorkspaceTerminalPolicyClaimRequest = z.infer<
  typeof WorkspaceTerminalPolicyClaimRequestSchema
>;
export type WorkspaceTerminalPolicyClaimResult = z.infer<
  typeof WorkspaceTerminalPolicyClaimResultSchema
>;
export type WorkspaceTerminalPolicyFailRequest = z.infer<
  typeof WorkspaceTerminalPolicyFailRequestSchema
>;
export type WorkspaceTerminalPolicyCommitRequest = z.infer<
  typeof WorkspaceTerminalPolicyCommitRequestSchema
>;
