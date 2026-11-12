/** Shared product catalog, also consumed by the public site's build. */
// Preserve the persisted starter/growth IDs behind the Start/Grow display names.
export const PLAN_IDS = ["starter", "growth", "max", "ultra"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export const PLANS: Readonly<Record<PlanId, { name: string; monthlyPriceUsd: number; includedUsageUsd: number }>> = {
  starter: { name: "Start", monthlyPriceUsd: 0, includedUsageUsd: 40 },
  growth: { name: "Grow", monthlyPriceUsd: 100, includedUsageUsd: 200 },
  max: { name: "Max", monthlyPriceUsd: 250, includedUsageUsd: 500 },
  ultra: { name: "Ultra", monthlyPriceUsd: 1000, includedUsageUsd: 2000 },
};

/** Allocate one quarter of the included usage each week, including the free plan. */
export function weeklyQuotaMicrousd(plan: PlanId): number {
  return (PLANS[plan].includedUsageUsd * 1_000_000) / 4;
}
