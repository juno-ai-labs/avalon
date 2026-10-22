import { z } from "zod";
import { IdSchema, UserIdSchema, WorkspaceIdSchema } from "./identifiers";

/** Shared runtime/advertised inputs: the host supplies identity and provenance. */
export const SidekickMyDelegationsInputSchema = z.strictObject({});
export const SidekickDelegatesInputSchema = z.strictObject({ sidekick: z.string().min(1) });
export const SidekickSetMyDelegationInputSchema = z.strictObject({ sidekickId: IdSchema, allowed: z.boolean() });

export const SidekickDelegationMutationResultSchema = z.strictObject({
  sidekickId: IdSchema,
  userId: UserIdSchema,
  allowed: z.boolean(),
  changed: z.boolean(),
});
export type SidekickDelegationMutationResult = z.infer<typeof SidekickDelegationMutationResultSchema>;

export const SidekickDelegatesResultSchema = z.strictObject({
  sidekickId: IdSchema,
  creatorUserId: UserIdSchema,
  you: z.strictObject({ userId: UserIdSchema, allowed: z.boolean() }),
  delegates: z.array(z.strictObject({ userId: UserIdSchema, displayName: z.string(), eligible: z.boolean() })),
});
export type SidekickDelegatesResult = z.infer<typeof SidekickDelegatesResultSchema>;

export const SidekickMyDelegationsResultSchema = z.strictObject({
  userId: UserIdSchema,
  delegations: z.array(z.strictObject({
    sidekickId: IdSchema, label: z.string(), allowed: z.boolean(), eligible: z.boolean(),
  })),
});
export type SidekickMyDelegationsResult = z.infer<typeof SidekickMyDelegationsResultSchema>;
export const AccountSidekickDelegationsSchema = z.strictObject({
  organizations: z.array(SidekickMyDelegationsResultSchema.extend({ workspaceId: WorkspaceIdSchema })),
});

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

export const SIDEKICK_DELEGATION_ERRORS = {
  sidekick_not_found: "This Sidekick is unavailable to you. Use Sidekick discovery for enrollment, or sidekick_my_delegations_list to withdraw your own grant.",
  sidekick_delegation_ambiguous_target: "More than one visible Sidekick has that name. Choose the intended Sidekick from the screen and use its Rally link or UUID.",
  sidekick_delegation_user_context_required: "Delegation changes require a direct signed-in user conversation. Use the Sidekick screen or its setup conversation.",
  sidekick_delegation_membership_unavailable: "Your Organization membership is unavailable. Restore membership before allowing this Sidekick to act as you. You can still withdraw an existing grant.",
  sidekick_delegation_unavailable: "This Sidekick cannot accept enrollment. Refresh its details before trying again. You can still withdraw your own grant.",
  sidekick_delegation_stale_action: "This delegation changed after this request was prepared. Read your current grant. Only a new request from you can allow it again.",
  sidekick_delegation_list_too_large: "This delegation list exceeds the tool output budget. Inspect it in the Sidekick screen, or Settings → Account → Sidekick delegation for your own grants.",
} as const;
