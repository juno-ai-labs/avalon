import { z } from "zod";
import { ConnectorError, type ConnectorConnectionContext, type ConnectorToolContext } from "./types";

export const CalendarSelectionFields = {
  date: z.string().date().describe("Local calendar date of the meeting, YYYY-MM-DD, for example 2026-10-21. The connector resolves the calendar's time zone and event ID."),
  title: z.string().min(1).optional().describe("Exact meeting title, case-insensitive. Omit when date and startTime already identify one meeting. Multiple matches are refused before writing."),
  startTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u).optional().describe("Local meeting start in HH:mm, for example 09:00. Omit to match any start time on date; use this to distinguish repeated meetings."),
};
export const MailQuerySchema = z.string().min(1).describe("Gmail search expression that identifies the email, for example from:alex@example.com subject:standup newer_than:7d. Uses Gmail search syntax, not a natural-language request. The connector requires a unique match; otherwise narrow the query or use an exact known ID.");
export interface GoogleSelectionDependencies {
  api: (connection: ConnectorConnectionContext, url: string, init?: RequestInit, allowedErrorStatuses?: readonly number[], argumentByParameter?: Readonly<Record<string, string>>) => Promise<Response>;
  readJson: (response: Response) => Promise<Record<string, unknown>>;
}
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const rows = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(object) : [];
export async function selectMail(query: string, kind: "message" | "thread" | "draft", context: ConnectorToolContext, deps: GoogleSelectionDependencies): Promise<string> {
  const collection = `${kind}s`;
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${collection}`);
  url.searchParams.set("q", query);
  // Two records distinguish a unique match from ambiguity; this is a
  // cardinality witness, not a caller-visible result or defensive limit.
  url.searchParams.set("maxResults", "2");
  const response = await deps.api(context.connection, url.toString(), { signal: context.signal });
  const data = await deps.readJson(response);
  const matches = rows(data[collection]);
  if (matches.length !== 1 || typeof matches[0]!.id !== "string" || typeof data.nextPageToken === "string") throw new ConnectorError("invalid_payload", matches.length ? "query matches more than one email. Narrow it with sender, subject, and date (for example after:2026/10/20 before:2026/10/22). No write was performed." : "query did not match an email. Broaden the sender, subject, or date and retry. No write was performed.", { field: "query", reason: matches.length ? "ambiguous_mail_selection" : "mail_not_found" });
  return matches[0]!.id as string;
}

/** Resolve a local calendar day without asking the model to calculate an offset. */
export function calendarDayBoundary(date: string, timeZone: string): string {
  const desired = Date.parse(`${date}T00:00:00Z`);
  const format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const localEpoch = (instant: number) => {
    const p = Object.fromEntries(format.formatToParts(instant).map((part) => [part.type, part.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  };
  const first = desired - (localEpoch(desired) - desired);
  return new Date(first - (localEpoch(first) - desired)).toISOString();
}
export async function selectCalendarEvent(selection: { date: string; title?: string | undefined; startTime?: string | undefined }, calendarId: string, context: ConnectorToolContext, deps: GoogleSelectionDependencies): Promise<string> {
  const settings = await deps.readJson(await deps.api(context.connection, `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}`, { signal: context.signal }));
  if (typeof settings.timeZone !== "string") throw new ConnectorError("provider_error", "date: Google did not return the calendar time zone, so the local meeting date cannot be resolved.", { field: "date", reason: "calendar_timezone_unavailable" });
  const timeZone = settings.timeZone;
  const format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const nextDay = new Date(Date.parse(`${selection.date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set("timeMin", calendarDayBoundary(selection.date, timeZone));
  url.searchParams.set("timeMax", calendarDayBoundary(nextDay, timeZone));
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("fields", "nextPageToken,items(id,summary,start,status)");
  if (selection.title) url.searchParams.set("q", selection.title);
  const matches: Record<string, unknown>[] = [];
  let hasNextPage = true;
  while (hasNextPage) {
    const data = await deps.readJson(await deps.api(context.connection, url.toString(), { signal: context.signal }));
    for (const event of rows(data.items)) {
      if (event.status === "cancelled") continue;
      if (selection.title && String(event.summary ?? "").toLocaleLowerCase() !== selection.title.toLocaleLowerCase()) continue;
      const start = object(event.start);
      let eventDate = start.date;
      let eventTime: string | undefined;
      if (typeof start.dateTime === "string") {
        const p = Object.fromEntries(format.formatToParts(new Date(start.dateTime)).map((part) => [part.type, part.value]));
        eventDate = `${p.year}-${p.month}-${p.day}`;
        eventTime = `${p.hour}:${p.minute}`;
      }
      if (eventDate !== selection.date || (selection.startTime && selection.startTime !== eventTime)) continue;
      matches.push(event);
    }
    if (matches.length > 1) break;
    hasNextPage = typeof data.nextPageToken === "string";
    if (hasNextPage) url.searchParams.set("pageToken", String(data.nextPageToken));
  }
  if (matches.length !== 1 || typeof matches[0]!.id !== "string") throw new ConnectorError("invalid_payload", matches.length ? "date/title/startTime match more than one meeting. Narrow the title, local startTime, or calendar. No write was performed." : "date/title/startTime did not match a meeting. Check the local date, time, title, and calendar. No write was performed.", { field: "date", reason: matches.length ? "ambiguous_event_selection" : "event_not_found" });
  return matches[0]!.id as string;
}

export function validateMailTarget(value: Record<string, unknown>, ctx: z.RefinementCtx): void {
  const selectors = [value.query, value.messageId, value.threadId, value.draftId].filter((item) => typeof item === "string" && item.length > 0);
  if (selectors.length !== 1) ctx.addIssue({ code: "custom", path: ["query"], message: "Use exactly one selector: a Gmail query, or the exact known ID for this tool" });
}
export function validateCalendarTarget(value: { eventId?: string | undefined; date?: string | undefined; title?: string | undefined; startTime?: string | undefined }, ctx: z.RefinementCtx): void {
  if (!value.eventId && !value.date) ctx.addIssue({ code: "custom", path: ["date"], message: "Supply an exact known eventId, or a local date with optional exact title and startTime" });
  if (value.eventId && (value.date || value.title || value.startTime)) ctx.addIssue({ code: "custom", path: ["eventId"], message: "Use eventId or date/title/startTime, not both" });
}
export const ConversationTargetFields = {
  query: MailQuerySchema.optional(),
  threadId: z.string().min(1).optional().describe("Exact Gmail thread ID, if already known from a trusted result or reference. Use this or query, not both. No lookup is needed for an exact ID."),
};
