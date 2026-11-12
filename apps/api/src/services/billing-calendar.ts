import { ApiError } from "../lib/api-error";

/** Calendar months clamp to the last day of a shorter target month, in UTC. */
export function addBillingMonths(at: number, months: number): number {
  const date = new Date(at * 1000);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  if (!Number.isFinite(date.getTime())) throw new ApiError(400, "billing_trial_months_date_invalid", "The requested months exceed supported calendar dates");
  return date.getTime() / 1000;
}
