import {
  ConnectorManifestSchema,
  type ConnectorManifest,
  type ConnectorSurface,
  type NormalizedActivity,
  type ToolDefinition,
} from "@avalon/contracts";
import { z } from "zod";
import {
  assertPrincipalAccess,
  ConnectorError,
  type ConnectorAdapter,
  type ConnectorConnectionContext,
  type ResolvedConnectorAdapter,
} from "./types";
import { createGitHubConnector, type GitHubConnectorConfig } from "./github";
import { createLinearConnector, type LinearConnectorConfig } from "./linear";
import { createNotionConnector, type NotionConnectorConfig } from "./notion";

export {
  assertPrincipalAccess,
  connectorCapabilitySupportsScope,
  ConnectorError,
  type ConnectorAdapter,
  type ConnectorAuthorizationCallbackInput,
  type ConnectorAuthorizationInput,
  type ConnectorConnectionContext,
  type ConnectorPollResult,
  type ResolvedConnectorAdapter,
  type ConnectorToolContext,
  type ConnectorToolResult,
  type ConnectorNativeAgentAdapter,
  type ConnectorNativeAgentExecutionContext,
} from "./types";
export {
  createGitHubConnector,
  createGitHubAppJwt,
  getGitHubInstallation,
  mintGitHubInstallationToken,
  verifyGitHubWebhook,
  verifyGitHubWebhookSignature,
  discoverGitHubWebhookResources,
  normalizeGitHubWebhook,
  refreshGitHubUserCredentials,
  canGitHubPersonalConnectionAccessRepository,
  discoverGitHubConnectionRepositories,
  GitHubCapabilities,
  GitHubWebhookResourceLimits,
  githubTools,
  type GitHubConnectorConfig,
  type GitHubInstallationToken,
  type GitHubUserToken,
  type GitHubWebhookDelivery,
  type GitHubWebhookResourceDiscovery,
  type GitHubWebhookResourceHint,
  type VerifyGitHubWebhookInput,
} from "./github";
export {
  canPersonalLinearConnectionAccessWebhook,
  createLinearConnector,
  verifyLinearWebhook,
  normalizeLinearWebhook,
  LinearCapabilities,
  LinearCapabilityScopes,
  LinearAgentOAuthScopes,
  type LinearConnectorConfig,
  type PersonalLinearWebhookAccessInput,
  type VerifyLinearWebhookInput,
  type VerifiedLinearWebhook,
} from "./linear";
export {
  createLinearNativeAgentProtocol,
  createLinearAgentActivity,
  executeLinearAgentGraphql,
  isLinearAgentStopRequest,
  linearAgentActivity,
  linearAgentInvocation,
  LinearAgentActivityContentSchema,
  LinearAgentActivityCreateInputSchema,
  LinearAgentActionContentSchema,
  LinearAgentElicitationContentSchema,
  LinearAgentErrorContentSchema,
  LinearAgentExternalUrlSchema,
  LinearAgentPlanStepSchema,
  LinearAgentResponseContentSchema,
  LinearAgentSessionEventSchema,
  LinearAgentThoughtContentSchema,
  LinearNativeAgentProtocolDescriptor,
  parseLinearAgentSessionEvent,
  parseVerifiedLinearAgentSessionEvent,
  updateLinearAgentSession,
  VerifiedLinearAgentSessionEventSchema,
  type LinearAgentActivityContent,
  type LinearAgentActivityCreateInput,
  type LinearAgentActivityResult,
  type LinearAgentExternalUrl,
  type LinearAgentGraphqlExecutor,
  type LinearAgentInvocation,
  type LinearAgentPlanStep,
  type LinearAgentProtocolCommand,
  type LinearAgentProtocolResult,
  type LinearAgentSessionEvent,
  type LinearAgentSessionResult,
  type LinearNativeAgentProtocol,
  type VerifiedLinearAgentSessionEvent,
} from "./linear-agent";
export {
  createNotionConnector,
  verifyNotionWebhook,
  readNotionWebhookVerificationToken,
  normalizeNotionWebhook,
  NotionCapabilities,
  NotionCapabilitySettings,
  notionTools,
  type NotionConnectorConfig,
  type VerifyNotionWebhookInput,
  type VerifiedNotionWebhook,
} from "./notion";

export interface GoogleConnectorConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetch?: typeof globalThis.fetch;
}

const googleScopes = {
  identity: ["openid", "email", "profile"],
  gmailRead: ["https://www.googleapis.com/auth/gmail.readonly"],
  gmailDraft: ["https://www.googleapis.com/auth/gmail.compose"],
  gmailSend: ["https://www.googleapis.com/auth/gmail.send"],
  calendarRead: [
    "https://www.googleapis.com/auth/calendar.events.readonly",
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly"
  ],
  calendarWrite: ["https://www.googleapis.com/auth/calendar.events"],
  driveRead: ["https://www.googleapis.com/auth/drive.readonly"],
  docsRead: ["https://www.googleapis.com/auth/documents.readonly"],
  docsWrite: ["https://www.googleapis.com/auth/documents"],
  sheetsRead: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  sheetsWrite: ["https://www.googleapis.com/auth/spreadsheets"]
} as const;

export const GoogleCapabilityScopes = googleScopes;

const googleTools: ToolDefinition[] = [
  {
    name: "google.gmail.search",
    description: "Search the authorized user's Gmail messages.",
    capability: "gmail.read",
    mode: "read",
    idempotency: "safe",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { query: { type: "string" }, maxResults: { type: "integer", minimum: 1, maximum: 25 } },
      required: ["query"]
    }
  },
  {
    name: "google.gmail.read_thread",
    description: "Read a Gmail thread by provider thread ID.",
    capability: "gmail.read",
    mode: "read",
    idempotency: "safe",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { threadId: { type: "string" } },
      required: ["threadId"]
    }
  },
  {
    name: "google.gmail.read_message",
    description: "Read one Gmail message with bounded text content and attachment metadata.",
    capability: "gmail.read",
    mode: "read",
    idempotency: "safe",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { messageId: { type: "string" } },
      required: ["messageId"]
    }
  },
  {
    name: "google.gmail.create_draft",
    description: "Create a Gmail draft for the authorized user.",
    capability: "gmail.draft",
    mode: "write",
    idempotency: "record_before_execute",
    inputSchema: emailInputSchema()
  },
  {
    name: "google.gmail.send",
    description: "Send an email as the authorized user.",
    capability: "gmail.send",
    mode: "write",
    idempotency: "record_before_execute",
    inputSchema: emailInputSchema()
  },
  {
    name: "google.calendar.list_calendars",
    description: "List calendars visible to the authorized Google account.",
    capability: "calendar.read",
    mode: "read",
    idempotency: "safe",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { maxResults: { type: "integer", minimum: 1, maximum: 250 } }
    }
  },
  {
    name: "google.calendar.list_events",
    description: "List authorized calendar events in a time range.",
    capability: "calendar.read",
    mode: "read",
    idempotency: "safe",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        calendarId: { type: "string", description: "Calendar ID; defaults to primary" },
        timeMin: { type: "string", format: "date-time" },
        timeMax: { type: "string", format: "date-time" },
        query: { type: "string" },
        maxResults: { type: "integer", minimum: 1, maximum: 100 }
      },
      required: ["timeMin", "timeMax"]
    }
  },
  {
    name: "google.calendar.read_event",
    description: "Read one event from the connection's configured Google Calendar.",
    capability: "calendar.read",
    mode: "read",
    idempotency: "safe",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        calendarId: { type: "string", description: "Calendar ID; defaults to primary" },
        eventId: { type: "string" }
      },
      required: ["eventId"]
    }
  },
  {
    name: "google.calendar.create_event",
    description: "Create an event on the connection's configured Google Calendar.",
    capability: "calendar.write",
    mode: "write",
    idempotency: "record_before_execute",
    inputSchema: calendarEventWriteInputSchema(false)
  },
  {
    name: "google.calendar.update_event",
    description: "Update selected fields on an existing Google Calendar event.",
    capability: "calendar.write",
    mode: "write",
    idempotency: "record_before_execute",
    inputSchema: calendarEventWriteInputSchema(true)
  },
  {
    name: "google.drive.search",
    description: "Search accessible Google Drive files.",
    capability: "drive.read",
    mode: "read",
    idempotency: "safe",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { query: { type: "string" }, maxResults: { type: "integer", minimum: 1, maximum: 100 } },
      required: ["query"]
    }
  },
  {
    name: "google.drive.get_metadata",
    description: "Read bounded metadata for one accessible Google Drive file.",
    capability: "drive.read",
    mode: "read",
    idempotency: "safe",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { fileId: { type: "string" } },
      required: ["fileId"]
    }
  },
  {
    name: "google.drive.download",
    description: "Read bounded text from a Drive file; binary content is never returned to the model.",
    capability: "drive.read",
    mode: "read",
    idempotency: "safe",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { fileId: { type: "string" } },
      required: ["fileId"]
    }
  },
  {
    name: "google.drive.export",
    description: "Export a Google Workspace document to plain text or PDF.",
    capability: "drive.read",
    mode: "read",
    idempotency: "safe",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fileId: { type: "string" },
        mimeType: { type: "string", enum: ["text/plain", "application/pdf"] }
      },
      required: ["fileId", "mimeType"]
    }
  },
  {
    name: "google.docs.read_document",
    description: "Read the structure and bounded text of a Google Doc.",
    capability: "docs.read",
    mode: "read",
    idempotency: "safe",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { documentId: { type: "string" } },
      required: ["documentId"]
    }
  },
  {
    name: "google.docs.create_document",
    description: "Create a Google Doc, optionally with initial plain-text content.",
    capability: "docs.write",
    mode: "write",
    idempotency: "record_before_execute",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", minLength: 1, maxLength: 500 },
        text: { type: "string", maxLength: 100000 }
      },
      required: ["title"]
    }
  },
  {
    name: "google.docs.append_text",
    description: "Append plain text to the end of a Google Doc.",
    capability: "docs.write",
    mode: "write",
    idempotency: "record_before_execute",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        documentId: { type: "string" },
        text: { type: "string", minLength: 1, maxLength: 100000 }
      },
      required: ["documentId", "text"]
    }
  },
  {
    name: "google.docs.replace_text",
    description: "Replace every exact occurrence of text in a Google Doc.",
    capability: "docs.write",
    mode: "write",
    idempotency: "record_before_execute",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        documentId: { type: "string" },
        find: { type: "string", minLength: 1, maxLength: 10000 },
        replace: { type: "string", maxLength: 100000 },
        matchCase: { type: "boolean", default: true }
      },
      required: ["documentId", "find", "replace"]
    }
  },
  {
    name: "google.sheets.read_spreadsheet",
    description: "Read bounded spreadsheet and sheet metadata from Google Sheets.",
    capability: "sheets.read",
    mode: "read",
    idempotency: "safe",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { spreadsheetId: { type: "string" } },
      required: ["spreadsheetId"]
    }
  },
  {
    name: "google.sheets.read_values",
    description: "Read bounded cell values from an A1 range in Google Sheets.",
    capability: "sheets.read",
    mode: "read",
    idempotency: "safe",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        spreadsheetId: { type: "string" },
        range: { type: "string", minLength: 1, maxLength: 1000 },
        majorDimension: { type: "string", enum: ["ROWS", "COLUMNS"] }
      },
      required: ["spreadsheetId", "range"]
    }
  },
  {
    name: "google.sheets.create_spreadsheet",
    description: "Create a Google spreadsheet with optional named sheets.",
    capability: "sheets.write",
    mode: "write",
    idempotency: "record_before_execute",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", minLength: 1, maxLength: 500 },
        sheetTitles: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 100 },
          maxItems: 25
        }
      },
      required: ["title"]
    }
  },
  {
    name: "google.sheets.update_values",
    description: "Replace cell values in an A1 range in Google Sheets.",
    capability: "sheets.write",
    mode: "write",
    idempotency: "record_before_execute",
    inputSchema: sheetValuesWriteInputSchema(false)
  },
  {
    name: "google.sheets.append_values",
    description: "Append rows after a table in an A1 range in Google Sheets.",
    capability: "sheets.write",
    mode: "write",
    idempotency: "record_before_execute",
    inputSchema: sheetValuesWriteInputSchema(true)
  }
];

function calendarEventWriteInputSchema(includeEventId: boolean): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    calendarId: { type: "string", description: "Calendar ID; defaults to primary" },
    summary: { type: "string", minLength: 1, maxLength: 1000 },
    description: { type: "string", maxLength: 20000 },
    location: { type: "string", maxLength: 2000 },
    start: { type: "string", format: "date-time" },
    end: { type: "string", format: "date-time" },
    timeZone: { type: "string", minLength: 1, maxLength: 100 },
    attendeeEmails: {
      type: "array",
      items: { type: "string", format: "email" },
      maxItems: 50
    }
  };
  if (includeEventId) properties.eventId = { type: "string" };
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: includeEventId ? ["eventId"] : ["summary", "start", "end"]
  };
}

function sheetValuesWriteInputSchema(append: boolean): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      spreadsheetId: { type: "string" },
      range: { type: "string", minLength: 1, maxLength: 1000 },
      values: {
        type: "array",
        items: { type: "array", items: { type: ["string", "number", "boolean", "null"] }, maxItems: 1000 },
        maxItems: 1000
      },
      valueInputOption: { type: "string", enum: ["RAW", "USER_ENTERED"] },
      ...(append ? { insertDataOption: { type: "string", enum: ["INSERT_ROWS", "OVERWRITE"] } } : {})
    },
    required: ["spreadsheetId", "range", "values"]
  };
}

function emailInputSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      to: { type: "array", items: { type: "string", format: "email" }, minItems: 1 },
      cc: { type: "array", items: { type: "string", format: "email" } },
      subject: { type: "string" },
      body: { type: "string" },
      threadId: { type: "string" },
      inReplyTo: { type: "string", description: "RFC Message-ID header of the message being replied to" },
      references: {
        type: "array",
        items: { type: "string" },
        maxItems: 50,
        description: "RFC Message-ID reference chain for a threaded reply"
      }
    },
    required: ["to", "subject", "body"]
  };
}

const RfcMessageIdSchema = z.string().min(3).max(998).refine(
  (value) => !/[\r\n]/u.test(value) && /^<[^<>\s]+>$/u.test(value),
  "Use one RFC Message-ID enclosed in angle brackets"
);

const EmailArgsSchema = z.object({
  to: z.array(z.string().email()).min(1),
  cc: z.array(z.string().email()).default([]),
  subject: z.string().min(1).max(998),
  body: z.string().max(500_000),
  threadId: z.string().optional(),
  inReplyTo: RfcMessageIdSchema.optional(),
  references: z.array(RfcMessageIdSchema).max(50).default([])
}).superRefine((value, context) => {
  if (value.threadId && !value.inReplyTo) {
    context.addIssue({
      code: "custom",
      message: "A Gmail threaded reply requires the original message's RFC Message-ID",
      path: ["inReplyTo"]
    });
  }
});

const CalendarEventCreateArgsSchema = z.object({
  calendarId: z.string().min(1).max(1_024).optional(),
  summary: z.string().min(1).max(1_000),
  description: z.string().max(20_000).optional(),
  location: z.string().max(2_000).optional(),
  start: z.string().datetime({ offset: true }),
  end: z.string().datetime({ offset: true }),
  timeZone: z.string().min(1).max(100).optional(),
  attendeeEmails: z.array(z.string().email()).max(50).default([])
}).refine((value) => Date.parse(value.end) > Date.parse(value.start), {
  message: "Calendar event end must be after its start",
  path: ["end"]
});

const CalendarEventUpdateArgsSchema = z.object({
  calendarId: z.string().min(1).max(1_024).optional(),
  eventId: z.string().min(1).max(1_024),
  summary: z.string().min(1).max(1_000).optional(),
  description: z.string().max(20_000).optional(),
  location: z.string().max(2_000).optional(),
  start: z.string().datetime({ offset: true }).optional(),
  end: z.string().datetime({ offset: true }).optional(),
  timeZone: z.string().min(1).max(100).optional(),
  attendeeEmails: z.array(z.string().email()).max(50).optional()
}).superRefine((value, context) => {
  if (Object.keys(value).every((key) => key === "eventId" || key === "calendarId")) {
    context.addIssue({ code: "custom", message: "Choose at least one event field to update" });
  }
  if ((value.start && !value.end) || (!value.start && value.end)) {
    context.addIssue({ code: "custom", message: "Update event start and end together", path: ["end"] });
  }
  if (value.timeZone && (!value.start || !value.end)) {
    context.addIssue({ code: "custom", message: "Update the event start and end when changing its time zone", path: ["timeZone"] });
  }
  if (value.start && value.end && Date.parse(value.end) <= Date.parse(value.start)) {
    context.addIssue({ code: "custom", message: "Calendar event end must be after its start", path: ["end"] });
  }
});

const SheetCellValueSchema = z.union([z.string().max(50_000), z.number().finite(), z.boolean(), z.null()]);
const SheetValuesSchema = z.array(z.array(SheetCellValueSchema).max(1_000)).max(1_000).superRefine((rows, context) => {
  const cells = rows.reduce((total, row) => total + row.length, 0);
  if (cells > 10_000) context.addIssue({ code: "custom", message: "A Sheets write is limited to 10,000 cells" });
});

const SheetValuesWriteArgsSchema = z.object({
  spreadsheetId: z.string().min(1).max(500),
  range: z.string().min(1).max(1_000),
  values: SheetValuesSchema,
  valueInputOption: z.enum(["RAW", "USER_ENTERED"]).default("USER_ENTERED"),
  insertDataOption: z.enum(["INSERT_ROWS", "OVERWRITE"]).optional()
});

const GOOGLE_POLL_PAGE_SIZE = 50;
const GOOGLE_MAX_POLL_PAGES = 3;
const GOOGLE_MAX_GMAIL_CHANGES = 50;
const GOOGLE_MAX_GMAIL_PENDING = 250;
const GOOGLE_POLL_RESPONSE_BYTES = 1_000_000;
const GOOGLE_HYDRATION_RESPONSE_BYTES = 1_000_000;
const GOOGLE_MAX_HYDRATED_MESSAGES = 50;
const GOOGLE_MAX_HYDRATED_TEXT_BYTES = 256_000;
const GOOGLE_TOOL_RESPONSE_BYTES = 512_000;
const GOOGLE_TOOL_TEXT_BYTES = 128_000;
const GOOGLE_TOOL_GMAIL_MESSAGES = 25;

const GmailChangeRefSchema = z.object({
  historyId: z.string().min(1),
  kind: z.enum(["added", "deleted", "labels_added", "labels_removed"]),
  messageId: z.string().min(1),
  threadId: z.string().min(1).optional(),
  labelIds: z.array(z.string()).max(100).default([])
});

type GmailChangeRef = z.infer<typeof GmailChangeRefSchema>;

const GmailPollCursorSchema = z.object({
  historyId: z.string().min(1).optional(),
  pageToken: z.string().min(1).optional(),
  pendingHistoryId: z.string().min(1).optional(),
  reconciliationHistoryId: z.string().min(1).optional(),
  reconciliationPageToken: z.string().min(1).optional(),
  pendingChanges: z.array(GmailChangeRefSchema).max(GOOGLE_MAX_GMAIL_PENDING).default([])
});

const CalendarPollCursorSchema = z.object({
  syncToken: z.string().min(1).optional(),
  pageToken: z.string().min(1).optional(),
  baselining: z.boolean().optional(),
  completionCheckedAt: z.string().datetime().optional(),
  completionUntil: z.string().datetime().optional(),
  completionPageToken: z.string().min(1).optional()
});

const DrivePollCursorSchema = z.object({
  pageToken: z.string().min(1).optional(),
  continuing: z.boolean().optional()
});

type GmailPollCursor = z.infer<typeof GmailPollCursorSchema>;
type CalendarPollCursor = z.infer<typeof CalendarPollCursorSchema>;
type DrivePollCursor = z.infer<typeof DrivePollCursorSchema>;

interface GooglePollCursor extends Record<string, unknown> {
  gmail?: GmailPollCursor;
  calendar?: CalendarPollCursor;
  drive?: DrivePollCursor;
}

export function createGoogleConnector(config: GoogleConnectorConfig): ConnectorAdapter {
  if (!config.clientId || !config.clientSecret || !config.redirectUri) {
    throw new ConnectorError("invalid_configuration", "Google OAuth is not fully configured");
  }
  const fetcher = config.fetch ?? globalThis.fetch;

  async function refreshGoogleCredentials(
    connection: ConnectorConnectionContext,
    signal?: AbortSignal | null
  ): Promise<Record<string, unknown>> {
    const refreshToken = String(connection.credentials.refreshToken ?? "");
    if (!refreshToken) {
      throw new ConnectorError("unauthorized", "Google connection needs reconnecting", {
        reconnectRequired: true,
        reason: "missing_refresh_token"
      });
    }
    const response = await fetcher("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "refresh_token"
      }),
      ...(signal ? { signal } : {})
    });
    const payload = await safeJsonBounded(response, 256_000);
    if (!response.ok) {
      const reason = readString(payload, "error") ?? "token_refresh_failed";
      throw new ConnectorError(
        "unauthorized",
        reason === "invalid_grant"
          ? "Google authorization was revoked; reconnect this account"
          : "Google token refresh failed",
        { reconnectRequired: true, reason, provider: "google", payload }
      );
    }
    const refreshed = {
      ...connection.credentials,
      ...normalizeGoogleToken(payload),
      refreshToken
    };
    connection.credentials = refreshed;
    return refreshed;
  }

  async function api(
    connection: ConnectorConnectionContext,
    url: string,
    init: RequestInit = {},
    allowedErrorStatuses: readonly number[] = []
  ): Promise<Response> {
    let token = String(connection.credentials.accessToken ?? "");
    if (!token && connection.credentials.refreshToken) {
      await refreshGoogleCredentials(connection, init.signal);
      token = String(connection.credentials.accessToken ?? "");
    }
    if (!token) {
      throw new ConnectorError("unauthorized", "Google access token is unavailable", {
        reconnectRequired: true,
        reason: "missing_access_token"
      });
    }
    const request = async (accessToken: string) => fetcher(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {})
      }
    });
    let response = await request(token);
    if (response.status === 401 && connection.credentials.refreshToken) {
      await refreshGoogleCredentials(connection, init.signal);
      response = await request(String(connection.credentials.accessToken ?? ""));
    }
    if (!response.ok && !allowedErrorStatuses.includes(response.status)) {
      const details = await safeJsonBounded(response, 256_000);
      if (response.status === 401) {
        throw new ConnectorError("unauthorized", "Google connection needs reconnecting", {
          reconnectRequired: true,
          reason: "api_unauthorized",
          provider: "google",
          payload: details
        });
      }
      throw new ConnectorError("provider_error", `Google API failed (${response.status})`, details);
    }
    return response;
  }

  async function pollGmail(
    connection: ConnectorConnectionContext,
    input: GmailPollCursor,
    signal: AbortSignal
  ): Promise<{ activities: Omit<NormalizedActivity, "id">[]; cursor: GmailPollCursor }> {
    if (!input.historyId) {
      const profile = await api(
        connection,
        "https://gmail.googleapis.com/gmail/v1/users/me/profile",
        { signal }
      ).then((response) => safeJsonBounded(response, GOOGLE_POLL_RESPONSE_BYTES));
      const historyId = requiredString(profile, "historyId", "Gmail profile did not include a history ID");
      return { activities: [], cursor: { historyId, pendingChanges: [] } };
    }

    if (input.reconciliationHistoryId) {
      return reconcileGmailPage(connection, input, signal);
    }

    let historyId = input.historyId;
    let pageToken = input.pageToken;
    let pendingHistoryId = input.pendingHistoryId;
    let pendingChanges = [...input.pendingChanges];
    let pagesFetched = 0;
    const activities: Omit<NormalizedActivity, "id">[] = [];

    while (activities.length < GOOGLE_MAX_GMAIL_CHANGES) {
      if (pendingChanges.length > 0) {
        const batch = pendingChanges.splice(0, GOOGLE_MAX_GMAIL_CHANGES - activities.length);
        activities.push(...(await hydrateGmailChanges(connection, batch, signal)));
        if (pendingChanges.length > 0) break;
        if (!pageToken && pendingHistoryId) {
          historyId = pendingHistoryId;
          pendingHistoryId = undefined;
          break;
        }
        continue;
      }

      if (pagesFetched >= GOOGLE_MAX_POLL_PAGES) break;
      const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/history");
      url.searchParams.set("startHistoryId", historyId);
      url.searchParams.set("maxResults", String(GOOGLE_POLL_PAGE_SIZE));
      for (const historyType of ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"]) {
        url.searchParams.append("historyTypes", historyType);
      }
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const response = await api(connection, url.toString(), { signal }, [404]);
      if (response.status === 404) {
        const profile = await api(
          connection,
          "https://gmail.googleapis.com/gmail/v1/users/me/profile",
          { signal }
        ).then((candidate) => safeJsonBounded(candidate, GOOGLE_POLL_RESPONSE_BYTES));
        return reconcileGmailPage(connection, {
          historyId,
          reconciliationHistoryId: requiredString(profile, "historyId", "Gmail profile did not include a history ID"),
          pendingChanges: []
        }, signal);
      }
      const payload = await safeJsonBounded(response, GOOGLE_POLL_RESPONSE_BYTES);
      pagesFetched += 1;
      pendingChanges = extractGmailChangeRefs(payload);
      if (pendingChanges.length > GOOGLE_MAX_GMAIL_PENDING) {
        throw new ConnectorError(
          "payload_too_large",
          `A Gmail history page contains more than ${GOOGLE_MAX_GMAIL_PENDING} message changes`
        );
      }
      pageToken = readString(payload, "nextPageToken") ?? undefined;
      pendingHistoryId = readString(payload, "historyId") ?? historyId;
      if (pendingChanges.length === 0 && !pageToken) {
        historyId = pendingHistoryId;
        pendingHistoryId = undefined;
        break;
      }
    }

    return {
      activities,
      cursor: GmailPollCursorSchema.parse({
        historyId,
        ...(pageToken ? { pageToken } : {}),
        ...(pendingHistoryId ? { pendingHistoryId } : {}),
        pendingChanges
      })
    };
  }

  async function reconcileGmailPage(
    connection: ConnectorConnectionContext,
    input: GmailPollCursor,
    signal: AbortSignal
  ): Promise<{ activities: Omit<NormalizedActivity, "id">[]; cursor: GmailPollCursor }> {
    const reconciliationHistoryId = requiredString(
      input,
      "reconciliationHistoryId",
      "Gmail reconciliation is missing its target history ID"
    );
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    url.searchParams.set("maxResults", String(GOOGLE_MAX_GMAIL_CHANGES));
    url.searchParams.set("includeSpamTrash", "true");
    url.searchParams.set("fields", "messages(id,threadId),nextPageToken,resultSizeEstimate");
    if (input.reconciliationPageToken) {
      url.searchParams.set("pageToken", input.reconciliationPageToken);
    }
    const payload = await api(connection, url.toString(), { signal }).then((response) =>
      safeJsonBounded(response, GOOGLE_POLL_RESPONSE_BYTES)
    );
    const changes = recordArray(payload, "messages").slice(0, GOOGLE_MAX_GMAIL_CHANGES).flatMap((message) => {
      const messageId = readString(message, "id");
      if (!messageId) return [];
      return [GmailChangeRefSchema.parse({
        historyId: `reconcile:${reconciliationHistoryId}`,
        kind: "added",
        messageId,
        ...(readString(message, "threadId") ? { threadId: readString(message, "threadId") } : {}),
        labelIds: []
      })];
    });
    const activities = await hydrateGmailChanges(connection, changes, signal);
    const nextPageToken = readString(payload, "nextPageToken") ?? undefined;
    return {
      activities,
      cursor: nextPageToken
        ? {
            historyId: input.historyId,
            reconciliationHistoryId,
            reconciliationPageToken: nextPageToken,
            pendingChanges: []
          }
        : { historyId: reconciliationHistoryId, pendingChanges: [] }
    };
  }

  async function hydrateGmailChanges(
    connection: ConnectorConnectionContext,
    changes: GmailChangeRef[],
    signal: AbortSignal
  ): Promise<Omit<NormalizedActivity, "id">[]> {
    return mapWithConcurrency(changes, 5, async (change) => {
      let message: Record<string, unknown> = {
        id: change.messageId,
        ...(change.threadId ? { threadId: change.threadId } : {})
      };
      if (change.kind !== "deleted") {
        const url = new URL(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(change.messageId)}`
        );
        url.searchParams.set("format", "metadata");
        for (const header of ["From", "Subject", "Date"]) url.searchParams.append("metadataHeaders", header);
        url.searchParams.set(
          "fields",
          "id,threadId,labelIds,snippet,historyId,internalDate,payload(headers)"
        );
        const response = await api(connection, url.toString(), { signal }, [404]);
        if (response.ok) message = await safeJsonBounded(response, GOOGLE_POLL_RESPONSE_BYTES);
      }
      return normalizeGmailActivity(connection, change, message);
    });
  }

  async function pollCalendarChanges(
    connection: ConnectorConnectionContext,
    input: CalendarPollCursor,
    signal: AbortSignal
  ): Promise<{ activities: Omit<NormalizedActivity, "id">[]; cursor: CalendarPollCursor }> {
    const calendarId = googleCalendarId(connection);
    if (!input.syncToken) {
      let pageToken = input.pageToken;
      for (let page = 0; page < GOOGLE_MAX_POLL_PAGES; page += 1) {
        const url = calendarEventsUrl(calendarId, undefined, pageToken);
        const payload = await api(connection, url.toString(), { signal }).then((response) =>
          safeJsonBounded(response, GOOGLE_POLL_RESPONSE_BYTES)
        );
        pageToken = readString(payload, "nextPageToken") ?? undefined;
        if (!pageToken) {
          const syncToken = requiredString(
            payload,
            "nextSyncToken",
            "Google Calendar baseline did not include a sync token"
          );
          return { activities: [], cursor: { syncToken } };
        }
      }
      return { activities: [], cursor: { pageToken, baselining: true } };
    }

    const activities: Omit<NormalizedActivity, "id">[] = [];
    let pageToken = input.pageToken;
    for (let page = 0; page < GOOGLE_MAX_POLL_PAGES; page += 1) {
      const url = calendarEventsUrl(calendarId, input.syncToken, pageToken);
      const response = await api(connection, url.toString(), { signal }, [410]);
      if (response.status === 410) {
        return pollCalendarChanges(connection, { baselining: true }, signal);
      }
      const payload = await safeJsonBounded(response, GOOGLE_POLL_RESPONSE_BYTES);
      for (const event of recordArray(payload, "items")) {
        const activity = normalizeCalendarActivity(connection, calendarId, event);
        if (activity) activities.push(activity);
      }
      pageToken = readString(payload, "nextPageToken") ?? undefined;
      if (!pageToken) {
        const syncToken = requiredString(
          payload,
          "nextSyncToken",
          "Google Calendar incremental response did not include a sync token"
        );
        return { activities, cursor: { syncToken } };
      }
    }
    return { activities, cursor: { syncToken: input.syncToken, pageToken } };
  }

  async function pollCalendar(
    connection: ConnectorConnectionContext,
    input: CalendarPollCursor,
    signal: AbortSignal
  ): Promise<{ activities: Omit<NormalizedActivity, "id">[]; cursor: CalendarPollCursor }> {
    const changes = await pollCalendarChanges(connection, input, signal);
    const completions = await pollCalendarCompletions(connection, input, signal);
    return {
      activities: [...changes.activities, ...completions.activities],
      cursor: CalendarPollCursorSchema.parse({
        ...changes.cursor,
        ...completions.cursor
      })
    };
  }

  async function pollCalendarCompletions(
    connection: ConnectorConnectionContext,
    input: CalendarPollCursor,
    signal: AbortSignal
  ): Promise<{
    activities: Omit<NormalizedActivity, "id">[];
    cursor: Pick<CalendarPollCursor, "completionCheckedAt" | "completionUntil" | "completionPageToken">;
  }> {
    const now = new Date().toISOString();
    if (!input.completionCheckedAt) {
      return { activities: [], cursor: { completionCheckedAt: now } };
    }
    const calendarId = googleCalendarId(connection);
    const completionUntil = input.completionUntil ?? now;
    let pageToken = input.completionPageToken;
    const activities: Omit<NormalizedActivity, "id">[] = [];
    for (let page = 0; page < GOOGLE_MAX_POLL_PAGES; page += 1) {
      const url = new URL(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`
      );
      url.searchParams.set("timeMin", input.completionCheckedAt);
      url.searchParams.set("timeMax", completionUntil);
      url.searchParams.set("singleEvents", "true");
      url.searchParams.set("showDeleted", "false");
      url.searchParams.set("orderBy", "startTime");
      url.searchParams.set("maxResults", String(GOOGLE_POLL_PAGE_SIZE));
      url.searchParams.set(
        "fields",
        "nextPageToken,items(id,status,summary,updated,location,organizer,start,end,recurringEventId,eventType)"
      );
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const payload = await api(connection, url.toString(), { signal }).then((response) =>
        safeJsonBounded(response, GOOGLE_POLL_RESPONSE_BYTES)
      );
      for (const event of recordArray(payload, "items")) {
        const activity = normalizeCalendarCompletionActivity(
          connection,
          calendarId,
          event,
          input.completionCheckedAt,
          completionUntil
        );
        if (activity) activities.push(activity);
      }
      pageToken = readString(payload, "nextPageToken") ?? undefined;
      if (!pageToken) {
        return { activities, cursor: { completionCheckedAt: completionUntil } };
      }
    }
    return {
      activities,
      cursor: {
        completionCheckedAt: input.completionCheckedAt,
        completionUntil,
        completionPageToken: pageToken
      }
    };
  }

  async function pollDrive(
    connection: ConnectorConnectionContext,
    input: DrivePollCursor,
    signal: AbortSignal
  ): Promise<{ activities: Omit<NormalizedActivity, "id">[]; cursor: DrivePollCursor }> {
    if (!input.pageToken) {
      const url = new URL("https://www.googleapis.com/drive/v3/changes/startPageToken");
      url.searchParams.set("supportsAllDrives", "true");
      const payload = await api(connection, url.toString(), { signal }).then((response) =>
        safeJsonBounded(response, GOOGLE_POLL_RESPONSE_BYTES)
      );
      return {
        activities: [],
        cursor: {
          pageToken: requiredString(payload, "startPageToken", "Google Drive did not include a start page token")
        }
      };
    }

    let pageToken = input.pageToken;
    const activities: Omit<NormalizedActivity, "id">[] = [];
    for (let page = 0; page < GOOGLE_MAX_POLL_PAGES; page += 1) {
      const url = new URL("https://www.googleapis.com/drive/v3/changes");
      url.searchParams.set("pageToken", pageToken);
      url.searchParams.set("pageSize", String(GOOGLE_POLL_PAGE_SIZE));
      url.searchParams.set("includeRemoved", "true");
      url.searchParams.set("supportsAllDrives", "true");
      url.searchParams.set("includeItemsFromAllDrives", "true");
      url.searchParams.set(
        "fields",
        "nextPageToken,newStartPageToken,changes(fileId,removed,time,changeType,driveId,file(id,name,mimeType,modifiedTime,createdTime,webViewLink,trashed,owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress),size,md5Checksum,parents))"
      );
      const payload = await api(connection, url.toString(), { signal }).then((response) =>
        safeJsonBounded(response, GOOGLE_POLL_RESPONSE_BYTES)
      );
      for (const change of recordArray(payload, "changes")) {
        const activity = normalizeDriveActivity(connection, change);
        if (activity) activities.push(activity);
      }
      const nextPageToken = readString(payload, "nextPageToken");
      if (nextPageToken) {
        pageToken = nextPageToken;
        continue;
      }
      return {
        activities,
        cursor: {
          pageToken: requiredString(
            payload,
            "newStartPageToken",
            "Google Drive change response did not include a new start page token"
          )
        }
      };
    }
    return { activities, cursor: { pageToken, continuing: true } };
  }

  return {
    manifest: {
      type: "google",
      displayName: "Google",
      supportedScopes: ["personal", "workspace"],
      oauthRequired: true,
      activityTypes: [
        "email.received",
        "email.updated",
        "calendar.event_changed",
        "calendar.event_completed",
        "drive.file_changed",
        "docs.document_changed",
        "sheets.spreadsheet_changed"
      ],
      resourceTypes: ["gmail_thread", "calendar_event", "drive_file", "google_doc", "google_sheet"],
      tools: googleTools,
      supportsWatches: true,
      supportsPolling: true,
      supportsWebhooks: false
    },

    async beginAuthorization(input) {
      const state = z.string().min(20).parse(input.state);
      const codeChallenge = z.string().min(20).parse(input.codeChallenge);
      const scopes = z.array(z.string()).min(1).parse(input.scopes);
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("redirect_uri", config.redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", scopes.join(" "));
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("include_granted_scopes", "true");
      url.searchParams.set("prompt", "consent");
      return { url: url.toString() };
    },

    async handleAuthorizationCallback(input) {
      const code = z.string().min(1).parse(input.code);
      const codeVerifier = z.string().min(20).parse(input.codeVerifier);
      const response = await fetcher("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: config.redirectUri,
          grant_type: "authorization_code",
          code_verifier: codeVerifier
        })
      });
      const payload = await safeJsonBounded(response, 256_000);
      if (!response.ok) throw new ConnectorError("provider_error", "Google token exchange failed", payload);
      const credentials = normalizeGoogleToken(payload);
      const identityResponse = await fetcher("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { Authorization: `Bearer ${String(credentials.accessToken)}` }
      });
      const identity = await safeJsonBounded(identityResponse, 256_000);
      if (!identityResponse.ok) {
        throw new ConnectorError("provider_error", "Google account identity lookup failed", identity);
      }
      return {
        ...credentials,
        providerAccountId: requiredString(identity, "sub", "Google account identity did not include a subject"),
        providerAccountEmail: readString(identity, "email"),
        providerAccountName: readString(identity, "name")
      };
    },

    async refreshCredentials(connection, signal) {
      return refreshGoogleCredentials(connection, signal);
    },

    async revoke(connection, signal) {
      const token = String(connection.credentials.refreshToken ?? connection.credentials.accessToken ?? "");
      if (!token) return;
      const response = await fetcher("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
        signal
      });
      if (!response.ok) {
        throw new ConnectorError("provider_error", `Google token revocation failed (${response.status})`);
      }
    },

    async poll(connection, signal) {
      const previous = parseGooglePollCursor(connection.cursor);
      const cursor: GooglePollCursor = { ...previous };
      const activities: Omit<NormalizedActivity, "id">[] = [];

      if (connection.grantedScopes.includes("gmail.read")) {
        const result = await pollGmail(
          connection,
          GmailPollCursorSchema.parse(previous.gmail ?? {}),
          signal
        );
        activities.push(...result.activities);
        cursor.gmail = result.cursor;
      }
      if (connection.grantedScopes.includes("calendar.read")) {
        const result = await pollCalendar(
          connection,
          CalendarPollCursorSchema.parse(previous.calendar ?? {}),
          signal
        );
        activities.push(...result.activities);
        cursor.calendar = result.cursor;
      }
      if (connection.grantedScopes.includes("drive.read")) {
        const result = await pollDrive(
          connection,
          DrivePollCursorSchema.parse(previous.drive ?? {}),
          signal
        );
        activities.push(...result.activities);
        cursor.drive = result.cursor;
      }

      const intervalSeconds = z
        .number()
        .int()
        .min(60)
        .max(86_400)
        .parse(connection.config.pollIntervalSeconds ?? 300);
      const nextDelaySeconds = googleCursorHasBacklog(cursor) ? 5 : intervalSeconds;
      return {
        activities,
        cursor,
        nextPollAt: new Date(Date.now() + nextDelaySeconds * 1000).toISOString()
      };
    },

    async hydrateResource(connection, resource, signal) {
      const resourceType = googleResourceField(resource, "resourceType", "resource_type");
      const providerResourceId = googleResourceField(resource, "providerResourceId", "provider_resource_id");
      if (!resourceType || !providerResourceId) {
        throw new ConnectorError("invalid_configuration", "Google resource type and provider ID are required");
      }

      if (resourceType === "gmail_thread") {
        assertGoogleCapability(connection, "gmail.read");
        const url = new URL(
          `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(providerResourceId)}`
        );
        url.searchParams.set("format", "metadata");
        for (const header of ["From", "To", "Cc", "Subject", "Date"]) {
          url.searchParams.append("metadataHeaders", header);
        }
        url.searchParams.set(
          "fields",
          "id,historyId,messages(id,threadId,labelIds,snippet,historyId,internalDate,payload(headers))"
        );
        const payload = await api(connection, url.toString(), { signal }).then((response) =>
          safeJsonBounded(response, GOOGLE_HYDRATION_RESPONSE_BYTES)
        );
        return sanitizeGmailThread(payload);
      }

      if (resourceType === "calendar_event") {
        assertGoogleCapability(connection, "calendar.read");
        const calendarId = googleCalendarId(connection);
        const url = new URL(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(providerResourceId)}`
        );
        url.searchParams.set("maxAttendees", "50");
        url.searchParams.set(
          "fields",
          "id,iCalUID,status,htmlLink,created,updated,summary,description,location,creator,organizer,start,end,recurrence,recurringEventId,originalStartTime,attendees(displayName,email,responseStatus,self,organizer),attachments(fileUrl,title,mimeType,fileId),visibility,transparency,eventType"
        );
        const payload = await api(connection, url.toString(), { signal }).then((response) =>
          safeJsonBounded(response, GOOGLE_HYDRATION_RESPONSE_BYTES)
        );
        return sanitizeCalendarEvent(payload, calendarId);
      }

      if (resourceType === "google_doc") {
        if (connection.grantedScopes.includes("docs.read") || connection.grantedScopes.includes("docs.write")) {
          const payload = await readGoogleDocument(api, connection, providerResourceId, signal);
          return sanitizeGoogleDocument(payload);
        }
        assertGoogleCapability(connection, "drive.read");
        const metadata = await api(connection, googleDriveMetadataUrl(providerResourceId).toString(), { signal })
          .then((response) => safeJsonBounded(response, GOOGLE_HYDRATION_RESPONSE_BYTES));
        return {
          ...sanitizeDriveFile(metadata),
          ...await readDriveTextContent(api, connection, providerResourceId, metadata, signal, GOOGLE_MAX_HYDRATED_TEXT_BYTES)
        };
      }

      if (resourceType === "google_sheet") {
        if (connection.grantedScopes.includes("sheets.read") || connection.grantedScopes.includes("sheets.write")) {
          const payload = await readGoogleSpreadsheet(api, connection, providerResourceId, signal);
          return sanitizeGoogleSpreadsheet(payload);
        }
        assertGoogleCapability(connection, "drive.read");
        const metadata = await api(connection, googleDriveMetadataUrl(providerResourceId).toString(), { signal })
          .then((response) => safeJsonBounded(response, GOOGLE_HYDRATION_RESPONSE_BYTES));
        return {
          ...sanitizeDriveFile(metadata),
          ...await readDriveTextContent(api, connection, providerResourceId, metadata, signal, GOOGLE_MAX_HYDRATED_TEXT_BYTES)
        };
      }

      if (resourceType === "drive_file") {
        assertGoogleCapability(connection, "drive.read");
        const url = new URL(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(providerResourceId)}`
        );
        url.searchParams.set("supportsAllDrives", "true");
        url.searchParams.set(
          "fields",
          "id,name,mimeType,modifiedTime,createdTime,webViewLink,trashed,owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress),size,md5Checksum,parents,description"
        );
        const payload = await api(connection, url.toString(), { signal }).then((response) =>
          safeJsonBounded(response, GOOGLE_HYDRATION_RESPONSE_BYTES)
        );
        const hydrated = sanitizeDriveFile(payload);
        const mimeType = readString(payload, "mimeType") ?? "application/octet-stream";
        const declaredSize = Number(readString(payload, "size") ?? Number.NaN);
        let textContent: string | null = null;
        let contentOmittedReason: string | null = "Unsupported or potentially large file type";

        if (mimeType === "application/vnd.google-apps.document") {
          const exportUrl = new URL(
            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(providerResourceId)}/export`
          );
          exportUrl.searchParams.set("mimeType", "text/plain");
          const response = await api(connection, exportUrl.toString(), { signal });
          textContent = new TextDecoder().decode(
            await readBounded(response, GOOGLE_MAX_HYDRATED_TEXT_BYTES)
          );
          contentOmittedReason = null;
        } else if (isTextLikeMimeType(mimeType) && (!Number.isFinite(declaredSize) || declaredSize <= GOOGLE_MAX_HYDRATED_TEXT_BYTES)) {
          const downloadUrl = new URL(
            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(providerResourceId)}`
          );
          downloadUrl.searchParams.set("alt", "media");
          downloadUrl.searchParams.set("supportsAllDrives", "true");
          const response = await api(connection, downloadUrl.toString(), { signal });
          textContent = new TextDecoder().decode(
            await readBounded(response, GOOGLE_MAX_HYDRATED_TEXT_BYTES)
          );
          contentOmittedReason = null;
        }
        return {
          ...hydrated,
          textContent,
          contentTruncated: false,
          ...(contentOmittedReason ? { contentOmittedReason } : {})
        };
      }

      throw new ConnectorError("unsupported_capability", `Unsupported Google resource type: ${resourceType}`);
    },

    async executeTool(name, rawArgs, context) {
      assertPrincipalAccess(context.connection, context.principal);
      const tool = googleTools.find((candidate) => candidate.name === name);
      if (!tool || !context.connection.grantedScopes.includes(tool.capability)) {
        throw new ConnectorError("unsupported_capability", `Connection has not granted ${tool?.capability ?? name}`);
      }
      if (name === "google.gmail.search") {
        const args = z.object({ query: z.string().max(2_000), maxResults: z.number().int().min(1).max(25).default(10) }).parse(rawArgs);
        const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
        url.searchParams.set("q", args.query);
        url.searchParams.set("maxResults", String(args.maxResults));
        url.searchParams.set("fields", "messages(id,threadId),nextPageToken,resultSizeEstimate");
        const payload = await api(context.connection, url.toString(), { signal: context.signal }).then((response) =>
          safeJsonBounded(response, GOOGLE_TOOL_RESPONSE_BYTES)
        );
        const messages = recordArray(payload, "messages").slice(0, args.maxResults).map((message) => ({
          id: readString(message, "id"),
          threadId: readString(message, "threadId")
        }));
        return {
          output: boundedToolOutput({
            messages,
            nextPageToken: readString(payload, "nextPageToken"),
            resultSizeEstimate: readNumber(payload, "resultSizeEstimate")
          }),
          summary: `Found ${messages.length} Gmail messages`
        };
      }
      if (name === "google.gmail.read_thread") {
        const args = z.object({ threadId: z.string().min(1).max(500) }).parse(rawArgs);
        const url = new URL(
          `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(args.threadId)}`
        );
        url.searchParams.set("format", "full");
        url.searchParams.set(
          "fields",
          "id,historyId,messages(id,threadId,labelIds,snippet,historyId,internalDate,payload(mimeType,filename,headers,body,parts))"
        );
        const payload = await api(context.connection, url.toString(), { signal: context.signal }).then((response) =>
          safeJsonBounded(response, GOOGLE_TOOL_RESPONSE_BYTES)
        );
        return {
          output: boundedToolOutput(sanitizeGmailThreadForTool(payload)),
          summary: "Read bounded Gmail thread content",
          providerOperationId: args.threadId
        };
      }
      if (name === "google.gmail.read_message") {
        const args = z.object({ messageId: z.string().min(1).max(500) }).parse(rawArgs);
        const url = new URL(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(args.messageId)}`
        );
        url.searchParams.set("format", "full");
        url.searchParams.set(
          "fields",
          "id,threadId,labelIds,snippet,historyId,internalDate,payload(mimeType,filename,headers,body,parts)"
        );
        const payload = await api(context.connection, url.toString(), { signal: context.signal }).then((response) =>
          safeJsonBounded(response, GOOGLE_TOOL_RESPONSE_BYTES)
        );
        return {
          output: boundedToolOutput(sanitizeGmailMessageForTool(payload, GOOGLE_TOOL_TEXT_BYTES)),
          summary: "Read bounded Gmail message content",
          providerOperationId: args.messageId
        };
      }
      if (name === "google.gmail.create_draft" || name === "google.gmail.send") {
        const args = EmailArgsSchema.parse(rawArgs);
        const raw = base64Url(serializeEmail(args));
        const isDraft = name.endsWith("create_draft");
        const endpoint = isDraft ? "drafts" : "messages/send";
        const body = isDraft
          ? { message: { raw, ...(args.threadId ? { threadId: args.threadId } : {}) } }
          : { raw, ...(args.threadId ? { threadId: args.threadId } : {}) };
        const payload = await api(
          context.connection,
          `https://gmail.googleapis.com/gmail/v1/users/me/${endpoint}`,
          { method: "POST", body: JSON.stringify(body), signal: context.signal }
        ).then((response) => safeJsonBounded(response, 256_000));
        const operationId = readString(payload, "id") ?? readNestedString(payload, "message", "id");
        return {
          output: boundedToolOutput({
            id: readString(payload, "id"),
            message: readRecord(payload, "message")
              ? {
                  id: readNestedString(payload, "message", "id"),
                  threadId: readNestedString(payload, "message", "threadId")
                }
              : null
          }),
          summary: isDraft ? `Created draft “${args.subject}”` : `Sent “${args.subject}”`,
          ...(operationId ? { providerOperationId: operationId } : {})
        };
      }
      if (name === "google.calendar.list_calendars") {
        const args = z.object({ maxResults: z.number().int().min(1).max(250).default(100) }).parse(rawArgs);
        const url = new URL("https://www.googleapis.com/calendar/v3/users/me/calendarList");
        url.searchParams.set("maxResults", String(args.maxResults));
        url.searchParams.set(
          "fields",
          "nextPageToken,items(id,summary,description,location,timeZone,summaryOverride,colorId,backgroundColor,foregroundColor,hidden,selected,primary,accessRole,deleted)"
        );
        const payload = await api(context.connection, url.toString(), { signal: context.signal }).then((response) =>
          safeJsonBounded(response, GOOGLE_TOOL_RESPONSE_BYTES)
        );
        const calendars = recordArray(payload, "items").slice(0, args.maxResults).map(sanitizeGoogleCalendar);
        return {
          output: boundedToolOutput({ calendars, nextPageToken: readString(payload, "nextPageToken") }),
          summary: `Found ${calendars.length} Google calendars`
        };
      }
      if (name === "google.calendar.list_events") {
        const args = z
          .object({
            calendarId: z.string().min(1).max(1_024).optional(),
            timeMin: z.string().datetime({ offset: true }),
            timeMax: z.string().datetime({ offset: true }),
            query: z.string().max(2_000).optional(),
            maxResults: z.number().int().min(1).max(100).default(25)
          })
          .parse(rawArgs);
        const calendarId = args.calendarId ?? googleCalendarId(context.connection);
        const url = new URL(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`
        );
        url.searchParams.set("timeMin", args.timeMin);
        url.searchParams.set("timeMax", args.timeMax);
        url.searchParams.set("maxResults", String(args.maxResults));
        url.searchParams.set("singleEvents", "true");
        url.searchParams.set("orderBy", "startTime");
        url.searchParams.set(
          "fields",
          "nextPageToken,items(id,iCalUID,status,htmlLink,created,updated,summary,description,location,creator,organizer,start,end,recurrence,recurringEventId,originalStartTime,attendees(displayName,email,responseStatus,self,organizer),attachments(fileUrl,title,mimeType,fileId),visibility,transparency,eventType)"
        );
        if (args.query) url.searchParams.set("q", args.query);
        const payload = await api(context.connection, url.toString(), { signal: context.signal }).then((response) =>
          safeJsonBounded(response, GOOGLE_TOOL_RESPONSE_BYTES)
        );
        const items = recordArray(payload, "items").slice(0, args.maxResults).map((event) =>
          sanitizeCalendarEvent(event, calendarId)
        );
        return {
          output: boundedToolOutput({ items, nextPageToken: readString(payload, "nextPageToken") }),
          summary: `Found ${items.length} calendar events`
        };
      }
      if (name === "google.calendar.read_event") {
        const args = z.object({
          calendarId: z.string().min(1).max(1_024).optional(),
          eventId: z.string().min(1).max(1024)
        }).parse(rawArgs);
        const calendarId = args.calendarId ?? googleCalendarId(context.connection);
        const url = new URL(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(args.eventId)}`
        );
        url.searchParams.set("maxAttendees", "50");
        url.searchParams.set(
          "fields",
          "id,iCalUID,status,htmlLink,created,updated,summary,description,location,creator,organizer,start,end,recurrence,recurringEventId,originalStartTime,attendees(displayName,email,responseStatus,self,organizer),attachments(fileUrl,title,mimeType,fileId),visibility,transparency,eventType"
        );
        const payload = await api(context.connection, url.toString(), { signal: context.signal }).then((response) =>
          safeJsonBounded(response, GOOGLE_TOOL_RESPONSE_BYTES)
        );
        return {
          output: boundedToolOutput(sanitizeCalendarEvent(payload, calendarId)),
          summary: "Read Google Calendar event",
          providerOperationId: args.eventId
        };
      }
      if (name === "google.calendar.create_event") {
        const args = CalendarEventCreateArgsSchema.parse(rawArgs);
        const calendarId = args.calendarId ?? googleCalendarId(context.connection);
        const url = new URL(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`
        );
        if (args.attendeeEmails.length > 0) url.searchParams.set("sendUpdates", "all");
        const event = calendarEventWriteBody(args);
        const payload = await api(context.connection, url.toString(), {
          method: "POST",
          body: JSON.stringify(event),
          signal: context.signal
        }).then((response) => safeJsonBounded(response, GOOGLE_TOOL_RESPONSE_BYTES));
        const eventId = requiredString(payload, "id", "Google Calendar did not return an event ID");
        return {
          output: boundedToolOutput(sanitizeCalendarEvent(payload, calendarId)),
          summary: `Created calendar event “${args.summary}”`,
          providerOperationId: eventId
        };
      }
      if (name === "google.calendar.update_event") {
        const args = CalendarEventUpdateArgsSchema.parse(rawArgs);
        const calendarId = args.calendarId ?? googleCalendarId(context.connection);
        const url = new URL(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(args.eventId)}`
        );
        if (args.attendeeEmails !== undefined) url.searchParams.set("sendUpdates", "all");
        const payload = await api(context.connection, url.toString(), {
          method: "PATCH",
          body: JSON.stringify(calendarEventWriteBody(args)),
          signal: context.signal
        }).then((response) => safeJsonBounded(response, GOOGLE_TOOL_RESPONSE_BYTES));
        return {
          output: boundedToolOutput(sanitizeCalendarEvent(payload, calendarId)),
          summary: `Updated calendar event “${readString(payload, "summary") ?? args.eventId}”`,
          providerOperationId: args.eventId
        };
      }
      if (name === "google.docs.read_document") {
        const args = z.object({ documentId: z.string().min(1).max(500) }).parse(rawArgs);
        const payload = await readGoogleDocument(
          api,
          context.connection,
          args.documentId,
          context.signal
        );
        return {
          output: boundedToolOutput(sanitizeGoogleDocument(payload)),
          summary: "Read bounded Google Doc content",
          providerOperationId: args.documentId
        };
      }
      if (name === "google.docs.create_document") {
        const args = z.object({
          title: z.string().min(1).max(500),
          text: z.string().max(100_000).optional()
        }).parse(rawArgs);
        const created = await api(context.connection, "https://docs.googleapis.com/v1/documents", {
          method: "POST",
          body: JSON.stringify({ title: args.title }),
          signal: context.signal
        }).then((response) => safeJsonBounded(response, GOOGLE_TOOL_RESPONSE_BYTES));
        const documentId = requiredString(created, "documentId", "Google Docs did not return a document ID");
        if (args.text) {
          await updateGoogleDocument(api, context.connection, documentId, [{
            insertText: { endOfSegmentLocation: { segmentId: "" }, text: args.text }
          }], context.signal);
        }
        return {
          output: boundedToolOutput({
            resourceType: "google_doc",
            documentId,
            title: readString(created, "title") ?? args.title,
            url: `https://docs.google.com/document/d/${encodeURIComponent(documentId)}/edit`,
            initialTextCharacters: args.text?.length ?? 0
          }),
          summary: `Created Google Doc “${args.title}”`,
          providerOperationId: documentId
        };
      }
      if (name === "google.docs.append_text") {
        const args = z.object({
          documentId: z.string().min(1).max(500),
          text: z.string().min(1).max(100_000)
        }).parse(rawArgs);
        const payload = await updateGoogleDocument(api, context.connection, args.documentId, [{
          insertText: { endOfSegmentLocation: { segmentId: "" }, text: args.text }
        }], context.signal);
        return {
          output: boundedToolOutput({
            documentId: args.documentId,
            charactersAppended: args.text.length,
            revisionId: readNestedString(payload, "writeControl", "requiredRevisionId")
          }),
          summary: `Appended ${args.text.length} characters to Google Doc`,
          providerOperationId: args.documentId
        };
      }
      if (name === "google.docs.replace_text") {
        const args = z.object({
          documentId: z.string().min(1).max(500),
          find: z.string().min(1).max(10_000),
          replace: z.string().max(100_000),
          matchCase: z.boolean().default(true)
        }).parse(rawArgs);
        const payload = await updateGoogleDocument(api, context.connection, args.documentId, [{
          replaceAllText: {
            containsText: { text: args.find, matchCase: args.matchCase },
            replaceText: args.replace
          }
        }], context.signal);
        const occurrencesChanged = recordArray(payload, "replies").reduce(
          (total, reply) => total + (readNestedNumber(reply, "replaceAllText", "occurrencesChanged") ?? 0),
          0
        );
        return {
          output: boundedToolOutput({ documentId: args.documentId, occurrencesChanged }),
          summary: `Replaced ${occurrencesChanged} occurrence${occurrencesChanged === 1 ? "" : "s"} in Google Doc`,
          providerOperationId: args.documentId
        };
      }
      if (name === "google.sheets.read_spreadsheet") {
        const args = z.object({ spreadsheetId: z.string().min(1).max(500) }).parse(rawArgs);
        const payload = await readGoogleSpreadsheet(
          api,
          context.connection,
          args.spreadsheetId,
          context.signal
        );
        return {
          output: boundedToolOutput(sanitizeGoogleSpreadsheet(payload)),
          summary: "Read Google Sheets metadata",
          providerOperationId: args.spreadsheetId
        };
      }
      if (name === "google.sheets.read_values") {
        const args = z.object({
          spreadsheetId: z.string().min(1).max(500),
          range: z.string().min(1).max(1_000),
          majorDimension: z.enum(["ROWS", "COLUMNS"]).default("ROWS")
        }).parse(rawArgs);
        const url = new URL(
          `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(args.spreadsheetId)}/values/${encodeURIComponent(args.range)}`
        );
        url.searchParams.set("majorDimension", args.majorDimension);
        url.searchParams.set("valueRenderOption", "FORMATTED_VALUE");
        url.searchParams.set("dateTimeRenderOption", "FORMATTED_STRING");
        const payload = await api(context.connection, url.toString(), { signal: context.signal }).then((response) =>
          safeJsonBounded(response, GOOGLE_TOOL_RESPONSE_BYTES)
        );
        return {
          output: boundedToolOutput(sanitizeGoogleSheetValues(payload)),
          summary: `Read Google Sheets range ${args.range}`,
          providerOperationId: args.spreadsheetId
        };
      }
      if (name === "google.sheets.create_spreadsheet") {
        const args = z.object({
          title: z.string().min(1).max(500),
          sheetTitles: z.array(z.string().min(1).max(100)).max(25).default([])
        }).parse(rawArgs);
        if (new Set(args.sheetTitles).size !== args.sheetTitles.length) {
          throw new ConnectorError("invalid_configuration", "Google Sheet titles must be unique");
        }
        const payload = await api(context.connection, "https://sheets.googleapis.com/v4/spreadsheets", {
          method: "POST",
          body: JSON.stringify({
            properties: { title: args.title },
            ...(args.sheetTitles.length > 0
              ? { sheets: args.sheetTitles.map((title) => ({ properties: { title } })) }
              : {})
          }),
          signal: context.signal
        }).then((response) => safeJsonBounded(response, GOOGLE_TOOL_RESPONSE_BYTES));
        const spreadsheetId = requiredString(payload, "spreadsheetId", "Google Sheets did not return a spreadsheet ID");
        return {
          output: boundedToolOutput(sanitizeGoogleSpreadsheet(payload)),
          summary: `Created Google spreadsheet “${args.title}”`,
          providerOperationId: spreadsheetId
        };
      }
      if (name === "google.sheets.update_values" || name === "google.sheets.append_values") {
        const args = SheetValuesWriteArgsSchema.parse(rawArgs);
        const append = name === "google.sheets.append_values";
        const action = append ? "append" : "update";
        const url = new URL(
          `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(args.spreadsheetId)}/values/${encodeURIComponent(args.range)}:${action}`
        );
        url.searchParams.set("valueInputOption", args.valueInputOption);
        if (append) url.searchParams.set("insertDataOption", args.insertDataOption ?? "INSERT_ROWS");
        const payload = await api(context.connection, url.toString(), {
          method: append ? "POST" : "PUT",
          body: JSON.stringify({ range: args.range, majorDimension: "ROWS", values: args.values }),
          signal: context.signal
        }).then((response) => safeJsonBounded(response, GOOGLE_TOOL_RESPONSE_BYTES));
        return {
          output: boundedToolOutput(sanitizeGoogleSheetWriteResponse(payload)),
          summary: `${append ? "Appended" : "Updated"} ${args.values.length} row${args.values.length === 1 ? "" : "s"} in Google Sheets`,
          providerOperationId: args.spreadsheetId
        };
      }
      if (name === "google.drive.search") {
        const args = z.object({ query: z.string().max(1_000), maxResults: z.number().int().min(1).max(100).default(25) }).parse(rawArgs);
        const url = new URL("https://www.googleapis.com/drive/v3/files");
        url.searchParams.set("q", `name contains '${escapeDriveQuery(args.query)}' and trashed = false`);
        url.searchParams.set("pageSize", String(args.maxResults));
        url.searchParams.set("fields", "nextPageToken,files(id,name,mimeType,modifiedTime,createdTime,webViewLink,trashed,owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress),size,md5Checksum,parents)");
        const payload = await api(context.connection, url.toString(), { signal: context.signal }).then((response) =>
          safeJsonBounded(response, GOOGLE_TOOL_RESPONSE_BYTES)
        );
        const files = recordArray(payload, "files").slice(0, args.maxResults).map(sanitizeDriveFile);
        return {
          output: boundedToolOutput({ files, nextPageToken: readString(payload, "nextPageToken") }),
          summary: `Found ${files.length} Drive files`
        };
      }
      if (name === "google.drive.get_metadata" || name === "google.drive.download") {
        const args = z.object({ fileId: z.string().min(1).max(500) }).parse(rawArgs);
        const metadataUrl = googleDriveMetadataUrl(args.fileId);
        const payload = await api(context.connection, metadataUrl.toString(), { signal: context.signal }).then((response) =>
          safeJsonBounded(response, GOOGLE_TOOL_RESPONSE_BYTES)
        );
        const metadata = sanitizeDriveFile(payload);
        if (name === "google.drive.get_metadata") {
          return {
            output: boundedToolOutput(metadata),
            summary: "Read Google Drive file metadata",
            providerOperationId: args.fileId
          };
        }
        const content = await readDriveTextContent(api, context.connection, args.fileId, payload, context.signal, GOOGLE_TOOL_TEXT_BYTES);
        return {
          output: boundedToolOutput({ ...metadata, ...content }),
          summary: content.textContent == null ? "Read Drive metadata; binary or large content was omitted" : "Read bounded Drive text content",
          providerOperationId: args.fileId
        };
      }
      if (name === "google.drive.export") {
        const args = z.object({ fileId: z.string().min(1).max(500), mimeType: z.enum(["text/plain", "application/pdf"]) }).parse(rawArgs);
        if (args.mimeType === "application/pdf") {
          return {
            output: {
              fileId: args.fileId,
              mimeType: args.mimeType,
              contentIncluded: false,
              reason: "Binary PDF data is not exposed to the model; attach or download it through an authorized resource flow"
            },
            summary: "PDF export omitted from model context for safety",
            providerOperationId: args.fileId
          };
        }
        const response = await api(
          context.connection,
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(args.fileId)}/export?mimeType=${encodeURIComponent(args.mimeType)}`,
          { signal: context.signal }
        );
        const bytes = await readBounded(response, GOOGLE_TOOL_TEXT_BYTES);
        const text = new TextDecoder().decode(bytes);
        return {
          output: boundedToolOutput({ text, mimeType: args.mimeType, bytes: bytes.byteLength }),
          summary: `Exported ${text.length} characters`,
          providerOperationId: args.fileId
        };
      }
      throw new ConnectorError("unsupported_capability", `Unsupported Google tool: ${name}`);
    },

    async healthCheck(connection) {
      if (!connection) return { ok: true, message: "Google adapter is configured" };
      if (!connection.credentials.accessToken && !connection.credentials.refreshToken) {
        throw new ConnectorError("unauthorized", "Google connection needs reconnecting", {
          reconnectRequired: true,
          reason: "missing_credentials",
          provider: "google"
        });
      }
      await api(connection, "https://openidconnect.googleapis.com/v1/userinfo", {
        signal: AbortSignal.timeout(15_000)
      }).then((response) => safeJsonBounded(response, 256_000));
      return { ok: true, message: "Google account access is healthy" };
    }
  };
}

function parseGooglePollCursor(value: Record<string, unknown>): GooglePollCursor {
  const cursor = z.record(z.string(), z.unknown()).parse(value) as GooglePollCursor;
  return {
    ...cursor,
    ...(cursor.gmail ? { gmail: GmailPollCursorSchema.parse(cursor.gmail) } : {}),
    ...(cursor.calendar ? { calendar: CalendarPollCursorSchema.parse(cursor.calendar) } : {}),
    ...(cursor.drive ? { drive: DrivePollCursorSchema.parse(cursor.drive) } : {})
  };
}

function googleCursorHasBacklog(cursor: GooglePollCursor): boolean {
  return Boolean(
    cursor.gmail?.pageToken ||
      cursor.gmail?.pendingHistoryId ||
      cursor.gmail?.reconciliationHistoryId ||
      cursor.gmail?.reconciliationPageToken ||
      (cursor.gmail?.pendingChanges.length ?? 0) > 0 ||
      cursor.calendar?.pageToken ||
      cursor.calendar?.baselining ||
      cursor.calendar?.completionPageToken ||
      cursor.drive?.continuing
  );
}

function extractGmailChangeRefs(payload: Record<string, unknown>): GmailChangeRef[] {
  const changes = new Map<string, GmailChangeRef>();
  for (const history of recordArray(payload, "history")) {
    const historyId = readString(history, "id");
    if (!historyId) continue;
    const groups = [
      ["messagesAdded", "added"],
      ["messagesDeleted", "deleted"],
      ["labelsAdded", "labels_added"],
      ["labelsRemoved", "labels_removed"]
    ] as const;
    for (const [field, kind] of groups) {
      for (const entry of recordArray(history, field)) {
        const message = readRecord(entry, "message");
        const messageId = message ? readString(message, "id") : null;
        if (!messageId) continue;
        const parsed = GmailChangeRefSchema.parse({
          historyId,
          kind,
          messageId,
          ...(message && readString(message, "threadId")
            ? { threadId: readString(message, "threadId") }
            : {}),
          labelIds: readStringArray(entry, "labelIds")
        });
        changes.set(`${historyId}:${kind}:${messageId}`, parsed);
      }
    }
  }
  return [...changes.values()];
}

function normalizeGmailActivity(
  connection: ConnectorConnectionContext,
  change: GmailChangeRef,
  message: Record<string, unknown>
): Omit<NormalizedActivity, "id"> {
  const now = new Date().toISOString();
  const threadId = readString(message, "threadId") ?? change.threadId ?? change.messageId;
  const labelIds = readStringArray(message, "labelIds");
  const subjectHeader = gmailHeader(message, "Subject")?.trim();
  const fromHeader = gmailHeader(message, "From")?.trim();
  const subject = truncateText(subjectHeader || "(no subject)", 300);
  const snippet = truncateText(readString(message, "snippet") ?? "", 1000);
  const occurredAt =
    timestampFromMilliseconds(readString(message, "internalDate")) ??
    timestampFromValue(gmailHeader(message, "Date")) ??
    now;
  const reconciledAfterHistoryGap = change.historyId.startsWith("reconcile:");
  const received = change.kind === "added" && labelIds.includes("INBOX") && !reconciledAfterHistoryGap;
  const deleted = change.kind === "deleted";
  const messageHistoryId = readString(message, "historyId");
  const identity = `gmail:${messageHistoryId ?? change.historyId}:${change.kind}:${change.messageId}`;
  return {
    ...googleActivityScope(connection),
    provider: "google",
    providerEventId: identity,
    eventType: received ? "email.received" : "email.updated",
    resourceType: "gmail_thread",
    providerResourceId: threadId,
    actor: fromHeader ? { from: truncateText(fromHeader, 500) } : {},
    subject: { messageId: change.messageId, threadId, subject },
    occurredAt,
    receivedAt: now,
    title: deleted ? `Email removed: ${subject}` : received ? `New email: ${subject}` : `Email updated: ${subject}`,
    summary: fromHeader ? `From ${truncateText(fromHeader, 300)}` : deleted ? "Message removed from Gmail" : "Gmail message changed",
    textSnippet: snippet,
    payloadRef: null,
    entityKeys: [`google:gmail:thread:${threadId}`, `google:gmail:message:${change.messageId}`],
    dedupeKey: identity,
    rawContentHash: null,
    metadata: {
      changeType: change.kind,
      labelIds,
      changedLabelIds: change.labelIds,
      messageHistoryId,
      reconciledAfterHistoryGap
    }
  };
}

function calendarEventsUrl(calendarId: string, syncToken?: string, pageToken?: string): URL {
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`
  );
  url.searchParams.set("maxResults", String(GOOGLE_POLL_PAGE_SIZE));
  url.searchParams.set("showDeleted", "true");
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set(
    "fields",
    "nextPageToken,nextSyncToken,items(id,etag,status,updated,summary,location,htmlLink,creator,organizer,start,end,recurringEventId,originalStartTime,eventType)"
  );
  if (syncToken) url.searchParams.set("syncToken", syncToken);
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  return url;
}

function normalizeCalendarActivity(
  connection: ConnectorConnectionContext,
  calendarId: string,
  event: Record<string, unknown>
): Omit<NormalizedActivity, "id"> | null {
  const eventId = readString(event, "id");
  if (!eventId) return null;
  const now = new Date().toISOString();
  const status = readString(event, "status") ?? "confirmed";
  const title = truncateText(readString(event, "summary")?.trim() || "Untitled event", 300);
  const updatedAt = timestampFromValue(readString(event, "updated")) ?? now;
  const start = sanitizeCalendarDateTime(readRecord(event, "start"));
  const end = sanitizeCalendarDateTime(readRecord(event, "end"));
  const organizer = sanitizeGooglePerson(readRecord(event, "organizer"));
  const version = readString(event, "etag") ?? updatedAt;
  const identity = `calendar:${calendarId}:${eventId}:${version}`;
  const cancelled = status === "cancelled";
  return {
    ...googleActivityScope(connection),
    provider: "google",
    providerEventId: identity,
    eventType: "calendar.event_changed",
    resourceType: "calendar_event",
    providerResourceId: eventId,
    actor: organizer,
    subject: { eventId, calendarId, status, start, end },
    occurredAt: updatedAt,
    receivedAt: now,
    title: cancelled ? `Calendar event cancelled: ${title}` : `Calendar event changed: ${title}`,
    summary: start.dateTime || start.date ? `Starts ${start.dateTime ?? start.date}` : "Calendar event metadata changed",
    textSnippet: truncateText(
      [title, readString(event, "location")].filter((value): value is string => Boolean(value)).join(" · "),
      1000
    ),
    payloadRef: null,
    entityKeys: [`google:calendar:${calendarId}:event:${eventId}`],
    dedupeKey: identity,
    rawContentHash: null,
    metadata: {
      status,
      recurringEventId: readString(event, "recurringEventId"),
      eventType: readString(event, "eventType"),
      htmlLink: readString(event, "htmlLink")
    }
  };
}

function normalizeCalendarCompletionActivity(
  connection: ConnectorConnectionContext,
  calendarId: string,
  event: Record<string, unknown>,
  checkedAt: string,
  completionUntil: string
): Omit<NormalizedActivity, "id"> | null {
  const eventId = readString(event, "id");
  if (!eventId || readString(event, "status") === "cancelled") return null;
  const end = sanitizeCalendarDateTime(readRecord(event, "end"));
  const endedAt = timestampFromValue(
    typeof end.dateTime === "string" ? end.dateTime : typeof end.date === "string" ? end.date : null
  );
  if (!endedAt || endedAt <= checkedAt || endedAt > completionUntil) return null;
  const title = truncateText(readString(event, "summary")?.trim() || "Untitled event", 300);
  const identity = `calendar:${calendarId}:${eventId}:completed:${endedAt}`;
  return {
    ...googleActivityScope(connection),
    provider: "google",
    providerEventId: identity,
    eventType: "calendar.event_completed",
    resourceType: "calendar_event",
    providerResourceId: eventId,
    actor: sanitizeGooglePerson(readRecord(event, "organizer")),
    subject: {
      eventId,
      calendarId,
      status: readString(event, "status") ?? "confirmed",
      start: sanitizeCalendarDateTime(readRecord(event, "start")),
      end
    },
    occurredAt: endedAt,
    receivedAt: new Date().toISOString(),
    title: `Calendar event completed: ${title}`,
    summary: `Ended ${endedAt}`,
    textSnippet: truncateText(
      [title, readString(event, "location")].filter((value): value is string => Boolean(value)).join(" · "),
      1000
    ),
    payloadRef: null,
    entityKeys: [`google:calendar:${calendarId}:event:${eventId}`],
    dedupeKey: identity,
    rawContentHash: null,
    metadata: {
      completedAt: endedAt,
      recurringEventId: readString(event, "recurringEventId"),
      eventType: readString(event, "eventType")
    }
  };
}

function normalizeDriveActivity(
  connection: ConnectorConnectionContext,
  change: Record<string, unknown>
): Omit<NormalizedActivity, "id"> | null {
  const file = readRecord(change, "file");
  const fileId = readString(change, "fileId") ?? (file ? readString(file, "id") : null);
  if (!fileId) return null;
  const now = new Date().toISOString();
  const removed = readBoolean(change, "removed") ?? readBoolean(file, "trashed") ?? false;
  const name = truncateText(file ? readString(file, "name") ?? `Drive file ${fileId}` : `Drive file ${fileId}`, 300);
  const mimeType = file ? readString(file, "mimeType") : null;
  const resourceType = googleDriveResourceType(mimeType);
  const eventType = resourceType === "google_doc"
    ? "docs.document_changed"
    : resourceType === "google_sheet"
      ? "sheets.spreadsheet_changed"
      : "drive.file_changed";
  const resourceLabel = resourceType === "google_doc"
    ? "Google Doc"
    : resourceType === "google_sheet"
      ? "Google spreadsheet"
      : "Drive file";
  const occurredAt =
    timestampFromValue(readString(change, "time")) ??
    timestampFromValue(file ? readString(file, "modifiedTime") : null) ??
    now;
  const actor = sanitizeGooglePerson(file ? readRecord(file, "lastModifyingUser") : null);
  const version = [occurredAt, file ? readString(file, "md5Checksum") : null, removed ? "removed" : "changed"]
    .filter((value): value is string => Boolean(value))
    .join(":");
  const identity = `drive:${fileId}:${version}`;
  return {
    ...googleActivityScope(connection),
    provider: "google",
    providerEventId: identity,
    eventType,
    resourceType,
    providerResourceId: fileId,
    actor,
    subject: { fileId, name, mimeType, removed },
    occurredAt,
    receivedAt: now,
    title: removed ? `${resourceLabel} removed: ${name}` : `${resourceLabel} changed: ${name}`,
    summary: mimeType ? `${removed ? "Removed" : "Updated"} ${mimeType}` : removed ? "Drive file removed" : "Drive file changed",
    textSnippet: name,
    payloadRef: null,
    entityKeys: [`google:drive:file:${fileId}`],
    dedupeKey: identity,
    rawContentHash: null,
    metadata: {
      removed,
      trashed: file ? readBoolean(file, "trashed") : null,
      driveId: readString(change, "driveId"),
      parents: file ? readStringArray(file, "parents") : [],
      mimeType
    }
  };
}

function googleDriveResourceType(mimeType: string | null): "drive_file" | "google_doc" | "google_sheet" {
  if (mimeType === "application/vnd.google-apps.document") return "google_doc";
  if (mimeType === "application/vnd.google-apps.spreadsheet") return "google_sheet";
  return "drive_file";
}

function googleActivityScope(
  connection: ConnectorConnectionContext
): Pick<
  Omit<NormalizedActivity, "id">,
  | "workspaceId"
  | "region"
  | "connectionId"
  | "connectionScope"
  | "connectionOwnerUserId"
  | "visibility"
  | "targetUserIds"
> {
  return {
    workspaceId: connection.workspaceId,
    region: z.enum(["global", "eu"]).parse(connection.config.region ?? "global"),
    connectionId: connection.id,
    connectionScope: connection.scope,
    connectionOwnerUserId: connection.ownerUserId,
    visibility:
      connection.scope === "personal"
        ? { scope: "personal", ownerUserId: connection.ownerUserId }
        : { scope: "workspace" },
    targetUserIds:
      connection.scope === "personal" && connection.ownerUserId ? [connection.ownerUserId] : []
  };
}

function sanitizeGmailThread(payload: Record<string, unknown>): Record<string, unknown> {
  const messages = recordArray(payload, "messages");
  return {
    resourceType: "gmail_thread",
    id: readString(payload, "id"),
    historyId: readString(payload, "historyId"),
    messages: messages.slice(0, GOOGLE_MAX_HYDRATED_MESSAGES).map((message) => ({
      id: readString(message, "id"),
      threadId: readString(message, "threadId"),
      historyId: readString(message, "historyId"),
      internalDate: readString(message, "internalDate"),
      labelIds: readStringArray(message, "labelIds"),
      from: truncateNullable(gmailHeader(message, "From"), 500),
      to: truncateNullable(gmailHeader(message, "To"), 1000),
      cc: truncateNullable(gmailHeader(message, "Cc"), 1000),
      subject: truncateNullable(gmailHeader(message, "Subject"), 1000),
      date: truncateNullable(gmailHeader(message, "Date"), 500),
      messageIdHeader: truncateNullable(gmailHeader(message, "Message-ID"), 1_000),
      inReplyTo: truncateNullable(gmailHeader(message, "In-Reply-To"), 1_000),
      references: truncateNullable(gmailHeader(message, "References"), 10_000),
      snippet: truncateText(readString(message, "snippet") ?? "", 1000)
    })),
    messagesTruncated: messages.length > GOOGLE_MAX_HYDRATED_MESSAGES,
    totalMessages: messages.length
  };
}

function sanitizeGmailThreadForTool(payload: Record<string, unknown>): Record<string, unknown> {
  const messages = recordArray(payload, "messages");
  const boundedMessages: Record<string, unknown>[] = [];
  let remainingTextBytes = GOOGLE_TOOL_TEXT_BYTES;
  for (const message of messages.slice(0, GOOGLE_TOOL_GMAIL_MESSAGES)) {
    const item = sanitizeGmailMessageForTool(message, Math.min(remainingTextBytes, 32_000));
    boundedMessages.push(item);
    const body = typeof item.textContent === "string" ? item.textContent : "";
    remainingTextBytes = Math.max(0, remainingTextBytes - new TextEncoder().encode(body).byteLength);
  }
  return {
    resourceType: "gmail_thread",
    id: readString(payload, "id"),
    historyId: readString(payload, "historyId"),
    messages: boundedMessages,
    messagesTruncated: messages.length > GOOGLE_TOOL_GMAIL_MESSAGES,
    totalMessages: messages.length,
    textBudgetExhausted: remainingTextBytes === 0
  };
}

function sanitizeGmailMessageForTool(
  message: Record<string, unknown>,
  maximumTextBytes: number
): Record<string, unknown> {
  const extracted = extractGmailTextAndAttachments(readRecord(message, "payload"), maximumTextBytes);
  return {
    resourceType: "gmail_message",
    id: readString(message, "id"),
    threadId: readString(message, "threadId"),
    historyId: readString(message, "historyId"),
    internalDate: readString(message, "internalDate"),
    labelIds: readStringArray(message, "labelIds"),
    from: truncateNullable(gmailHeader(message, "From"), 500),
    to: truncateNullable(gmailHeader(message, "To"), 1000),
    cc: truncateNullable(gmailHeader(message, "Cc"), 1000),
    subject: truncateNullable(gmailHeader(message, "Subject"), 1000),
    date: truncateNullable(gmailHeader(message, "Date"), 500),
    messageIdHeader: truncateNullable(gmailHeader(message, "Message-ID"), 1_000),
    inReplyTo: truncateNullable(gmailHeader(message, "In-Reply-To"), 1_000),
    references: truncateNullable(gmailHeader(message, "References"), 10_000),
    snippet: truncateText(readString(message, "snippet") ?? "", 1000),
    textContent: extracted.text,
    textTruncated: extracted.truncated,
    attachments: extracted.attachments
  };
}

function extractGmailTextAndAttachments(
  payload: Record<string, unknown> | null,
  maximumBytes: number
): {
  text: string;
  truncated: boolean;
  attachments: Record<string, unknown>[];
} {
  if (!payload || maximumBytes <= 0) return { text: "", truncated: Boolean(payload), attachments: [] };
  const plain: string[] = [];
  const html: string[] = [];
  const attachments: Record<string, unknown>[] = [];
  const stack: Record<string, unknown>[] = [payload];
  let visited = 0;
  while (stack.length > 0 && visited < 100) {
    const part = stack.pop();
    if (!part) break;
    visited += 1;
    stack.push(...recordArray(part, "parts").reverse());
    const body = readRecord(part, "body");
    const filename = readString(part, "filename") ?? "";
    const attachmentId = body ? readString(body, "attachmentId") : null;
    if ((filename || attachmentId) && attachments.length < 50) {
      attachments.push({
        filename: truncateText(filename, 500),
        mimeType: readString(part, "mimeType"),
        attachmentId,
        size: body ? readNumber(body, "size") : null,
        contentIncluded: false
      });
    }
    const encoded = body ? readString(body, "data") : null;
    if (!encoded || filename) continue;
    const decoded = decodeBase64UrlText(encoded);
    if (decoded === null) continue;
    const mimeType = (readString(part, "mimeType") ?? "").toLocaleLowerCase();
    if (mimeType === "text/plain") plain.push(decoded);
    else if (mimeType === "text/html") html.push(extractReadableText(decoded));
  }
  const candidate = (plain.length > 0 ? plain : html).join("\n\n").trim();
  const bounded = truncateUtf8(candidate, maximumBytes);
  return {
    text: bounded.text,
    truncated: bounded.truncated || visited >= 100,
    attachments
  };
}

function sanitizeGoogleCalendar(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    id: readString(payload, "id"),
    summary: truncateNullable(readString(payload, "summary"), 1_000),
    summaryOverride: truncateNullable(readString(payload, "summaryOverride"), 1_000),
    description: truncateNullable(readString(payload, "description"), 20_000),
    location: truncateNullable(readString(payload, "location"), 2_000),
    timeZone: readString(payload, "timeZone"),
    accessRole: readString(payload, "accessRole"),
    primary: readBoolean(payload, "primary") ?? false,
    selected: readBoolean(payload, "selected") ?? false,
    hidden: readBoolean(payload, "hidden") ?? false,
    deleted: readBoolean(payload, "deleted") ?? false,
    colorId: readString(payload, "colorId"),
    backgroundColor: readString(payload, "backgroundColor"),
    foregroundColor: readString(payload, "foregroundColor")
  };
}

function sanitizeCalendarEvent(payload: Record<string, unknown>, calendarId: string): Record<string, unknown> {
  return {
    resourceType: "calendar_event",
    calendarId,
    id: readString(payload, "id"),
    iCalUID: readString(payload, "iCalUID"),
    status: readString(payload, "status"),
    htmlLink: readString(payload, "htmlLink"),
    created: readString(payload, "created"),
    updated: readString(payload, "updated"),
    summary: truncateNullable(readString(payload, "summary"), 1000),
    description: truncateNullable(readString(payload, "description"), 20_000),
    location: truncateNullable(readString(payload, "location"), 2000),
    creator: sanitizeGooglePerson(readRecord(payload, "creator")),
    organizer: sanitizeGooglePerson(readRecord(payload, "organizer")),
    start: sanitizeCalendarDateTime(readRecord(payload, "start")),
    end: sanitizeCalendarDateTime(readRecord(payload, "end")),
    recurrence: readStringArray(payload, "recurrence").slice(0, 50),
    recurringEventId: readString(payload, "recurringEventId"),
    originalStartTime: sanitizeCalendarDateTime(readRecord(payload, "originalStartTime")),
    attendees: recordArray(payload, "attendees").slice(0, 50).map((attendee) => ({
      ...sanitizeGooglePerson(attendee),
      responseStatus: readString(attendee, "responseStatus"),
      organizer: readBoolean(attendee, "organizer") ?? false
    })),
    attendeesTruncated: recordArray(payload, "attendees").length > 50,
    attachments: recordArray(payload, "attachments").slice(0, 20).map((attachment) => ({
      fileId: readString(attachment, "fileId"),
      title: truncateNullable(readString(attachment, "title"), 1000),
      mimeType: readString(attachment, "mimeType"),
      fileUrl: readString(attachment, "fileUrl")
    })),
    visibility: readString(payload, "visibility"),
    transparency: readString(payload, "transparency"),
    eventType: readString(payload, "eventType")
  };
}

function calendarEventWriteBody(args: {
  summary?: string | undefined;
  description?: string | undefined;
  location?: string | undefined;
  start?: string | undefined;
  end?: string | undefined;
  timeZone?: string | undefined;
  attendeeEmails?: string[] | undefined;
}): Record<string, unknown> {
  return {
    ...(args.summary !== undefined ? { summary: args.summary } : {}),
    ...(args.description !== undefined ? { description: args.description } : {}),
    ...(args.location !== undefined ? { location: args.location } : {}),
    ...(args.start !== undefined
      ? { start: { dateTime: args.start, ...(args.timeZone ? { timeZone: args.timeZone } : {}) } }
      : {}),
    ...(args.end !== undefined
      ? { end: { dateTime: args.end, ...(args.timeZone ? { timeZone: args.timeZone } : {}) } }
      : {}),
    ...(args.attendeeEmails !== undefined
      ? { attendees: args.attendeeEmails.map((email) => ({ email })) }
      : {})
  };
}

async function readGoogleDocument(
  api: GoogleApiRequester,
  connection: ConnectorConnectionContext,
  documentId: string,
  signal: AbortSignal
): Promise<Record<string, unknown>> {
  const url = new URL(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}`);
  url.searchParams.set("includeTabsContent", "true");
  return api(connection, url.toString(), { signal }).then((response) =>
    safeJsonBounded(response, GOOGLE_TOOL_RESPONSE_BYTES)
  );
}

async function updateGoogleDocument(
  api: GoogleApiRequester,
  connection: ConnectorConnectionContext,
  documentId: string,
  requests: Record<string, unknown>[],
  signal: AbortSignal
): Promise<Record<string, unknown>> {
  return api(
    connection,
    `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`,
    { method: "POST", body: JSON.stringify({ requests }), signal }
  ).then((response) => safeJsonBounded(response, GOOGLE_TOOL_RESPONSE_BYTES));
}

function sanitizeGoogleDocument(payload: Record<string, unknown>): Record<string, unknown> {
  const extracted = extractGoogleDocumentText(payload, GOOGLE_TOOL_TEXT_BYTES);
  return {
    resourceType: "google_doc",
    documentId: readString(payload, "documentId"),
    title: truncateNullable(readString(payload, "title"), 1_000),
    revisionId: readString(payload, "revisionId"),
    suggestionsViewMode: readString(payload, "suggestionsViewMode"),
    tabs: sanitizeGoogleDocumentTabs(recordArray(payload, "tabs")),
    textContent: extracted.text,
    textTruncated: extracted.truncated,
    url: readString(payload, "documentId")
      ? `https://docs.google.com/document/d/${encodeURIComponent(requiredString(payload, "documentId", "Missing document ID"))}/edit`
      : null
  };
}

function extractGoogleDocumentText(
  payload: Record<string, unknown>,
  maximumBytes: number
): { text: string; truncated: boolean } {
  const chunks: string[] = [];
  const stack: unknown[] = [payload];
  let visited = 0;
  while (stack.length > 0 && visited < 100_000) {
    const candidate = stack.pop();
    visited += 1;
    if (Array.isArray(candidate)) {
      stack.push(...candidate.slice().reverse());
      continue;
    }
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Record<string, unknown>;
    const textRun = readRecord(record, "textRun");
    if (textRun) {
      const content = readString(textRun, "content");
      if (content) chunks.push(content);
      continue;
    }
    stack.push(...Object.values(record).reverse());
  }
  const bounded = truncateUtf8(chunks.join(""), maximumBytes);
  return { text: bounded.text, truncated: bounded.truncated || visited >= 100_000 };
}

function sanitizeGoogleDocumentTabs(tabs: Record<string, unknown>[]): Record<string, unknown>[] {
  return tabs.slice(0, 100).map((tab) => {
    const properties = readRecord(tab, "tabProperties");
    return {
      tabId: properties ? readString(properties, "tabId") : null,
      title: properties ? truncateNullable(readString(properties, "title"), 500) : null,
      index: properties ? readNumber(properties, "index") : null,
      nestingLevel: properties ? readNumber(properties, "nestingLevel") : null,
      children: sanitizeGoogleDocumentTabs(recordArray(tab, "childTabs"))
    };
  });
}

async function readGoogleSpreadsheet(
  api: GoogleApiRequester,
  connection: ConnectorConnectionContext,
  spreadsheetId: string,
  signal: AbortSignal
): Promise<Record<string, unknown>> {
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`);
  url.searchParams.set("includeGridData", "false");
  url.searchParams.set(
    "fields",
    "spreadsheetId,spreadsheetUrl,properties(title,locale,timeZone),sheets(properties(sheetId,title,index,sheetType,hidden,gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount)))"
  );
  return api(connection, url.toString(), { signal }).then((response) =>
    safeJsonBounded(response, GOOGLE_TOOL_RESPONSE_BYTES)
  );
}

function sanitizeGoogleSpreadsheet(payload: Record<string, unknown>): Record<string, unknown> {
  const properties = readRecord(payload, "properties");
  const sheets = recordArray(payload, "sheets");
  return {
    resourceType: "google_sheet",
    spreadsheetId: readString(payload, "spreadsheetId"),
    spreadsheetUrl: readString(payload, "spreadsheetUrl"),
    title: properties ? truncateNullable(readString(properties, "title"), 1_000) : null,
    locale: properties ? readString(properties, "locale") : null,
    timeZone: properties ? readString(properties, "timeZone") : null,
    sheets: sheets.slice(0, 200).map((sheet) => {
      const sheetProperties = readRecord(sheet, "properties");
      const grid = sheetProperties ? readRecord(sheetProperties, "gridProperties") : null;
      return {
        sheetId: sheetProperties ? readNumber(sheetProperties, "sheetId") : null,
        title: sheetProperties ? truncateNullable(readString(sheetProperties, "title"), 500) : null,
        index: sheetProperties ? readNumber(sheetProperties, "index") : null,
        sheetType: sheetProperties ? readString(sheetProperties, "sheetType") : null,
        hidden: sheetProperties ? readBoolean(sheetProperties, "hidden") ?? false : false,
        rowCount: grid ? readNumber(grid, "rowCount") : null,
        columnCount: grid ? readNumber(grid, "columnCount") : null,
        frozenRowCount: grid ? readNumber(grid, "frozenRowCount") : null,
        frozenColumnCount: grid ? readNumber(grid, "frozenColumnCount") : null
      };
    }),
    sheetsTruncated: sheets.length > 200
  };
}

function sanitizeGoogleSheetValues(payload: Record<string, unknown>): Record<string, unknown> {
  const rawValues = Array.isArray(payload.values) ? payload.values : [];
  const values: unknown[][] = [];
  let cells = 0;
  let truncated = false;
  for (const rawRow of rawValues) {
    if (!Array.isArray(rawRow) || values.length >= 500) {
      truncated = true;
      break;
    }
    const row: unknown[] = [];
    for (const value of rawRow) {
      if (cells >= 10_000 || row.length >= 1_000) {
        truncated = true;
        break;
      }
      row.push(typeof value === "string" ? truncateText(value, 50_000) : value);
      cells += 1;
    }
    values.push(row);
    if (truncated) break;
  }
  return {
    range: readString(payload, "range"),
    majorDimension: readString(payload, "majorDimension"),
    values,
    rowCount: values.length,
    cellCount: cells,
    truncated: truncated || rawValues.length > values.length
  };
}

function sanitizeGoogleSheetWriteResponse(payload: Record<string, unknown>): Record<string, unknown> {
  const updates = readRecord(payload, "updates") ?? payload;
  return {
    spreadsheetId: readString(payload, "spreadsheetId") ?? readString(updates, "spreadsheetId"),
    tableRange: readString(payload, "tableRange"),
    updatedRange: readString(updates, "updatedRange"),
    updatedRows: readNumber(updates, "updatedRows"),
    updatedColumns: readNumber(updates, "updatedColumns"),
    updatedCells: readNumber(updates, "updatedCells")
  };
}

function sanitizeDriveFile(payload: Record<string, unknown>): Record<string, unknown> {
  const mimeType = readString(payload, "mimeType");
  return {
    resourceType: googleDriveResourceType(mimeType),
    id: readString(payload, "id"),
    name: truncateNullable(readString(payload, "name"), 1000),
    mimeType,
    modifiedTime: readString(payload, "modifiedTime"),
    createdTime: readString(payload, "createdTime"),
    webViewLink: readString(payload, "webViewLink"),
    trashed: readBoolean(payload, "trashed") ?? false,
    owners: recordArray(payload, "owners").slice(0, 20).map(sanitizeGooglePerson),
    lastModifyingUser: sanitizeGooglePerson(readRecord(payload, "lastModifyingUser")),
    size: readString(payload, "size"),
    md5Checksum: readString(payload, "md5Checksum"),
    parents: readStringArray(payload, "parents").slice(0, 100),
    description: truncateNullable(readString(payload, "description"), 20_000)
  };
}

type GoogleApiRequester = (
  connection: ConnectorConnectionContext,
  url: string,
  init?: RequestInit,
  allowedErrorStatuses?: readonly number[]
) => Promise<Response>;

function googleDriveMetadataUrl(fileId: string): URL {
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set(
    "fields",
    "id,name,mimeType,modifiedTime,createdTime,webViewLink,trashed,owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress),size,md5Checksum,parents,description"
  );
  return url;
}

async function readDriveTextContent(
  api: GoogleApiRequester,
  connection: ConnectorConnectionContext,
  fileId: string,
  metadata: Record<string, unknown>,
  signal: AbortSignal,
  maximumBytes: number
): Promise<Record<string, unknown> & { textContent: string | null }> {
  const mimeType = readString(metadata, "mimeType") ?? "application/octet-stream";
  const declaredSize = Number(readString(metadata, "size") ?? Number.NaN);
  if (Number.isFinite(declaredSize) && declaredSize > maximumBytes) {
    return {
      textContent: null,
      contentIncluded: false,
      contentOmittedReason: `File exceeds the ${maximumBytes}-byte model-context limit`
    };
  }
  let url: URL | null = null;
  if (mimeType === "application/vnd.google-apps.document" || mimeType === "application/vnd.google-apps.spreadsheet") {
    url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export`);
    url.searchParams.set(
      "mimeType",
      mimeType === "application/vnd.google-apps.spreadsheet" ? "text/csv" : "text/plain"
    );
  } else if (isTextLikeMimeType(mimeType)) {
    url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
    url.searchParams.set("alt", "media");
    url.searchParams.set("supportsAllDrives", "true");
  }
  if (!url) {
    return {
      textContent: null,
      contentIncluded: false,
      contentOmittedReason: "Binary and unsupported Drive content is not exposed to the model"
    };
  }
  try {
    const response = await api(connection, url.toString(), { signal });
    const bytes = await readBounded(response, maximumBytes);
    return {
      textContent: new TextDecoder().decode(bytes),
      contentIncluded: true,
      contentBytes: bytes.byteLength,
      ...(mimeType === "application/vnd.google-apps.spreadsheet"
        ? {
            contentScope: "first_sheet_csv",
            contentNotice: "Drive CSV export contains only the spreadsheet's first sheet; use Google Sheets range tools for complete data"
          }
        : {})
    };
  } catch (error) {
    if (error instanceof ConnectorError && error.code === "payload_too_large") {
      return {
        textContent: null,
        contentIncluded: false,
        contentOmittedReason: `File exceeds the ${maximumBytes}-byte model-context limit`
      };
    }
    throw error;
  }
}

function sanitizeCalendarDateTime(value: Record<string, unknown> | null): Record<string, unknown> {
  if (!value) return {};
  return {
    date: readString(value, "date"),
    dateTime: readString(value, "dateTime"),
    timeZone: readString(value, "timeZone")
  };
}

function sanitizeGooglePerson(value: Record<string, unknown> | null): Record<string, unknown> {
  if (!value) return {};
  return {
    displayName: truncateNullable(readString(value, "displayName"), 500),
    email: truncateNullable(readString(value, "email") ?? readString(value, "emailAddress"), 500),
    self: readBoolean(value, "self") ?? false
  };
}

function googleCalendarId(connection: ConnectorConnectionContext): string {
  return z.string().min(1).max(1024).parse(connection.config.calendarId ?? "primary");
}

function assertGoogleCapability(connection: ConnectorConnectionContext, capability: string): void {
  if (!connection.grantedScopes.includes(capability)) {
    throw new ConnectorError("unsupported_capability", `Connection has not granted ${capability}`);
  }
}

function googleResourceField(
  resource: Record<string, unknown>,
  camelCase: string,
  snakeCase: string
): string | null {
  return readString(resource, camelCase) ?? readString(resource, snakeCase);
}

function gmailHeader(message: Record<string, unknown>, name: string): string | null {
  const payload = readRecord(message, "payload");
  if (!payload) return null;
  const header = recordArray(payload, "headers").find(
    (candidate) => readString(candidate, "name")?.toLocaleLowerCase() === name.toLocaleLowerCase()
  );
  return header ? readString(header, "value") : null;
}

function recordArray(value: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const nested = value[key];
  if (!Array.isArray(nested)) return [];
  return nested.filter(
    (candidate): candidate is Record<string, unknown> => Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate)
  );
}

function readRecord(value: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  if (!value) return null;
  const nested = value[key];
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : null;
}

function readStringArray(value: Record<string, unknown>, key: string): string[] {
  const nested = value[key];
  return Array.isArray(nested) ? nested.filter((candidate): candidate is string => typeof candidate === "string") : [];
}

function readBoolean(value: Record<string, unknown> | null, key: string): boolean | null {
  if (!value) return null;
  const nested = value[key];
  return typeof nested === "boolean" ? nested : null;
}

function readNumber(value: Record<string, unknown> | null, key: string): number | null {
  if (!value) return null;
  const nested = value[key];
  return typeof nested === "number" && Number.isFinite(nested) ? nested : null;
}

function requiredString(value: Record<string, unknown>, key: string, message: string): string {
  const candidate = readString(value, key);
  if (!candidate) throw new ConnectorError("provider_error", message);
  return candidate;
}

function truncateText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 1))}…`;
}

function truncateNullable(value: string | null, maximum: number): string | null {
  return value === null ? null : truncateText(value, maximum);
}

function truncateUtf8(value: string, maximumBytes: number): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maximumBytes) return { text: value, truncated: false };
  return {
    text: new TextDecoder().decode(bytes.subarray(0, Math.max(0, maximumBytes))).replace(/\uFFFD$/u, ""),
    truncated: true
  };
}

function decodeBase64UrlText(value: string): string | null {
  try {
    return new TextDecoder().decode(base64ToBytes(value));
  } catch {
    return null;
  }
}

function boundedToolOutput<T>(value: T): T {
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes > GOOGLE_TOOL_RESPONSE_BYTES) {
    throw new ConnectorError(
      "payload_too_large",
      `Sanitized Google tool output exceeds ${GOOGLE_TOOL_RESPONSE_BYTES} bytes`
    );
  }
  return value;
}

function timestampFromMilliseconds(value: string | null): string | null {
  if (!value) return null;
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds)) return null;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function timestampFromValue(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isTextLikeMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    ["application/json", "application/xml", "application/javascript", "application/x-yaml"].includes(mimeType)
  );
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<U>
): Promise<U[]> {
  const output: U[] = [];
  for (let index = 0; index < values.length; index += concurrency) {
    output.push(...(await Promise.all(values.slice(index, index + concurrency).map(mapper))));
  }
  return output;
}

async function safeJsonBounded(response: Response, maximumBytes: number): Promise<Record<string, unknown>> {
  const bytes = await readBounded(response, maximumBytes);
  try {
    return z.record(z.string(), z.unknown()).parse(
      JSON.parse(new TextDecoder().decode(bytes)) as unknown
    );
  } catch (error) {
    throw new ConnectorError("provider_error", "Google API returned invalid JSON", error);
  }
}

function normalizeGoogleToken(value: unknown): Record<string, unknown> {
  const payload = z
    .object({
      access_token: z.string(),
      expires_in: z.number().int().positive(),
      refresh_token: z.string().optional(),
      scope: z.string().optional(),
      token_type: z.string().optional(),
      id_token: z.string().optional()
    })
    .parse(value);
  return {
    accessToken: payload.access_token,
    ...(payload.refresh_token ? { refreshToken: payload.refresh_token } : {}),
    expiresAt: new Date(Date.now() + payload.expires_in * 1000).toISOString(),
    scopes: payload.scope?.split(" ") ?? [],
    tokenType: payload.token_type ?? "Bearer",
    ...(payload.id_token ? { idToken: payload.id_token } : {})
  };
}

export interface VerifiedWebhook {
  timestamp: number;
  event: Record<string, unknown>;
  signatureHash: string;
}

export async function verifyGenericWebhook(input: {
  secret: string;
  signatureHeader: string | null;
  body: string;
  now?: number;
  replayWindowSeconds?: number;
}): Promise<VerifiedWebhook> {
  const components = Object.fromEntries(
    (input.signatureHeader ?? "")
      .split(",")
      .map((part) => part.trim().split("=", 2))
      .filter((entry): entry is [string, string] => entry.length === 2)
  );
  const timestamp = Number(components.t);
  const signature = components.v1;
  if (!Number.isFinite(timestamp) || !signature) {
    throw new ConnectorError("invalid_signature", "Missing webhook timestamp or signature");
  }
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > (input.replayWindowSeconds ?? 300)) {
    throw new ConnectorError("invalid_signature", "Webhook timestamp is outside the replay window");
  }
  const expected = await hmacHex(input.secret, `${timestamp}.${input.body}`);
  if (!constantTimeEqual(expected, signature.toLowerCase())) {
    throw new ConnectorError("invalid_signature", "Webhook signature does not match");
  }
  let event: unknown;
  try {
    event = JSON.parse(input.body) as unknown;
  } catch {
    throw new ConnectorError("invalid_signature", "Webhook body is not valid JSON");
  }
  return {
    timestamp,
    event: z.record(z.string(), z.unknown()).parse(event),
    signatureHash: await sha256(signature)
  };
}

export function createWebhookSecret(): string {
  return `whsec_${bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

export interface WebMonitorState extends Record<string, unknown> {
  etag?: string | undefined;
  lastModified?: string | undefined;
  contentHash?: string | undefined;
  lastSuccessfulFetch?: string | undefined;
  lastChangedAt?: string | undefined;
}

export interface WebMonitorResult {
  changed: boolean;
  notModified: boolean;
  state: WebMonitorState;
  snapshot?: {
    url: string;
    contentType: string;
    contentHash: string;
    readableText: string;
    fetchedAt: string;
    phraseMatched: boolean | null;
  };
}

export async function pollWebMonitor(input: {
  url: string;
  previous: WebMonitorState;
  phrase?: string | null;
  maxBytes?: number;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  now?: Date;
}): Promise<WebMonitorResult> {
  const url = await assertSafePublicUrl(input.url);
  const headers = new Headers({
    Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.8"
  });
  if (input.previous.etag) headers.set("If-None-Match", input.previous.etag);
  if (input.previous.lastModified) headers.set("If-Modified-Since", input.previous.lastModified);
  const { response, finalUrl } = await fetchWithSafeRedirects(url, input.fetch ?? globalThis.fetch, {
    headers,
    signal: AbortSignal.timeout(input.timeoutMs ?? 15_000)
  });
  const fetchedAt = (input.now ?? new Date()).toISOString();
  if (response.status === 304) {
    return {
      changed: false,
      notModified: true,
      state: { ...input.previous, lastSuccessfulFetch: fetchedAt }
    };
  }
  if (!response.ok) throw new ConnectorError("provider_error", `Monitored page returned ${response.status}`);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "application/octet-stream";
  const allowed = ["text/html", "application/xhtml+xml", "text/plain", "application/json"];
  if (!allowed.includes(contentType)) {
    throw new ConnectorError("provider_error", `Unsupported monitored content type: ${contentType}`);
  }
  const bytes = await readBounded(response, input.maxBytes ?? 2_000_000);
  const raw = new TextDecoder().decode(bytes);
  const readableText = contentType.includes("html") ? extractReadableText(raw) : raw.trim();
  const contentHash = await sha256(readableText);
  const changed = Boolean(input.previous.contentHash && input.previous.contentHash !== contentHash);
  return {
    changed,
    notModified: false,
    state: {
      etag: response.headers.get("etag") ?? undefined,
      lastModified: response.headers.get("last-modified") ?? undefined,
      contentHash,
      lastSuccessfulFetch: fetchedAt,
      lastChangedAt: changed ? fetchedAt : input.previous.lastChangedAt
    },
    snapshot: {
      url: response.url || finalUrl.toString(),
      contentType,
      contentHash,
      readableText,
      fetchedAt,
      phraseMatched: input.phrase ? readableText.toLocaleLowerCase().includes(input.phrase.toLocaleLowerCase()) : null
    }
  };
}

export function createWebMonitorConnector(fetcher = globalThis.fetch): ConnectorAdapter {
  return {
    manifest: {
      type: "web_monitor",
      displayName: "Web monitor",
      supportedScopes: ["personal", "workspace"],
      oauthRequired: false,
      activityTypes: ["web.changed", "web.phrase_matched"],
      resourceTypes: ["web_page"],
      tools: [
        {
          name: "web_monitor.fetch",
          description: "Fetch the configured public web page and return readable text.",
          capability: "web.read",
          mode: "read",
          idempotency: "safe",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: { url: { type: "string", format: "uri" } },
            required: ["url"]
          }
        }
      ],
      supportsWatches: true,
      supportsPolling: true,
      supportsWebhooks: false
    },
    async poll(connection, signal) {
      void signal;
      const url = z.string().url().parse(connection.config.url);
      const intervalSeconds = z.number().int().min(300).parse(connection.config.intervalSeconds ?? 3600);
      const result = await pollWebMonitor({
        url,
        previous: connection.cursor as WebMonitorState,
        phrase: typeof connection.config.phrase === "string" ? connection.config.phrase : null,
        fetch: fetcher
      });
      const activities: Omit<NormalizedActivity, "id">[] = [];
      if (result.changed && result.snapshot) {
        activities.push({
          workspaceId: connection.workspaceId,
          region: z.enum(["global", "eu"]).parse(connection.config.region ?? "global"),
          connectionId: connection.id,
          connectionScope: connection.scope,
          connectionOwnerUserId: connection.ownerUserId,
          provider: "web_monitor",
          providerEventId: result.snapshot.contentHash,
          eventType: result.snapshot.phraseMatched ? "web.phrase_matched" : "web.changed",
          resourceType: "web_page",
          providerResourceId: result.snapshot.url,
          actor: {},
          subject: { url: result.snapshot.url },
          occurredAt: result.snapshot.fetchedAt,
          receivedAt: result.snapshot.fetchedAt,
          title: `Web page changed: ${new URL(result.snapshot.url).hostname}`,
          summary: result.snapshot.readableText.slice(0, 500),
          textSnippet: result.snapshot.readableText.slice(0, 4000),
          payloadRef: null,
          visibility: { scope: connection.scope },
          targetUserIds: connection.ownerUserId ? [connection.ownerUserId] : [],
          entityKeys: [result.snapshot.url],
          dedupeKey: result.snapshot.contentHash,
          rawContentHash: result.snapshot.contentHash,
          metadata: { contentType: result.snapshot.contentType, phraseMatched: result.snapshot.phraseMatched }
        });
      }
      return {
        activities,
        cursor: result.state,
        nextPollAt: new Date(Date.now() + intervalSeconds * 1000).toISOString()
      };
    },
    async executeTool(name, args, context) {
      assertPrincipalAccess(context.connection, context.principal);
      if (name !== "web_monitor.fetch") throw new ConnectorError("unsupported_capability", `Unsupported tool: ${name}`);
      const url = z.object({ url: z.string().url() }).parse(args).url;
      const result = await pollWebMonitor({ url, previous: {}, fetch: fetcher });
      return { output: result.snapshot ?? {}, summary: `Fetched ${new URL(url).hostname}` };
    },
    async healthCheck() {
      return { ok: true, message: "Web monitor is available" };
    }
  };
}

export function createGenericWebhookConnector(): ConnectorAdapter {
  return {
    manifest: {
      type: "generic_webhook",
      displayName: "Generic webhook",
      supportedScopes: ["personal", "workspace"],
      oauthRequired: false,
      activityTypes: ["webhook.received"],
      resourceTypes: ["webhook_resource"],
      tools: [],
      supportsWatches: false,
      supportsPolling: false,
      supportsWebhooks: true
    },
    async executeTool(name) {
      throw new ConnectorError("unsupported_capability", `Generic webhooks expose no outbound tool named ${name}`);
    },
    async healthCheck() {
      return { ok: true, message: "Webhook verification is available" };
    }
  };
}

export class ConnectorRegistry {
  private readonly adapters = new Map<string, ResolvedConnectorAdapter>();

  constructor(adapters: ConnectorAdapter[]) {
    for (const adapter of adapters) {
      const manifest = ConnectorManifestSchema.parse(adapter.manifest);
      if (this.adapters.has(manifest.type)) {
        throw new ConnectorError("invalid_configuration", `Duplicate connector type: ${manifest.type}`);
      }
      if (manifest.surfaces.includes("native_agent")) {
        if (!adapter.nativeAgent) {
          throw new ConnectorError(
            "invalid_configuration",
            `Connector ${manifest.type} declares a native-agent surface without a protocol adapter`,
          );
        }
        if (adapter.nativeAgent.capability !== manifest.nativeAgent?.capability) {
          throw new ConnectorError(
            "invalid_configuration",
            `Connector ${manifest.type} native-agent capability does not match its manifest`,
          );
        }
      } else if (adapter.nativeAgent) {
        throw new ConnectorError(
          "invalid_configuration",
          `Connector ${manifest.type} has a native-agent protocol adapter without a native-agent surface`,
        );
      }
      if (adapter.capabilityConnectionScopes) {
        const declaredCapabilities = new Set(manifest.capabilities.map((capability) => capability.id));
        for (const [capability, scopes] of Object.entries(adapter.capabilityConnectionScopes)) {
          if (!declaredCapabilities.has(capability)) {
            throw new ConnectorError(
              "invalid_configuration",
              `Connector ${manifest.type} narrows an undeclared capability: ${capability}`,
            );
          }
          if (!scopes.length || scopes.some((scope) => !manifest.supportedScopes.includes(scope))) {
            throw new ConnectorError(
              "invalid_configuration",
              `Connector ${manifest.type} has invalid connection scopes for capability ${capability}`,
            );
          }
        }
      }
      this.adapters.set(manifest.type, { ...adapter, manifest });
    }
  }

  get(type: string): ResolvedConnectorAdapter {
    const adapter = this.adapters.get(type);
    if (!adapter) throw new ConnectorError("unsupported_capability", `Connector is unavailable: ${type}`);
    return adapter;
  }

  list(): ConnectorManifest[] {
    return [...this.adapters.values()].map((adapter) => adapter.manifest);
  }
}

export function connectorSupportsSurface(
  manifest: ConnectorManifest,
  surface: ConnectorSurface,
): boolean {
  return manifest.surfaces.includes(surface);
}

export function createConnectorRegistry(input: {
  google?: GoogleConnectorConfig;
  github?: GitHubConnectorConfig;
  linear?: LinearConnectorConfig;
  notion?: NotionConnectorConfig;
  fetch?: typeof globalThis.fetch;
} = {}): ConnectorRegistry {
  const adapters: ConnectorAdapter[] = [
    createGenericWebhookConnector(),
    createWebMonitorConnector(input.fetch)
  ];
  if (input.google) adapters.push(createGoogleConnector(input.google));
  if (input.github) adapters.push(createGitHubConnector(input.github));
  if (input.linear) adapters.push(createLinearConnector(input.linear));
  if (input.notion) adapters.push(createNotionConnector(input.notion));
  return new ConnectorRegistry(adapters);
}

export class CredentialCipher {
  constructor(
    private readonly keyBytes: Uint8Array,
    readonly keyVersion: number
  ) {
    if (![16, 24, 32].includes(keyBytes.byteLength)) {
      throw new ConnectorError("invalid_configuration", "AES-GCM key must decode to 16, 24, or 32 bytes");
    }
  }

  static fromBase64(key: string, keyVersion = 1): CredentialCipher {
    return new CredentialCipher(base64ToBytes(key), keyVersion);
  }

  async encrypt(value: Record<string, unknown>, additionalData: string): Promise<{
    ciphertext: string;
    iv: string;
    algorithm: "AES-GCM";
    keyVersion: number;
  }> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cryptoKey = await crypto.subtle.importKey("raw", toArrayBuffer(this.keyBytes), "AES-GCM", false, ["encrypt"]);
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(iv),
        additionalData: toArrayBuffer(new TextEncoder().encode(additionalData))
      },
      cryptoKey,
      toArrayBuffer(new TextEncoder().encode(JSON.stringify(value)))
    );
    return {
      ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
      iv: bytesToBase64(iv),
      algorithm: "AES-GCM",
      keyVersion: this.keyVersion
    };
  }

  async decrypt(ciphertext: string, iv: string, additionalData: string): Promise<Record<string, unknown>> {
    const cryptoKey = await crypto.subtle.importKey("raw", toArrayBuffer(this.keyBytes), "AES-GCM", false, ["decrypt"]);
    try {
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: toArrayBuffer(base64ToBytes(iv)),
          additionalData: toArrayBuffer(new TextEncoder().encode(additionalData))
        },
        cryptoKey,
        toArrayBuffer(base64ToBytes(ciphertext))
      );
      return z.record(z.string(), z.unknown()).parse(JSON.parse(new TextDecoder().decode(plaintext)) as unknown);
    } catch (error) {
      throw new ConnectorError("unauthorized", "Stored connector credentials could not be decrypted", error);
    }
  }
}

async function assertSafePublicUrl(value: string): Promise<URL> {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new ConnectorError("unsafe_url", "Only HTTP and HTTPS URLs can be monitored");
  }
  if (url.username || url.password) {
    throw new ConnectorError("unsafe_url", "Monitored URLs cannot contain credentials");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".lan") ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".home.arpa") ||
    hostname === "metadata.google.internal" ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    hostname === "::" ||
    /^f[cd][0-9a-f]{2}:/u.test(hostname) ||
    /^fe[89ab][0-9a-f]:/u.test(hostname) ||
    /^::ffff:(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/u.test(hostname) ||
    /^127\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^169\.254\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  ) {
    throw new ConnectorError("unsafe_url", "Private and local network URLs are not allowed");
  }
  return url;
}

async function fetchWithSafeRedirects(
  initialUrl: URL,
  fetcher: typeof globalThis.fetch,
  init: RequestInit,
  maxRedirects = 5
): Promise<{ response: Response; finalUrl: URL }> {
  let current = initialUrl;
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    current = await assertSafePublicUrl(current.toString());
    const response = await fetcher(current, { ...init, redirect: "manual" });
    if (response.status < 300 || response.status >= 400) return { response, finalUrl: current };
    const location = response.headers.get("location");
    if (!location) throw new ConnectorError("provider_error", "Monitored page returned a redirect without a location");
    if (redirectCount === maxRedirects) {
      throw new ConnectorError("provider_error", `Monitored page exceeded ${maxRedirects} redirects`);
    }
    current = new URL(location, current);
  }
  throw new ConnectorError("provider_error", "Monitored page redirect could not be resolved");
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new ConnectorError("payload_too_large", `Response exceeds ${maxBytes} bytes`);
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ConnectorError("payload_too_large", `Response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function extractReadableText(html: string): string {
  return decodeHtml(
    html
      .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[^]*?-->/g, " ")
      .replace(/<\/?(p|div|article|section|main|header|footer|li|h[1-6]|br)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function decodeHtml(value: string): string {
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " "
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const hexadecimal = entity[1]?.toLowerCase() === "x";
      const code = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return entities[entity.toLowerCase()] ?? match;
  });
}

function serializeEmail(input: z.infer<typeof EmailArgsSchema>): string {
  const headers = [
    `To: ${input.to.join(", ")}`,
    ...(input.cc.length > 0 ? [`Cc: ${input.cc.join(", ")}`] : []),
    `Subject: ${encodeHeader(input.subject)}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`] : []),
    ...(input.inReplyTo
      ? [`References: ${[...input.references, input.inReplyTo]
          .filter((value, index, values) => values.indexOf(value) === index)
          .join(" ")}`]
      : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit"
  ];
  return `${headers.join("\r\n")}\r\n\r\n${input.body}`;
}

function encodeHeader(value: string): string {
  return /^[\x20-\x7E]*$/.test(value)
    ? value.replace(/[\r\n]/g, " ")
    : `=?UTF-8?B?${bytesToBase64(new TextEncoder().encode(value.replace(/[\r\n]/g, " ")))}?=`;
}

function base64Url(value: string): string {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const unpadded = value.replace(/-/g, "+").replace(/_/g, "/");
  const normalized = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, "=");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function readString(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  const nested = (value as Record<string, unknown>)[key];
  return typeof nested === "string" ? nested : null;
}

function readNestedString(value: unknown, parent: string, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  return readString((value as Record<string, unknown>)[parent], key);
}

function readNestedNumber(value: unknown, parent: string, key: string): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const nested = readRecord(value as Record<string, unknown>, parent);
  return nested ? readNumber(nested, key) : null;
}

function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export const __testing = {
  constantTimeEqual,
  extractReadableText,
  hmacHex,
  serializeEmail
};
