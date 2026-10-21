import { zonedInstant } from "./google-time";
import { ConnectorError } from "./types";

interface AvailabilityRequest {
  attendeeEmails: string[];
  startTime: string;
  endTime: string;
  durationMinutes: number;
  timeZone?: string;
  preferences?: { startHour?: string; endHour?: string; excludeWeekends?: boolean; maxResults?: number };
}
/** Subtract the union of busy intervals, then intersect with preferred local days/hours. */
export function suggestCalendarTimes(args: AvailabilityRequest, timeZone: string, busy: Record<string, unknown>[]): Record<string, unknown> {
  const begin = Date.parse(args.startTime);
  const finish = Date.parse(args.endTime);
  const intervals = busy.map((item) => [Date.parse(String(item.start)), Date.parse(String(item.end))] as const);
  if (intervals.some(([start, end]) => !Number.isFinite(start) || !Number.isFinite(end) || end < start)) throw new ConnectorError("provider_error", "Google returned invalid busy interval start/end fields; availability could not be established.", { reason: "invalid_busy_interval", field: "attendeeEmails" });
  intervals.sort((a, b) => a[0] - b[0]);
  const free: Array<[number, number]> = [];
  let cursor = begin;
  for (const [start, end] of intervals) {
    if (start > cursor) free.push([cursor, Math.min(start, finish)]);
    cursor = Math.max(cursor, end);
    if (cursor >= finish) break;
  }
  if (cursor < finish) free.push([cursor, finish]);
  const output = (windows: Array<[number, number]>) => {
    const slots = windows.filter(([start, end]) => end - start >= args.durationMinutes * 60_000).map(([start, end]) => ({ start: new Date(start).toISOString(), end: new Date(start + args.durationMinutes * 60_000).toISOString(), availableUntil: new Date(end).toISOString(), durationMinutes: args.durationMinutes }));
    return { timeSlots: args.preferences?.maxResults ? slots.slice(0, args.preferences.maxResults) : slots, timeZone, attendeeEmails: args.attendeeEmails, appliedPreferences: args.preferences ?? {}, totalWindows: slots.length };
  };
  if (!args.preferences?.startHour && !args.preferences?.endHour && !args.preferences?.excludeWeekends) return output(free);
  const format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const parts = (instant: number) => Object.fromEntries(format.formatToParts(instant).map((part) => [part.type, part.value]));
  const first = parts(begin);
  const last = parts(finish - 1);
  let day = Date.UTC(Number(first.year), Number(first.month) - 1, Number(first.day));
  const lastDay = Date.UTC(Number(last.year), Number(last.month) - 1, Number(last.day));
  const localInstant = (date: number, clock: string) => zonedInstant(new Date(date).toISOString().slice(0, 10), clock, timeZone);
  const windows: Array<[number, number]> = [];
  while (day <= lastDay) {
    const weekday = new Date(day).getUTCDay();
    if (!args.preferences?.excludeWeekends || (weekday !== 0 && weekday !== 6)) {
      const start = localInstant(day, args.preferences?.startHour ?? "00:00");
      const end = args.preferences?.endHour ? localInstant(day, args.preferences.endHour) : localInstant(day + 86_400_000, "00:00");
      for (const [freeStart, freeEnd] of free) {
        const slotStart = Math.max(start, freeStart, begin);
        const slotEnd = Math.min(end, freeEnd, finish);
        if (slotEnd > slotStart) windows.push([slotStart, slotEnd]);
      }
    }
    day += 86_400_000;
  }
  const merged: Array<[number, number]> = [];
  windows.sort((a, b) => a[0] - b[0]);
  for (const [start, end] of windows) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  return output(merged);
}
