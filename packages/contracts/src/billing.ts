import { HttpUrlSchema } from './url-schemas';
import { z } from 'zod';
import { PlanIdSchema } from './usage';
export const BillingStatusSchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }),
  z.object({ enabled: z.literal(true), status: z.string(), subscribed: z.boolean(), trialEndsAt: z.string(), overageEnabled: z.boolean(), creditsAvailable: z.boolean().optional(),
    currency: z.string().nullable().optional(), offerId: z.string().nullable().optional(),
    paymentMethodReady: z.boolean().optional(), overageAvailable: z.boolean().optional(),
    offers: z.array(z.object({ id: z.string(), name: z.string(), plan: PlanIdSchema, currencies: z.array(z.string()), overageAvailable: z.boolean() })),
  }),
]);
export type BillingStatus = z.infer<typeof BillingStatusSchema>;
export const BillingUrlSchema = z.object({ url: HttpUrlSchema });
export const BillingOveragePreferenceSchema = z.strictObject({ enabled: z.boolean() });

export const OverageCreditSchema = z.object({
  id: z.string(), amountCents: z.number().int(), availableCents: z.number().int(),
  effectiveAt: z.string(), expiresAt: z.string().nullable(), voided: z.boolean(),
});
export const BillingCreditsSchema = z.object({
  enabled: z.boolean(), currency: z.literal('usd'), availableCents: z.number().int(),
  grants: z.array(OverageCreditSchema),
});
export type BillingCredits = z.infer<typeof BillingCreditsSchema>;
export type OverageCredit = z.infer<typeof OverageCreditSchema>;
export const GrantOverageCreditSchema = z.strictObject({
  operationId: z.uuid().describe('A fresh UUID for this grant; reuse it and identical arguments after an uncertain outcome.'),
  amountCents: z.number().int().positive().describe('USD cents of promotional overage credit, not effective usage or plan allowance.'),
  reason: z.string().trim().min(1).max(500), // Stripe metadata value limit.
  expiresAt: z.iso.datetime({ offset: true }).describe('Required expiration in the future, at most two calendar years from grant creation (UTC).'),
});
export type GrantOverageCredit = z.infer<typeof GrantOverageCreditSchema>;

export const GrantTrialMonthsSchema = z.strictObject({
  operationId: z.uuid().describe('A fresh UUID for this award; reuse it and identical arguments after an uncertain response.'),
  months: z.number().int().positive().describe('Calendar months of extra subscription-fee waiver after the existing paid/trial/pilot period. Overages remain billable.'),
  reason: z.string().trim().min(1).max(500), // Stripe metadata value limit.
});
export type GrantTrialMonths = z.infer<typeof GrantTrialMonthsSchema>;
export const TrialMonthsGrantSchema = z.object({
  subscriptionId: z.string(), months: z.number().int().positive(),
  previousFeeCoveredUntil: z.string(), trialEndsAt: z.string(),
});
export type TrialMonthsGrant = z.infer<typeof TrialMonthsGrantSchema>;
