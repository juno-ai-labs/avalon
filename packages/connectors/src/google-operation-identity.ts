import type { ConnectorOperationIdentity, ConnectorToolResult } from "./types";

const FILE_PARAMETERS: Readonly<Record<string, string>> = {
  "drive.get_metadata": "fileId", "drive.download": "fileId", "drive.export": "fileId",
  "docs.read_document": "documentId", "docs.append_text": "documentId", "docs.replace_text": "documentId",
  "sheets.read_spreadsheet": "spreadsheetId", "sheets.read_values": "spreadsheetId",
  "sheets.update_values": "spreadsheetId", "sheets.append_values": "spreadsheetId",
};
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function key(kind: string, value: unknown): string[] {
  return typeof value === "string" && value.length > 0 ? [`google:${kind}:${value}`] : [];
}

export function googleOperationIdentity(name: string, input: unknown): ConnectorOperationIdentity {
  const args = object(input);
  const parameter = FILE_PARAMETERS[name];
  if (parameter) return { kind: "resource", resourceKeys: key("file", args[parameter]) };
  const resourceKeys = name.startsWith("gmail.")
    ? [...key("message", args.messageId), ...key("thread", args.threadId), ...key("draft", args.draftId), ...key("label", args.labelId),
      ...(["gmail.search", "gmail.find_contacts", "gmail.list_drafts"].includes(name) ? [] : key("mail_query", args.query))]
    : name.startsWith("calendar.")
      ? [...key(`event:${String(args.calendarId ?? "primary")}`, args.eventId),
        ...(args.calendarId && args.calendarId !== "primary" ? key("calendar", args.calendarId) : [])]
      : [];
  return { kind: "account", resourceKeys };
}

/** Provider IDs returned by a call retain the account that produced them. */
export function googleOperationResultKeys(name: string, input: unknown, result: ConnectorToolResult): string[] {
  const output = object(result.output);
  const keys = [...googleOperationIdentity(name, input).resourceKeys];
  const rows = (field: string) => Array.isArray(output[field]) ? output[field].map(object) : [];
  if (name.startsWith("drive.") || name.startsWith("docs.") || name.startsWith("sheets.")) {
    keys.push(...key("file", output.documentId ?? output.spreadsheetId ?? output.id));
    for (const file of rows("files")) keys.push(...key("file", file.id));
  } else if (name.startsWith("gmail.")) {
    keys.push(...key("mail_query", object(input).query));
    const message = object(output.message);
    const draft = name.includes("draft");
    keys.push(...key(name === "gmail.create_label" ? "label" : draft ? "draft" : name === "gmail.read_thread" ? "thread" : "message", output.id),
      ...key("message", output.messageId ?? message.id), ...key("thread", output.threadId ?? message.threadId));
    for (const mail of rows("messages")) keys.push(...key("message", mail.id), ...key("thread", mail.threadId));
    for (const item of rows("drafts")) keys.push(...key("draft", item.id), ...key("message", item.messageId), ...key("thread", item.threadId));
    for (const label of rows("labels")) keys.push(...key("label", label.id));
  } else if (name.startsWith("calendar.")) {
    const calendar = object(input).calendarId ?? "primary";
    for (const event of [output, object(output.event), ...rows("events"), ...rows("items")]) {
      const calendarId = event.calendarId ?? calendar;
      keys.push(...key(`event:${String(calendarId)}`, event.id ?? event.eventId));
      if (calendarId !== "primary" && (event.id || event.eventId)) keys.push(...key("calendar", calendarId));
    }
    for (const item of rows("calendars")) keys.push(...key("calendar", item.id));
  }
  return [...new Set(keys)];
}
