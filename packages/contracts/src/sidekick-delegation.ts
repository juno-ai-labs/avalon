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

/** Participant-safe attribution from an operation's receipt, never its arguments. */
export const ToolAccountAttributionSchema = z.strictObject({
  connectionId: IdSchema,
  connectionName: z.string().nullable(),
  userId: UserIdSchema.nullable(),
  userName: z.string().nullable(),
  scope: z.enum(["personal", "workspace"]),
  phase: z.enum(["selected", "refused", "served"]),
  fallbackFromConnectionId: IdSchema.nullable(),
});
export type ToolAccountAttribution = z.infer<typeof ToolAccountAttributionSchema>;

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
  /** Existing account-relative work keeps its pre-migration run-as binding. */
  accountUserId: UserIdSchema,
  delegates: z.array(z.strictObject({
    userId: UserIdSchema, generation: z.number().int().nonnegative(), grantedAt: z.number().int().nonnegative(),
  })),
});
export type SidekickExecutionDelegation = z.infer<typeof SidekickExecutionDelegationSchema>;

/** Host handoff of completed provider references; an identity constraint, never a grant. */
export const SidekickAccountReferenceSchema = z.strictObject({
  sidekickId: IdSchema, connectionId: IdSchema, resourceKeys: z.array(z.string().min(1)),
});
export type SidekickAccountReference = z.infer<typeof SidekickAccountReferenceSchema>;
export const SidekickDelegationAttentionCodeSchema = z.enum(["no_eligible_delegate", "event_no_eligible_delegate", "coordinator_unavailable", "permission_report_unavailable"]);
export type SidekickDelegationAttentionCode = z.infer<typeof SidekickDelegationAttentionCodeSchema>;
export const SIDEKICK_DELEGATION_ATTENTION_MESSAGES: Record<SidekickDelegationAttentionCode, string> = {
  no_eligible_delegate: "Needs attention: no delegated user is available",
  event_no_eligible_delegate: "Needs attention: a configured source has no eligible delegated account. Opt in with an account that has access to that source.",
  coordinator_unavailable: "Needs attention: the coordinating delegate is unavailable. Restore their delegation and access, or start a new run with an available delegate.",
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
