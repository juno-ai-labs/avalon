import { grantTrialMonths } from "../services/trial-months";
import type { GrantOverageCredit, GrantTrialMonths } from "@rally/contracts/billing";
import { grantOverageCredit, expireOverageCredit } from "../services/overage-credits";
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import * as billing from "../services/billing";

/** One regional actor per organization. Canonical state remains in D1/Stripe. */
export class BillingCoordinatorDO extends DurableObject<Env> {
  private busy = false;

  private async serialize<T>(
    workspaceId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    // Claim synchronously before the first await. This state belongs to the
    // unique actor, and disappears together with its executing code on reset.
    if (this.busy)
      throw new ApiError(
        409,
        "billing_busy",
        "Billing is updating; please retry",
      );
    this.busy = true;
    try {
      const owned = await this.env.DB.prepare(
        "SELECT id FROM workspaces WHERE id = ? AND region = ?",
      )
        .bind(workspaceId, this.env.AVALON_REGION)
        .first();
      if (
        !owned ||
        this.ctx.id.name !== `${this.env.AVALON_REGION}:billing:${workspaceId}`
      )
        throw new ApiError(
          404,
          "billing_account_not_found",
          "Organization not found",
        );
      return await work();
    } finally {
      this.busy = false;
    }
  }

  checkout(
    workspaceId: string,
    offerId: string,
    currency: string,
    overage: boolean,
  ) {
    return this.serialize(workspaceId, () =>
      billing.createCheckout(this.env, workspaceId, offerId, currency, overage),
    );
  }
  portal(workspaceId: string) {
    return this.serialize(workspaceId, () =>
      billing.createBillingPortal(this.env, workspaceId),
    );
  }
  synchronize(workspaceId: string, customerId: string, subscriptionId: string) {
    return this.serialize(workspaceId, () =>
      billing.syncSubscription(this.env, customerId, subscriptionId),
    );
  }
  settle(workspaceId: string) {
    return this.serialize(workspaceId, () =>
      billing.settleBillingAccount(this.env, workspaceId),
    );
  }
  grantTrialMonths(workspaceId: string, input: GrantTrialMonths) {
    return this.serialize(workspaceId, () => grantTrialMonths(this.env, workspaceId, input));
  }
  grantCredit(workspaceId: string, input: GrantOverageCredit) {
    return this.serialize(workspaceId, () => grantOverageCredit(this.env, workspaceId, input));
  }
  expireCredit(workspaceId: string, grantId: string) {
    return this.serialize(workspaceId, () => expireOverageCredit(this.env, workspaceId, grantId));
  }
  close(workspaceId: string, actorUserId: string | null) {
    return this.serialize(workspaceId, () =>
      billing.closeOrganizationBilling(this.env, workspaceId, actorUserId),
    );
  }
}
