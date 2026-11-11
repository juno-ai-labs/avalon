import { HttpUrlSchema } from './url-schemas';
import { z } from 'zod';
import { PlanIdSchema } from './usage';
export const BillingStatusSchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }),
  z.object({ enabled: z.literal(true), status: z.string(), subscribed: z.boolean(), trialEndsAt: z.string(), overageEnabled: z.boolean(),
    offers: z.array(z.object({ id: z.string(), name: z.string(), plan: PlanIdSchema, currencies: z.array(z.string()), overageAvailable: z.boolean() })),
  }),
]);
export type BillingStatus = z.infer<typeof BillingStatusSchema>;
export const BillingUrlSchema = z.object({ url: HttpUrlSchema });
