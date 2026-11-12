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
    // the percentage and duration; omit to stop offering the pilot to new buyers.
    pilotCouponId: z.string().min(1).optional(),
    // Dedicated zero-price trial record and reporting-only hourly meters.
    synchronization: z
      .strictObject({
        freePriceId: z.string().startsWith("price_"),
        organizationMeterId: z.string().startsWith("mtr_"),
        rallyMeterId: z.string().startsWith("mtr_"),
      })
      .optional(),
    offers: z
      .array(
        z.strictObject({
          id: z.string().regex(/^[a-z0-9_-]+$/),
          name: z.string().min(1),
          plan: PlanIdSchema,
          priceId: z.string().startsWith("price_"),
          currencies: z.array(z.string().regex(/^[a-z]{3}$/)).min(1),
          couponId: z.string().optional(),
          // A one-time USD price of $0.000001 per unit, for the existing micro-USD ledger.
          overagePriceId: z.string().startsWith("price_").optional(),
          enabled: z.boolean().default(true),
        }),
      )
      .min(1),
  })
  .superRefine((config, ctx) => {
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
