import { BillingOfferSchema, BillingCatalogResultSchema } from "@rally/contracts/billing-admin";
import { HttpUrlSchema } from "@rally/contracts/url-schemas";
import { z } from "zod";
import { PlanIdSchema } from "@rally/contracts/usage";
import { zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";
import { ApiError } from "../lib/api-error";
import type { Env } from "../env";

// Stripe Prices own amounts, intervals, currency options and tax behavior.
export const BillingConfigSchema = z
  .strictObject({
    returnUrl: HttpUrlSchema.refine(
      (url) => new URL(url).protocol === "https:",
    ),
    unpaidPlan: PlanIdSchema.default("starter"),
    automaticTax: z.boolean().default(true),
    settlementDelayDays: z.number().int().nonnegative().default(14),
    trialDays: z.number().int().nonnegative().default(14),
    teamTrialDays: z.number().int().nonnegative().default(60),
    teamTrialMembers: z.number().int().positive().default(3),
    // Applied once per Organization, on its first paid subscription. Stripe owns
    // the percentage and duration. This bootstraps the pilot until a persisted
    // catalog overrides it; then publish pilotCouponId:null to stop new awards.
    pilotCouponId: z.string().min(1).optional(),
    // A dedicated monthly metered USD price. Native Stripe credit grants apply
    // only to this overage price, never to the licensed plan subscription.
    overageCredits: z.strictObject({
      priceId: z.string().startsWith("price_"),
      meterId: z.string().startsWith("mtr_"),
    }).optional(),
    // Dedicated zero-price trial record and reporting-only hourly meters.
    synchronization: z
      .strictObject({
        freePriceId: z.string().startsWith("price_"),
        organizationMeterId: z.string().startsWith("mtr_"),
        rallyMeterId: z.string().startsWith("mtr_"),
      })
      .optional(),
    offers: z.array(BillingOfferSchema).min(1),
  })
  .superRefine((config, ctx) => {
    if (config.overageCredits && config.offers.some((offer) => offer.priceId === config.overageCredits!.priceId)) {
      ctx.addIssue({ code: "custom", path: ["overageCredits", "priceId"], message: "Overage credits must not apply to plan prices" });
    }
    if (config.overageCredits && config.synchronization &&
      [config.synchronization.organizationMeterId, config.synchronization.rallyMeterId].includes(config.overageCredits.meterId)) {
      ctx.addIssue({ code: "custom", path: ["overageCredits", "meterId"], message: "Billable overages require a dedicated meter" });
    }
    if (new Set(config.offers.map((o) => o.id)).size !== config.offers.length) {
      ctx.addIssue({
        code: "custom",
        path: ["offers"],
        message: "Duplicate offer IDs",
      });
    }
    if (
      config.synchronization &&
      config.synchronization.organizationMeterId ===
        config.synchronization.rallyMeterId
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["synchronization", "rallyMeterId"],
        message: "Payers require separate meters",
      });
    }
  });
export function billingConfig(env: Pick<Env, "BILLING_CONFIG">) {
  if (!env.BILLING_CONFIG)
    throw new ApiError(
      503,
      "billing_not_configured",
      "Billing is not configured",
    );
  let value: unknown;
  try {
    value = JSON.parse(env.BILLING_CONFIG);
  } catch {
    throw new ApiError(
      503,
      "billing_config_json_invalid",
      "Billing configuration is invalid",
    );
  }
  const parsed = BillingConfigSchema.safeParse(value);
  if (!parsed.success)
    throw new ApiError(
      503,
      zodDiagnosticCode(parsed.error, "billing_config")!,
      "Billing configuration is invalid",
    );
  return parsed.data;
}

const resolved = Symbol('billingConfigurationSnapshot');
/** One D1 read per billing operation; never cache across requests or actor calls. */
export async function resolveBillingEnvironment(env: Env): Promise<Env> {
  if (!env.BILLING_CONFIG || (env as Env & { [resolved]?: boolean })[resolved]) return env;
  const catalog = await readBillingCatalog(env);
  return Object.assign({ ...env, BILLING_CONFIG: JSON.stringify({ ...billingConfig(env), offers: catalog.offers, pilotCouponId: catalog.pilotCouponId ?? undefined }) }, { [resolved]: true });
}
export async function readBillingCatalog(env: Env) {
  const base = billingConfig(env);
  const row = await env.DB.prepare('SELECT revision, catalog_json FROM billing_catalog WHERE region = ?').bind(env.AVALON_REGION)
    .first<{ revision: number; catalog_json: string }>();
  return BillingCatalogResultSchema.parse(row ? { ...JSON.parse(row.catalog_json), revision: row.revision } : { offers: base.offers, pilotCouponId: base.pilotCouponId ?? null, revision: 0 });
}
