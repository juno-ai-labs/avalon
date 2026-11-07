import { z } from "zod";
import { IdSchema, UserIdSchema } from "./identifiers";
import { PersonalPresentationSchema } from "./onboarding";

/** Shared runtime/advertised inputs: the host supplies identity and provenance. */
export const SidekickMyDelegationsInputSchema = z.strictObject({});
export const SidekickDelegatesInputSchema = z.strictObject({ sidekick: z.string().min(1) });
export const SidekickSetDelegationInputSchema = z.strictObject({ sidekickId: IdSchema, userId: UserIdSchema, allowed: z.boolean() });

export const SidekickDelegationMutationResultSchema = z.strictObject({
  sidekickId: IdSchema,
  userId: UserIdSchema,
  allowed: z.boolean(),
  changed: z.boolean(),
});
export type SidekickDelegationMutationResult = z.infer<typeof SidekickDelegationMutationResultSchema>;

const SidekickDelegateIdentitySchema = z.strictObject({
  userId: UserIdSchema, displayName: z.string(),
  avatarUrl: z.string().nullable().optional(), presentation: PersonalPresentationSchema.nullable().optional(),
});
export const SidekickDelegatesResultSchema = z.strictObject({
  sidekickId: IdSchema,
  creatorUserId: UserIdSchema,
  creator: SidekickDelegateIdentitySchema.optional(),
  you: z.strictObject({ userId: UserIdSchema, allowed: z.boolean() }),
  delegates: z.array(SidekickDelegateIdentitySchema.extend({ eligible: z.boolean() })),
});
export type SidekickDelegatesResult = z.infer<typeof SidekickDelegatesResultSchema>;

export const SidekickMyDelegationsResultSchema = z.strictObject({
  userId: UserIdSchema,
  delegations: z.array(z.strictObject({
    sidekickId: IdSchema, label: z.string(), allowed: z.boolean(), eligible: z.boolean(),
  })),
});
export type SidekickMyDelegationsResult = z.infer<typeof SidekickMyDelegationsResultSchema>;

/** Internal consent record. Generations and provenance never become tool inputs. */
export const SidekickDelegationGrantSchema = z.strictObject({
  sidekickId: IdSchema,
  userId: UserIdSchema,
  allowed: z.boolean(),
  generation: z.number().int().nonnegative(),
  membershipIncarnation: z.string().min(1).nullable(),
  source: z.enum(["creation", "self_service", "agent_request", "manager_removal", "migration"]),
  actorUserId: UserIdSchema,
  requestId: z.string().min(1),
  label: z.string(),
  grantedAt: z.number().int().nonnegative().nullable(),
  updatedAt: z.number().int().nonnegative(),
});
export type SidekickDelegationGrant = z.infer<typeof SidekickDelegationGrantSchema>;

/** Host-only reconciliation; no generation or provenance enters model outputs. */
export const SidekickDelegationReceiptResultSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("accepted"), result: SidekickDelegationMutationResultSchema, grant: SidekickDelegationGrantSchema }),
  z.strictObject({ outcome: z.enum(["missing", "stale", "unavailable"]) }),
]);
export type SidekickDelegationReceiptResult = z.infer<typeof SidekickDelegationReceiptResultSchema>;

/** Host-only operation authority; no credentials or pooled principal. */
export const SidekickExecutionDelegationSchema = z.strictObject({
  sidekickId: IdSchema,
  creatorUserId: UserIdSchema,
  /** Stable owner of existing shared Terminal files across coordinator changes. */
  accountUserId: UserIdSchema,
  delegates: z.array(z.strictObject({
    userId: UserIdSchema, generation: z.number().int().nonnegative(), grantedAt: z.number().int().nonnegative(),
  })),
  /**
   * Set for a run a non-delegate's message started: the run acts as this
   * person, with only their own access, and `delegates` names only them.
   * Absent for every other run and for the Sidekick as a whole.
   */
  requesterUserId: UserIdSchema.optional(),
});
/**
 * Why a run started by a non-delegate refuses a connector operation: it would
 * need an account that only a delegate's access reaches.
 */
export const SIDEKICK_REQUESTER_ACCOUNT_UNAVAILABLE = "sidekick_requester_account_unavailable";
/**
 * Why a run started by a non-delegate refuses the Terminal: a Sidekick's
 * shared Terminal files hold what runs under its delegates' access wrote, so
 * reading them would reach a delegate's access through the Sidekick.
 */
export const SIDEKICK_REQUESTER_FILES_UNAVAILABLE = "sidekick_requester_files_unavailable";
export type SidekickExecutionDelegation = z.infer<typeof SidekickExecutionDelegationSchema>;

export const SidekickDelegationAttentionCodeSchema = z.enum(["no_eligible_delegate", "event_no_eligible_delegate", "permission_report_unavailable"]);
export type SidekickDelegationAttentionCode = z.infer<typeof SidekickDelegationAttentionCodeSchema>;
export const SIDEKICK_DELEGATION_ATTENTION_MESSAGES: Record<SidekickDelegationAttentionCode, string> = {
  no_eligible_delegate: "Needs attention: no delegated user is available",
  event_no_eligible_delegate: "Needs attention: a configured source has no eligible delegated account. Opt in with an account that has access to that source.",
  permission_report_unavailable: "Needs attention: a message could not reach its destination. Restore conversation access and rerun the blocked work; no delivery was confirmed.",
};

export const SIDEKICK_DELEGATION_ERRORS = {
  sidekick_not_found: "This Sidekick is unavailable to you. Use Sidekick discovery for enrollment, or sidekick_my_delegations_list to withdraw your own grant.",
  sidekick_delegation_ambiguous_target: "More than one visible Sidekick has that name. Choose the intended Sidekick from the screen and use its Rally link or UUID.",
  sidekick_delegation_membership_unavailable: "The required user's Organization membership is unavailable. Restore membership before adding delegation. Existing grants can still be withdrawn.",
  sidekick_delegation_unavailable: "This Sidekick cannot accept enrollment. Refresh its details before trying again. You can still withdraw your own grant.",
  sidekick_delegation_stale_action: "This delegation changed after this request was prepared. Read the current delegation state. Use a new delegation change to allow it again.",
  sidekick_delegation_list_too_large: "This delegation list exceeds the tool output budget. Inspect it in the Sidekick screen.",
} as const;
