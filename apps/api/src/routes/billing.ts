import { providerWebhookMaxBytes, readBoundedRequestBytes } from "../lib/bounded-request-body";
import { createBillingPortal, createCheckout, syncSubscription, refreshOrganizationBilling, setBillingOverages } from "../services/billing-coordination";
import { zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";
import {
  BillingStatusSchema,
  BillingUrlSchema,
  BillingCreditsSchema,
  BillingOveragePreferenceSchema,
} from "@rally/contracts/billing";
import { Hono } from "hono";
import { z } from "zod";
import type { HonoAppEnv } from "../env";
import {
  getAuth,
  refuseSupportSession,
  requireWorkspaceAdmin,
} from "../middleware/auth";
import { zValidator } from "../middleware/validation";
import { ApiError } from "../lib/api-error";
import { billingConfig, resolveBillingEnvironment } from "../services/billing-config";
import {
  hasLiveSubscription, billingAccount,
} from "../services/billing";
import { verifyStripeSignature } from "../services/stripe";
import { readOverageCredits } from "../services/overage-credits";

export const billingRoutes = new Hono<HonoAppEnv>();
billingRoutes.use("*", refuseSupportSession);
billingRoutes.use("*", async (c, next) => {
  if (c.req.method !== "GET") requireWorkspaceAdmin(c);
  await next();
});
billingRoutes.get("/", async (c) => {
  if (!c.env.BILLING_CONFIG) return c.json({ enabled: false });
  const env = await resolveBillingEnvironment(c.env);
  const config = billingConfig(env);
  const cached = await billingAccount(env, getAuth(c).workspaceId);
  const account = config.enforceUsageLimits || config.signupTrial || hasLiveSubscription(cached)
    ? await refreshOrganizationBilling(env, getAuth(c).workspaceId, true) : cached;
  return c.json(
    BillingStatusSchema.parse({
      enabled: true,
      status: account.status,
      currency: account.currency,
      offerId: account.offer_id,
      subscribed: hasLiveSubscription(account),
      creditsAvailable: Boolean(config.overageCredits),
      paymentMethodReady: account.payment_method_ready === 1,
      overageAvailable: account.currency === "usd" && Boolean(config.offers.find(offer => offer.id === account.offer_id)?.overagePriceId),
      trialEndsAt: new Date(account.trial_ends_at * 1000).toISOString(),
      overageEnabled:
        account.overage_enabled === 1 &&
        ["active", "trialing"].includes(account.status),
      offers: config.offers
        .filter((o) => o.enabled)
        .map((o) => ({
          id: o.id,
          name: o.name,
          plan: o.plan,
          currencies: o.currencies,
          overageAvailable: Boolean(o.overagePriceId),
        })),
    }),
  );
});
billingRoutes.get("/credits", async (c) => c.json(BillingCreditsSchema.parse(await readOverageCredits(c.env, getAuth(c).workspaceId))));
billingRoutes.post(
  "/checkout",
  zValidator(
    "json",
    z.strictObject({
      offerId: z.string(),
      currency: z.string(),
      overage: z.boolean().default(false),
    }),
  ),
  async (c) => {
    const input = c.req.valid("json");
    return c.json(
      BillingUrlSchema.parse(
        await createCheckout(
          c.env,
          getAuth(c).workspaceId,
          input.offerId,
          input.currency,
          input.overage,
        ),
      ),
    );
  },
);
billingRoutes.post("/portal", async (c) =>
  c.json(
    BillingUrlSchema.parse(
      await createBillingPortal(c.env, getAuth(c).workspaceId),
    ),
  ),
);
billingRoutes.post("/overages", zValidator("json", BillingOveragePreferenceSchema), async c =>
  c.json(BillingOveragePreferenceSchema.parse(await setBillingOverages(c.env, getAuth(c).workspaceId, c.req.valid("json").enabled))));

function webhookPayload<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ApiError(
      400,
      zodDiagnosticCode(parsed.error, "stripe_webhook")!,
      "Invalid Stripe webhook payload",
    );
  return parsed.data;
}

/**
 * The customer fields `synchronizeStripeProfile` writes. None of them decides
 * readiness; a field that does must never join this list.
 */
const OWN_PROFILE_FIELDS = ["metadata", "name"];

export const stripeWebhookRoutes = new Hono<HonoAppEnv>();
stripeWebhookRoutes.post("/", async (c) => {
  if (!c.env.STRIPE_WEBHOOK_SECRET)
    throw new ApiError(
      503,
      "stripe_webhook_not_configured",
      "Billing webhook is not configured",
    );
  const body = new TextDecoder().decode(await readBoundedRequestBytes(c.req.raw, providerWebhookMaxBytes(c.env)));
  if (
    !(await verifyStripeSignature(
      body,
      c.req.header("stripe-signature") ?? "",
      c.env.STRIPE_WEBHOOK_SECRET,
    ))
  ) {
    throw new ApiError(
      400,
      "stripe_signature_invalid",
      "Invalid Stripe signature",
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new ApiError(
      400,
      "stripe_webhook_json_invalid",
      "Invalid Stripe webhook JSON",
    );
  }
  const event = webhookPayload(
    z.object({ type: z.string(), data: z.object({ object: z.unknown(), previous_attributes: z.record(z.string(), z.unknown()).optional() }) }),
    payload,
  );
  if (event.type.startsWith("customer.subscription.")) {
    const subscription = webhookPayload(
      z.object({ id: z.string(), customer: z.string() }),
      event.data.object,
    );
    await syncSubscription(c.env, subscription.customer, subscription.id);
  } else if (event.type === "customer.updated") {
    const customer = webhookPayload(z.object({ id: z.string() }), event.data.object);
    // Rally's own profile write echoes back during settle; nothing readiness-related changed.
    const changed = Object.keys(event.data.previous_attributes ?? {});
    if (changed.length > 0 && changed.every((key) => OWN_PROFILE_FIELDS.includes(key))) return c.json({ received: true });
    const account = await c.env.DB.prepare("SELECT workspace_id FROM billing_accounts WHERE customer_id = ?")
      .bind(customer.id).first<{ workspace_id: string }>();
    if (account) await refreshOrganizationBilling(c.env, account.workspace_id);
  }
  return c.json({ received: true });
});
