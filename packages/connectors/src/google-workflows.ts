import { z } from "zod";
import { googleToolInputSchema } from "./google-tool-schema";
import type { ToolDefinition } from "@rally/contracts";
import { ConnectorError, type ConnectorToolContext, type ConnectorToolResult } from "./types";
import { CalendarSelectionFields, ConversationTargetFields, MailQuerySchema, selectCalendarEvent, selectMail, validateMailTarget, validateCalendarTarget, type GoogleSelectionDependencies } from "./google-selectors";
import { LocalClockSchema, GoogleTimeZoneSchema } from "./google-time";
import { suggestCalendarTimes } from "./google-availability";

const calendarId = z.string().min(1).optional().describe("Calendar ID, primary, or an unambiguous calendar name from calendar.list_calendars. Omit for the configured calendar.");
const CalendarActionTargetFields = { calendarId, ...CalendarSelectionFields, date: CalendarSelectionFields.date.optional(), eventId: z.string().min(1).optional().describe("Exact known event ID. For a single-event tool use a dated occurrence ID; recurring-series tools also accept the master ID. Use this or date/title/startTime, not both.") };
export const GoogleNotificationSchema = z.enum(["all", "externalOnly", "none"]).optional().describe("Who receives update emails: all, externalOnly, or none. Omit for all guests.");
const labels = z.array(z.string().min(1)).describe("Label IDs or exact label names from gmail.list_labels; system IDs such as INBOX, UNREAD, STARRED, IMPORTANT also work.");
const labelChanges = {
  addLabels: labels.optional().describe("Labels to add by exact name; IDs are also accepted if already known. Omit for none. Add UNREAD to mark unread, STARRED to star, or INBOX to return to inbox."),
  removeLabels: labels.optional().describe("Labels to remove by exact name; IDs are also accepted if already known. Omit for none. Remove INBOX to archive or UNREAD to mark read."),
};
function validateLabels(value: { addLabels?: string[] | undefined; removeLabels?: string[] | undefined }, ctx: z.RefinementCtx) {
  if (!value.addLabels?.length && !value.removeLabels?.length) ctx.addIssue({ code: "custom", path: ["addLabels"], message: "Choose at least one label to add or remove" });
  if (value.addLabels?.some((label) => value.removeLabels?.includes(label))) ctx.addIssue({ code: "custom", path: ["removeLabels"], message: "A label cannot be both added and removed" });
}
const page = {
  maxResults: z.number().int().positive().max(500).optional().describe("Maximum drafts per page, at most Gmail's published limit of 500. Omit for Google's default page size."),
  pageToken: z.string().min(1).nullish().describe("Copy the previous page's nextPageToken exactly; never construct a cursor. Omit or null for the first page. When `nextPageToken` is `null`, stop: there are no more pages."),
};
const clock = LocalClockSchema;
export const googleWorkflowSchemas: Record<string, z.ZodType> = {
  "calendar.cancel_event": z.strictObject({ ...CalendarActionTargetFields, sendUpdates: GoogleNotificationSchema }).superRefine(validateCalendarTarget),
  "calendar.cancel_recurring_series": z.strictObject({ ...CalendarActionTargetFields, sendUpdates: GoogleNotificationSchema }).superRefine(validateCalendarTarget),
  "calendar.respond_to_event": z.strictObject({ ...CalendarActionTargetFields,
    responseStatus: z.enum(["accepted", "declined", "tentative"]).describe("Your RSVP: accepted, declined, or tentative. Declining affects your attendance; cancelling removes an event you organize."),
    responseComment: z.string().optional().describe("Optional comment accompanying your RSVP. Omit to preserve the current comment."),
    sendUpdates: GoogleNotificationSchema,
  }).superRefine(validateCalendarTarget),
  "calendar.suggest_time": z.strictObject({
    attendeeEmails: z.array(z.string().email()).min(1).describe("Attendee calendar addresses, sourced from tools or supplied by the person. The connected account's own calendar is included too."),
    startTime: z.string().datetime({ offset: true }).describe("Inclusive beginning of the search interval, RFC 3339 with an offset, for example 2026-10-21T09:00:00-07:00."),
    endTime: z.string().datetime({ offset: true }).describe("Exclusive end of the search interval, RFC 3339 with an offset; must be later than startTime."),
    durationMinutes: z.number().int().positive().describe("Required meeting duration in minutes, for example 30. Returned slots fit this duration."),
    timeZone: GoogleTimeZoneSchema.optional().describe("IANA zone used for preferred hours and weekends, for example America/Los_Angeles. Omit for the connected calendar's zone."),
    preferences: z.strictObject({
      startHour: clock.optional().describe("Earliest local start, HH:mm, for example 09:00. Omit for midnight."),
      endHour: clock.optional().describe("Latest local end, HH:mm, for example 17:00. Omit for the end of the day. Must be after startHour."),
      excludeWeekends: z.boolean().optional().describe("Exclude Saturdays and Sundays in timeZone. Omit for false."),
      maxResults: z.number().int().positive().optional().describe("Return only this many earliest slots. Omit to return all fitting free windows."),
    }).optional().describe("Optional preferred local hours, weekend exclusion, and result count. Omit to search the complete interval."),
  }).superRefine((value, ctx) => {
    if (Date.parse(value.endTime) <= Date.parse(value.startTime)) ctx.addIssue({ code: "custom", path: ["endTime"], message: "endTime must be after startTime" });
    if (value.preferences?.startHour && value.preferences.endHour && value.preferences.startHour >= value.preferences.endHour) ctx.addIssue({ code: "custom", path: ["preferences", "endHour"], message: "endHour must be after startHour" });
  }),
  "gmail.list_labels": z.strictObject({}),
  "gmail.create_label": z.strictObject({ displayName: z.string().min(1).describe("Exact name of the new label, for example Projects/Alpha. Gmail uses / for nested labels; existing labels are discovered with gmail.list_labels.") }),
  "gmail.update_thread_labels": z.strictObject({ ...ConversationTargetFields, ...labelChanges }).superRefine(validateLabels).superRefine(validateMailTarget),
  "gmail.trash_thread": z.strictObject(ConversationTargetFields).superRefine(validateMailTarget),
  "gmail.restore_thread": z.strictObject(ConversationTargetFields).superRefine(validateMailTarget),
  "gmail.list_drafts": z.strictObject({ ...page, query: z.string().min(1).optional().describe("Gmail search expression such as subject:proposal. Omit to list all drafts. Applied filters are echoed in the result.") }),
  "gmail.read_draft": z.strictObject({ query: MailQuerySchema.optional(), draftId: z.string().min(1).optional().describe("Exact known Gmail draft resource ID, not its message ID. Use this or query, not both.") }).superRefine(validateMailTarget),
};
googleWorkflowSchemas["calendar.respond_to_recurring_series"] = googleWorkflowSchemas["calendar.respond_to_event"]!;
const inboxActions: Record<string, { description: string; add?: string[]; remove?: string[]; action?: "trash" | "restore" }> = {
  "gmail.archive": { description: "Archive the conversation matching query, removing it from Inbox while keeping the email searchable. Resolves the conversation internally; does not mark it read.", remove: ["INBOX"] },
  "gmail.move_to_inbox": { description: "Move the conversation matching query back into Inbox. Resolves the conversation internally; use restore_from_trash first for trashed mail.", add: ["INBOX"] },
  "gmail.mark_read": { description: "Mark every current message in the conversation matching query as read. Resolves the conversation and Gmail state internally.", remove: ["UNREAD"] },
  "gmail.mark_unread": { description: "Mark the conversation matching query as unread. Resolves the conversation internally.", add: ["UNREAD"] },
  "gmail.star": { description: "Star the conversation matching query. Resolves the conversation internally.", add: ["STARRED"] },
  "gmail.unstar": { description: "Remove stars from the conversation matching query. Resolves the conversation internally.", remove: ["STARRED"] },
  "gmail.mark_important": { description: "Mark the conversation matching query as important. Resolves the conversation internally.", add: ["IMPORTANT"] },
  "gmail.unmark_important": { description: "Remove the Important marker from the conversation matching query. Resolves the conversation internally.", remove: ["IMPORTANT"] },
  "gmail.mark_spam": { description: "Move the conversation matching query to Spam. Resolves the conversation and required Gmail operations internally.", add: ["SPAM"], remove: ["INBOX"] },
  "gmail.unmark_spam": { description: "Remove the conversation matching query from Spam. Searches Spam internally, so query needs only the sender, subject and date. This does not promise Inbox placement.", remove: ["SPAM"] },
  "gmail.trash": { description: "Move the conversation matching query to Trash. Resolves the conversation internally. Reversible with restore_from_trash; never permanently deletes mail.", action: "trash" },
  "gmail.restore_from_trash": { description: "Restore the conversation matching query from Trash. Searches Trash internally and resolves its identity. To put it in Inbox too, use move_to_inbox afterward.", action: "restore" },
};
for (const name of Object.keys(inboxActions)) googleWorkflowSchemas[name] = z.strictObject(ConversationTargetFields).superRefine(validateMailTarget);
googleWorkflowSchemas["gmail.label"] = z.strictObject({ ...ConversationTargetFields, labels: labels.min(1).describe("Custom label names to apply, for example Projects/Alpha. The connector resolves names to IDs internally; use create_label if the label does not exist.") }).superRefine(validateMailTarget);
googleWorkflowSchemas["gmail.remove_label"] = z.strictObject({ ...ConversationTargetFields, labels: labels.min(1).describe("Custom label names to remove, for example Projects/Alpha. The connector resolves names internally.") }).superRefine(validateMailTarget);

function tool(name: string, description: string, capability: string, write = false, paginated = false): ToolDefinition {
  return { name, description, capability, mode: write ? "write" : "read", idempotency: write ? "record_before_execute" : "safe",
    inputSchema: googleToolInputSchema(googleWorkflowSchemas[name]!),
    ...(paginated ? { pagination: { cursorParameter: "pageToken" } } : {}),
  };
}
export const googleWorkflowTools: ToolDefinition[] = [
  tool("calendar.cancel_event", "Cancel one meeting on a local date, including just one occurrence of a recurring event. Use an exact known eventId, or date with optional exact title and local startTime. The connector finds the event internally and refuses ambiguity. Guests are notified by default.", "calendar.write", true),
  tool("calendar.cancel_recurring_series", "Cancel the entire recurring series identified by a known eventId or date/title/local startTime. The connector resolves the series master internally. Use cancel_event when only one date should be cancelled. Guests are notified by default.", "calendar.write", true),
  tool("calendar.respond_to_event", "Accept, decline or tentatively accept one event identified by a known eventId or date/title/local startTime. The connector resolves the event and updates only your RSVP. This does not cancel the organizer's meeting.", "calendar.write", true),
  tool("calendar.respond_to_recurring_series", "Accept, decline or tentatively accept the recurring series identified by a known eventId or date/title/local startTime. The connector resolves the occurrence and its parent internally and preserves other attendees.", "calendar.write", true),
  tool("calendar.suggest_time", "Find common free time for the connected account and the requested attendees. Returns fitting windows and proposed meeting start/end times. An inaccessible calendar is reported as an error, never assumed free. Applies preferred local hours and weekend exclusions when requested.", "calendar.read"),
  tool("gmail.list_labels", "List system and custom Gmail labels with id, name, and type. Pass exact label names when changing message or thread labels; IDs are also accepted if already known.", "gmail.read"),
  tool("gmail.create_label", "Create a custom Gmail label and return its id and name for subsequent label operations.", "gmail.modify", true),
  ...Object.entries(inboxActions).map(([name, action]) => tool(name, `${action.description} Accepts an exact known threadId or a unique Gmail query.`, "gmail.modify", true)),
  tool("gmail.label", "Apply custom labels to the conversation matching query. Pass label names and a query or exact threadId; the connector locates the conversation and resolves all label IDs internally.", "gmail.modify", true),
  tool("gmail.remove_label", "Remove custom labels from the conversation matching query. Pass label names and a unique Gmail query or exact known threadId; the connector resolves missing identities internally.", "gmail.modify", true),
  tool("gmail.list_drafts", "List Gmail drafts, returning draft id, message id, threadId, subject, recipients, snippet, and webUrl. Read the full body with gmail.read_draft using the same query. Supports Gmail search expressions and pagination.", "gmail.read", false, true),
  tool("gmail.read_draft", "Read a Gmail draft's body, recipients, attachment metadata, message identity, and openable address. Accepts an exact known draftId or resolves a unique Gmail query.", "gmail.read"),
];

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue { return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {}; }
function records(value: unknown): RecordValue[] { return Array.isArray(value) ? value.map(record) : []; }
function gmailWebUrl(thread: unknown, folder: "all" | "drafts" = "all"): string | null {
  return typeof thread === "string" && thread ? `https://mail.google.com/mail/u/0/#${folder}/${encodeURIComponent(thread)}` : null;
}
export interface GoogleWorkflowDependencies extends GoogleSelectionDependencies {
  mapMailDetails: (drafts: RecordValue[], mapper: (draft: RecordValue) => Promise<RecordValue>) => Promise<RecordValue[]>;
  resolveCalendarId: (calendarId: string | undefined) => Promise<string>;
  sanitizeEvent: (event: RecordValue, calendarId: string) => RecordValue;
  sanitizeMessage: (message: RecordValue) => RecordValue;
}
export async function executeGoogleWorkflow(name: string, rawArgs: unknown, context: ConnectorToolContext, deps: GoogleWorkflowDependencies): Promise<ConnectorToolResult | null> {
  if (!googleWorkflowSchemas[name]) return null;
  const publicAction = name;
  const inbox = inboxActions[name];
  if (inbox) {
    const args = googleWorkflowSchemas[name]!.parse(rawArgs) as { query?: string; threadId?: string };
    name = inbox.action ? `gmail.${inbox.action}_thread` : "gmail.update_thread_labels";
    rawArgs = inbox.action ? args : { ...args, addLabels: inbox.add, removeLabels: inbox.remove };
  } else if (name === "gmail.label" || name === "gmail.remove_label") {
    const args = googleWorkflowSchemas[name]!.parse(rawArgs) as { query?: string; threadId?: string; labels: string[] };
    rawArgs = { query: args.query, threadId: args.threadId, ...(name === "gmail.label" ? { addLabels: args.labels } : { removeLabels: args.labels }) };
    name = "gmail.update_thread_labels";
  }

  const calendarTargetField = typeof record(rawArgs).eventId === "string" ? "eventId" : "date";
  const request = async (url: string, method = "GET", body?: unknown, allowed: number[] = [], etag?: string) => {
    const response = await deps.api(context.connection, url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(etag ? { headers: { "If-Match": etag } } : {}), signal: context.signal }, etag ? [...allowed, 412] : allowed);
    if (response.status === 412) throw new ConnectorError("invalid_payload", `${calendarTargetField}: the event changed while this operation was being prepared. Read it again before retrying; no update was applied.`, { field: calendarTargetField, reason: "event_changed" });
    return { response, data: response.status === 204 ? {} : await deps.readJson(response) };
  };
  const result = (output: RecordValue, summary: string, id?: string): ConnectorToolResult => ({ output, summary, ...(id ? { providerOperationId: id } : {}) });
  const requireRead = (capability: string) => {
    if (!context.connection.grantedScopes.includes(capability)) throw new ConnectorError("unsupported_capability", `This operation requires ${capability}; reconnect with that capability.`, { field: "scope", reason: "capability_not_granted", available: context.connection.grantedScopes });
  };
  if (["calendar.cancel_event", "calendar.cancel_recurring_series", "calendar.respond_to_event", "calendar.respond_to_recurring_series"].includes(name)) {
    const args = googleWorkflowSchemas[name]!.parse(rawArgs) as { calendarId?: string; eventId?: string; date?: string; title?: string; startTime?: string; sendUpdates?: string; responseStatus?: string; responseComment?: string };
    const scope = name.endsWith("_recurring_series") ? "series" : "occurrence";
    requireRead("calendar.read");
    const calendar = await deps.resolveCalendarId(args.calendarId);
    const selectedId = args.eventId ?? await selectCalendarEvent({ date: args.date!, title: args.title, startTime: args.startTime }, calendar, context, deps);
    if (selectedId.includes("@")) throw new ConnectorError("invalid_payload", "eventId must identify an event, not a calendar address.", { field: "eventId", reason: "wrong_id_family" });
    const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar)}/events/`;
    const readEvent = async (id: string) => {
      const { response, data } = await request(base + encodeURIComponent(id), "GET", undefined, [404, 410]);
      if (!response.ok) throw new ConnectorError("invalid_payload", `${calendarTargetField}: the selected meeting no longer exists on this calendar. Check date, title and local startTime before retrying.`, { field: calendarTargetField, reason: "event_not_found" });
      return data;
    };
    const initial = await readEvent(selectedId);
    let target = selectedId;
    let event = initial;
    if (scope === "series") {
      if (typeof initial.recurringEventId === "string") { target = initial.recurringEventId; event = await readEvent(target); }
      else if (!Array.isArray(initial.recurrence) || initial.recurrence.length === 0) throw new ConnectorError("invalid_payload", `${calendarTargetField}: the selected meeting is not recurring. Use the single-event tool instead.`, { field: calendarTargetField, reason: "event_not_recurring" });
    } else if (Array.isArray(initial.recurrence) && initial.recurrence.length > 0 && !initial.recurringEventId) {
      throw new ConnectorError("invalid_payload", `${calendarTargetField}: Google returned a series master rather than the selected occurrence. Choose a different date or use the recurring-series tool.`, { field: calendarTargetField, reason: "occurrence_id_required" });
    }
    const url = new URL(base + encodeURIComponent(target));
    url.searchParams.set("sendUpdates", args.sendUpdates ?? "all");
    if (name.startsWith("calendar.cancel_")) {
      if (record(event.organizer).self !== true) throw new ConnectorError("unsupported_capability", "The connected account is not this event's organizer. Use calendar.respond_to_event to decline your invitation; cancelling for everyone requires the organizer's connection.", { field: calendarTargetField, reason: "organizer_required" });
      await request(url.toString(), "DELETE", undefined, [], typeof event.etag === "string" ? event.etag : undefined);
      return result({ ...deps.sanitizeEvent(event, calendar), id: target, status: "cancelled", scope }, `Cancelled ${scope === "series" ? "recurring series" : "calendar event"}`, target);
    }
    if (event.attendeesOmitted === true) throw new ConnectorError("unsupported_capability", `${calendarTargetField}: Google omitted attendees for the selected meeting; the RSVP cannot safely preserve the full guest list.`, { field: calendarTargetField, reason: "attendees_unavailable" });
    const attendees = records(event.attendees);
    if (!attendees.some((attendee) => attendee.self === true)) throw new ConnectorError("unsupported_capability", `${calendarTargetField}: the connected account is not an attendee of the selected meeting. Choose an invitation on this account's calendar.`, { field: calendarTargetField, reason: "attendee_required" });
    const { data } = await request(url.toString(), "PATCH", { attendees: attendees.map((attendee) => attendee.self === true ? { ...attendee, responseStatus: args.responseStatus, ...(args.responseComment === undefined ? {} : { comment: args.responseComment }) } : attendee) }, [], typeof event.etag === "string" ? event.etag : undefined);
    return result({ ...deps.sanitizeEvent(data, calendar), scope }, `Responded ${args.responseStatus} to calendar event`, target);
  }
  if (name === "calendar.suggest_time") {
    const args = googleWorkflowSchemas[name]!.parse(rawArgs) as Parameters<typeof suggestCalendarTimes>[0];
    const own = (await request("https://www.googleapis.com/calendar/v3/calendars/primary")).data;
    const timeZone = args.timeZone ?? (typeof own.timeZone === "string" ? own.timeZone : undefined);
    if (!timeZone) throw new ConnectorError("provider_error", "timeZone: Google did not return the connected calendar's time zone. Supply an explicit IANA timeZone.", { field: "timeZone", reason: "calendar_timezone_unavailable" });
    const ids = [...new Set([typeof own.id === "string" ? own.id : "primary", ...args.attendeeEmails])];
    const calendars: RecordValue = {};
    // Calendar freeBusy accepts at most 50 expanded calendars (Google REST
    // freebusy.query, checked 2026-10-21); query larger attendee sets in chunks.
    for (let offset = 0; offset < ids.length; offset += 50) {
      const { data } = await request("https://www.googleapis.com/calendar/v3/freeBusy", "POST", { timeMin: args.startTime, timeMax: args.endTime, timeZone, items: ids.slice(offset, offset + 50).map((id) => ({ id })) });
      Object.assign(calendars, record(data.calendars));
    }
    for (const id of ids) {
      const calendar = record(calendars[id]);
      if (!Array.isArray(calendar.busy) || records(calendar.errors).length) throw new ConnectorError("unsupported_capability", "attendeeEmails: Google could not read availability for every requested calendar. Check calendar sharing or choose accessible attendees; no inaccessible calendar was assumed free.", { field: "attendeeEmails", reason: "availability_unavailable" });
    }
    return result(suggestCalendarTimes(args, timeZone, ids.flatMap((id) => records(record(calendars[id]).busy))), "Found common calendar availability");
  }
  const mail = "https://gmail.googleapis.com/gmail/v1/users/me/";
  const readLabels = async () => records((await request(mail + "labels")).data.labels);
  const labelRow = (label: RecordValue) => ({ id: label.id, name: label.name, type: label.type });
  if (name === "gmail.list_labels") {
    googleWorkflowSchemas[name]!.parse(rawArgs);
    return result({ items: (await readLabels()).map(labelRow) }, "Listed Gmail labels");
  }
  if (name === "gmail.create_label") {
    const { displayName } = googleWorkflowSchemas[name]!.parse(rawArgs) as { displayName: string };
    return result(labelRow((await request(mail + "labels", "POST", { name: displayName, labelListVisibility: "labelShow", messageListVisibility: "show" })).data), `Created Gmail label “${displayName}”`);
  }
  if (name === "gmail.update_thread_labels") {
    const args = googleWorkflowSchemas[name]!.parse(rawArgs) as { query?: string; threadId?: string; addLabels?: string[]; removeLabels?: string[] };
    const query = args.removeLabels?.some((label) => label.toUpperCase() === "SPAM") ? `in:spam (${args.query})` : args.query;
    const id = args.threadId ?? await selectMail(query!, "thread", context, deps, { includeSpamTrash: publicAction === "gmail.unmark_spam" });
    const references = [...args.addLabels ?? [], ...args.removeLabels ?? []];
    const systemLabels = ["INBOX", "UNREAD", "STARRED", "IMPORTANT", "SPAM"];
    const catalog = references.every((label) => systemLabels.includes(label.toUpperCase()))
      ? systemLabels.map((id) => ({ id, name: id, type: "system" }))
      : await readLabels();
    const resolve = (value: string) => {
      const field = publicAction === "gmail.label" || publicAction === "gmail.remove_label" ? "labels" : args.addLabels?.includes(value) ? "addLabels" : "removeLabels";
      const matches = catalog.filter((label) => label.id === value || label.name === value || (label.type === "system" && String(label.id).toLowerCase() === value.toLowerCase()));
      const ids = [...new Set(matches.map((label) => String(label.id)))];
      if (ids.length !== 1) throw new ConnectorError("invalid_payload", `Label “${value}” is ${ids.length ? "ambiguous" : "unknown"}. Use an exact id from gmail.list_labels.`, { field, reason: ids.length ? "ambiguous_label_name" : "label_not_found" });
      return ids[0]!;
    };
    const resolved = new Map(references.map((value) => [value, resolve(value)]));
    const add = [...new Set((args.addLabels ?? []).map((value) => resolved.get(value)!))];
    const remove = [...new Set((args.removeLabels ?? []).map((value) => resolved.get(value)!))];
    if (add.includes("TRASH") || remove.includes("TRASH")) throw new ConnectorError("invalid_payload", "Use gmail.trash or gmail.restore_from_trash to change Trash.", { field: "labels", reason: "use_trash_tool" });
    if (add.some((id) => remove.includes(id))) throw new ConnectorError("invalid_payload", "A label cannot be both added and removed, including when one reference uses its name and the other its id.", { field: "removeLabels", reason: "conflicting_label_changes" });
    const { data } = await request(mail + "threads/" + encodeURIComponent(id) + "/modify", "POST", { addLabelIds: add, removeLabelIds: remove });
    return result({ id: data.id ?? id, threadId: data.threadId ?? id, labelIds: data.labelIds, addLabels: add, removeLabels: remove, webUrl: gmailWebUrl(data.threadId ?? id) }, `Completed ${publicAction.replace("gmail.", "").replaceAll("_", " ")}`, id);
  }
  if (/^gmail\.(trash|restore)_thread$/u.test(name)) {
    const args = googleWorkflowSchemas[name]!.parse(rawArgs) as { query?: string; threadId?: string };
    const query = name.includes(".restore_") ? `in:trash (${args.query})` : args.query;
    const id = args.threadId ?? await selectMail(query!, "thread", context, deps, { includeSpamTrash: name === "gmail.restore_thread" });
    const action = name.includes(".trash_") ? "trash" : "untrash";
    const { data } = await request(mail + "threads/" + encodeURIComponent(id) + "/" + action, "POST");
    return result({ id, threadId: data.threadId ?? id, trashed: action === "trash", webUrl: gmailWebUrl(data.threadId ?? id) }, action === "trash" ? "Moved mail to Trash" : "Restored mail from Trash", id);
  }
  if (name === "gmail.read_draft") {
    const args = googleWorkflowSchemas[name]!.parse(rawArgs) as { query?: string; draftId?: string };
    const draftId = args.draftId ?? await selectMail(args.query!, "draft", context, deps);
    const { data } = await request(mail + "drafts/" + encodeURIComponent(draftId) + "?format=full");
    return result({ id: data.id, message: deps.sanitizeMessage(record(data.message)), webUrl: gmailWebUrl(record(data.message).threadId, "drafts") }, "Read Gmail draft", draftId);
  }
  if (name === "gmail.list_drafts") {
    const args = googleWorkflowSchemas[name]!.parse(rawArgs) as { maxResults?: number; query?: string; pageToken?: string | null };
    const url = new URL(mail + "drafts");
    if (args.maxResults) url.searchParams.set("maxResults", String(args.maxResults));
    if (args.query) url.searchParams.set("q", args.query);
    if (args.pageToken) url.searchParams.set("pageToken", args.pageToken);
    const { data } = await request(url.toString());
    const items = await deps.mapMailDetails(records(data.drafts), async (draft) => {
      const { response, data: detail } = await request(mail + "drafts/" + encodeURIComponent(String(draft.id)) + "?format=metadata", "GET", undefined, [404]);
      if (response.status === 404) return { id: draft.id, unavailable: true };
      const message = deps.sanitizeMessage(record(detail.message));
      return { id: draft.id, messageId: message.id, threadId: message.threadId, subject: message.subject, to: message.to, cc: message.cc, bcc: message.bcc, snippet: message.snippet, webUrl: gmailWebUrl(message.threadId, "drafts") };
    });
    return { ...result({ items, appliedFilters: { query: args.query ?? null } }, `Found ${items.length} Gmail drafts`), pagination: { continuations: typeof data.nextPageToken === "string" ? [{ operation: name, slot: "nextPageId", input: { ...args, pageToken: data.nextPageToken } }] : [] } };
  }
  return null;
}
