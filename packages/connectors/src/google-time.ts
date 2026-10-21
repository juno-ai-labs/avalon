import { z } from "zod";
import { ConnectorError } from "./types";

export const LocalClockSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u);
export const GoogleTimeZoneSchema = z.string().min(1).refine((timeZone) => {
  try { new Intl.DateTimeFormat("en", { timeZone }); return true; } catch { return false; }
}, "timeZone must be an IANA time zone");

/** Earliest matching wall time; midnight gaps resolve to the start of the local date. */
export function zonedInstant(date: string, clock: string, timeZone: string): number {
  const desired = Date.parse(`${date}T${clock}:00Z`);
  const format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const localEpoch = (instant: number) => {
    const p = Object.fromEntries(format.formatToParts(instant).map((part) => [part.type, part.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  };
  // Adjacent UTC days expose the offsets on either side of a clock transition.
  const offsets = new Set([-86_400_000, 0, 86_400_000].map((delta) => localEpoch(desired + delta) - desired - delta));
  const candidates = [...offsets].map((offset) => desired - offset).sort((a, b) => a - b);
  const exact = candidates.find((instant) => localEpoch(instant) === desired);
  if (exact !== undefined) return exact;
  if (clock !== "00:00") throw new ConnectorError("invalid_payload", "preferences: a selected local hour does not exist during a daylight-saving transition. Choose hours outside the clock-change gap.", { field: "preferences", reason: "nonexistent_local_hour" });
  // Midnight can be skipped. Find the transition itself, not the previous
  // day's last hour or an arbitrary later time on the requested date.
  let before = candidates[0]!;
  let after = candidates[candidates.length - 1]!;
  while (after - before > 1) {
    const middle = Math.floor((before + after) / 2);
    if (localEpoch(middle) < desired) before = middle;
    else after = middle;
  }
  return after;
}

export function calendarDayBoundary(date: string, timeZone: string): string {
  return new Date(zonedInstant(date, "00:00", timeZone)).toISOString();
}
