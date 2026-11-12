import { HttpUrlSchema } from './url-schemas';
import { z } from 'zod';
import { PlanIdSchema } from './usage';
export const BillingStatusSchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }),
  z.object({ enabled: z.literal(true), status: z.string(), subscribed: z.boolean(), trialEndsAt: z.string(), overageEnabled: z.boolean(), creditsAvailable: z.boolean().optional(),
    offers: z.array(z.object({ id: z.string(), name: z.string(), plan: PlanIdSchema, currencies: z.array(z.string()), overageAvailable: z.boolean() })),
  }),
]);
export type BillingStatus = z.infer<typeof BillingStatusSchema>;
export const BillingUrlSchema = z.object({ url: HttpUrlSchema });

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
  expiresAt: z.iso.datetime({ offset: true }).optional(),
});
export type GrantOverageCredit = z.infer<typeof GrantOverageCreditSchema>;
