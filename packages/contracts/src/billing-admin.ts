import { z } from 'zod';
import { PlanIdSchema } from './usage';
import { WorkspaceIdSchema } from './identifiers';
import { RegionSchema } from './regions';

export const BillingOfferSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9_-]+$/), name: z.string().min(1), plan: PlanIdSchema,
  priceId: z.string().startsWith('price_'), currencies: z.array(z.string().regex(/^[a-z]{3}$/)).min(1),
  couponId: z.string().optional(), overagePriceId: z.string().startsWith('price_').optional(), enabled: z.boolean().default(true),
});
export const BillingCatalogSchema = z.strictObject({ offers: z.array(BillingOfferSchema).min(1), pilotCouponId: z.string().min(1).nullable() });
export const BillingCatalogResultSchema = BillingCatalogSchema.extend({ revision: z.number().int().nonnegative() });
const PriceAmountSchema = z.object({ amountMinor: z.number().nullable(), amountDecimal: z.string().nullable(), taxBehavior: z.string() });
export const BillingCatalogInspectionSchema = BillingCatalogResultSchema.extend({
  prices: z.array(PriceAmountSchema.extend({ id: z.string(), productId: z.string(), active: z.boolean(), currency: z.string(),
    recurring: z.object({ interval: z.string(), intervalCount: z.number(), usageType: z.string() }).nullable(),
    currencyOptions: z.record(z.string(), PriceAmountSchema),
  })),
  coupons: z.array(z.object({ id: z.string(), valid: z.boolean(), percentOff: z.number().nullable(), amountOff: z.number().nullable(),
    currency: z.string().nullable(), duration: z.string(), months: z.number().nullable(), productIds: z.array(z.string()).nullable(),
  })),
});
export type BillingCatalogInspection = z.infer<typeof BillingCatalogInspectionSchema>;
const identity = { operationId: z.uuid().describe('Reuse this UUID and identical arguments after an uncertain result.'), reason: z.string().trim().min(1).max(500) };
export const InspectOrgBillingSchema = z.strictObject({ orgId: WorkspaceIdSchema, startingAfter: z.string().optional() });
export const ChangeSubscriptionSchema = z.strictObject({ ...identity, orgId: WorkspaceIdSchema, subscriptionId: z.string().startsWith('sub_'),
  change: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('plan'), offerId: z.string(), proration: z.enum(['none', 'create_prorations', 'always_invoice']) }),
    z.strictObject({ type: z.literal('cancel'), when: z.enum(['period_end', 'now']) }),
    z.strictObject({ type: z.literal('resume') }),
    z.strictObject({ type: z.literal('promotion'), couponId: z.string().nullable() }),
  ]),
});
export const RefundPaymentSchema = z.strictObject({ ...identity, orgId: WorkspaceIdSchema, chargeId: z.string().startsWith('ch_'), amountMinor: z.number().int().positive() });
export const CorrectInvoiceSchema = z.strictObject({ ...identity, orgId: WorkspaceIdSchema, invoiceId: z.string().startsWith('in_'),
  correction: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('void') }),
    z.strictObject({ type: z.literal('uncollectible') }),
    z.strictObject({ type: z.literal('credit_note'), amountMinor: z.number().int().positive(), disposition: z.enum(['invoice_balance', 'customer_balance', 'refund']) }),
  ]),
});
export const InspectBillingCatalogSchema = z.strictObject({ region: RegionSchema });
export const CreateBillingPriceSchema = z.strictObject({ ...identity, region: RegionSchema, sourceOfferId: z.string(),
  amountMinor: z.number().int().positive(), currency: z.string().regex(/^[a-z]{3}$/),
  interval: z.enum(['month', 'year']), intervalCount: z.number().int().positive().default(1),
  taxBehavior: z.enum(['exclusive', 'inclusive']),
});
export const CreateBillingCouponSchema = z.strictObject({ ...identity, region: RegionSchema, name: z.string().min(1),
  offerIds: z.array(z.string()).min(1), percentOff: z.number().positive().max(100),
  duration: z.discriminatedUnion('type', [z.strictObject({ type: z.literal('once') }), z.strictObject({ type: z.literal('forever') }), z.strictObject({ type: z.literal('repeating'), months: z.number().int().positive() })]),
});
export const ConfigureBillingCatalogSchema = z.strictObject({ ...identity, region: RegionSchema, expectedRevision: z.number().int().nonnegative(), catalog: BillingCatalogSchema });
export const BillingAdminMutationSchema = z.discriminatedUnion('kind', [
  ChangeSubscriptionSchema.extend({ kind: z.literal('subscription') }), RefundPaymentSchema.extend({ kind: z.literal('refund') }), CorrectInvoiceSchema.extend({ kind: z.literal('invoice') }),
]);
export const BillingCatalogMutationSchema = z.discriminatedUnion('kind', [
  CreateBillingPriceSchema.extend({ kind: z.literal('price') }), CreateBillingCouponSchema.extend({ kind: z.literal('coupon') }), ConfigureBillingCatalogSchema.extend({ kind: z.literal('catalog') }),
]);
export const BillingMutationResultSchema = z.object({ operationId: z.string(), resourceId: z.string(), resourceType: z.enum(['subscription', 'refund', 'invoice', 'credit_note', 'price', 'coupon', 'catalog']), status: z.string(), amountMinor: z.number().optional(), currency: z.string().optional(), revision: z.number().optional() });
export const OrgBillingResultSchema = z.object({
  customerId: z.string().nullable(), subscriptionId: z.string().nullable(), status: z.string(), offerId: z.string().nullable(),
  overageEnabled: z.boolean(), usagePlanOverride: z.boolean(),
  subscriptions: z.array(z.object({ id: z.string(), status: z.string(), role: z.string(), currency: z.string(), cancelAtPeriodEnd: z.boolean(), trialEnd: z.number().nullable(), priceIds: z.array(z.string()) })),
  invoices: z.array(z.object({ id: z.string(), status: z.string().nullable(), currency: z.string(), total: z.number(), amountPaid: z.number(), amountRemaining: z.number(), chargeId: z.string().nullable() })),
  nextInvoicePage: z.string().nullable(), pendingOperations: z.array(z.object({ operationId: z.string(), createdAt: z.number() })),
});
export type BillingAdminMutation = z.infer<typeof BillingAdminMutationSchema>;
export type BillingCatalogMutation = z.infer<typeof BillingCatalogMutationSchema>;
export type BillingMutationResult = z.infer<typeof BillingMutationResultSchema>;
export type BillingCatalog = z.infer<typeof BillingCatalogResultSchema>;
export type OrgBillingResult = z.infer<typeof OrgBillingResultSchema>;
