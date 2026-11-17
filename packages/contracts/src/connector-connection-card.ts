import { z } from "zod";

export const ConnectorConnectionCardScopes = ["personal", "workspace"] as const;
export type ConnectorConnectionCardScope = (typeof ConnectorConnectionCardScopes)[number];

/**
 * What kind of work a connector serves, so an agent asked for something can
 * find the connectors that would help with it, connected or not.
 *
 * A family names a job a person has, not a provider: Linear and GitHub both
 * track issues. Order here is the order `list_connectors` returns them in. A
 * family is added with its first connector; none is listed empty.
 */
export const ConnectorFamilyCatalog = {
  email_calendar: { label: "Email and calendar" },
  file_storage: { label: "File storage" },
  documents_wikis: { label: "Documents and wikis" },
  team_chat: { label: "Team chat" },
  issue_tracking: { label: "Issue tracking and projects" },
  code: { label: "Code" },
  meeting_notes: { label: "Meeting notes" },
  sales: { label: "Sales and prospecting" },
  recruiting: { label: "Recruiting" },
  design: { label: "Design" },
} as const satisfies Record<string, { label: string }>;

export type ConnectorFamily = keyof typeof ConnectorFamilyCatalog;
export const ConnectorFamilies = Object.keys(ConnectorFamilyCatalog) as [ConnectorFamily, ...ConnectorFamily[]];

/**
 * Stable catalog entries the agent may ask the main feed to present.
 *
 * These are product identities, not OAuth providers: Google has two cards with
 * different capability grants, while both authorize through the same provider.
 * Keeping valid scopes beside each identity makes this the one non-UI catalog
 * from which the model-visible enum and cross-field validation are derived.
 */
export const ConnectorConnectionCardCatalog = {
  "google-mail-calendar": {
    label: "Gmail and Google Calendar",
    families: ["email_calendar"],
    capabilityPrefixes: ["gmail.", "calendar."],
    iconName: "google",
    providerType: "google",
    scopes: ["personal"],
  },
  "google-drive": {
    label: "Google Drive",
    families: ["file_storage", "documents_wikis"],
    capabilityPrefixes: ["drive.", "docs.", "sheets."],
    iconName: "google-drive",
    providerType: "google",
    scopes: ["personal", "workspace"],
  },
  github: { label: "GitHub", families: ["code", "issue_tracking"], capabilityPrefixes: [], iconName: "github", providerType: "github", scopes: ["personal", "workspace"] },
  apollo: { label: "Apollo", families: ["sales"], capabilityPrefixes: [], iconName: "apollo", providerType: "apollo", scopes: ["personal"] },
  ashby: { label: "Ashby", families: ["recruiting"], capabilityPrefixes: [], iconName: "ashby", providerType: "ashby", scopes: ["personal"] },
  canva: { label: "Canva", families: ["design"], capabilityPrefixes: [], iconName: "canva", providerType: "canva", scopes: ["personal"] },
  // Personal only, like Ashby and Granola: the workspace scope is an
  // administrator pasting a key into Settings, which is not something a card in
  // a transcript can offer a participant.
  fireflies: { label: "Fireflies", families: ["meeting_notes"], capabilityPrefixes: [], iconName: "fireflies", providerType: "fireflies", scopes: ["personal"] },
  granola: { label: "Granola", families: ["meeting_notes"], capabilityPrefixes: [], iconName: "granola", providerType: "granola", scopes: ["personal"] },
  linear: { label: "Linear", families: ["issue_tracking"], capabilityPrefixes: [], iconName: "linear", providerType: "linear", scopes: ["personal", "workspace"] },
  slack: { label: "Slack", families: ["team_chat"], capabilityPrefixes: [], iconName: "slack", providerType: "slack", scopes: ["personal", "workspace"] },
  notion: { label: "Notion", families: ["documents_wikis"], capabilityPrefixes: [], iconName: "notion", providerType: "notion", scopes: ["personal", "workspace"] },
} as const satisfies Record<string, {
  /** The name a question asking for this connection says, in product case. */
  label: string;
  /** What it is for, most fitting first; see `ConnectorFamilyCatalog`. */
  families: readonly [ConnectorFamily, ...ConnectorFamily[]];
  capabilityPrefixes: readonly string[];
  iconName: string;
  providerType: string;
  scopes: readonly ConnectorConnectionCardScope[];
}>;

export type ConnectorConnectionCardId = keyof typeof ConnectorConnectionCardCatalog;

/**
 * The answer to a question a connection answers (`Elicitation.connection`)
 * that says the connection is made. The question's card sends it for the
 * person when the connection it shows becomes connected.
 */
export const CONNECTION_QUESTION_CONTINUE_ANSWER = "continue";
export type ConnectorConnectionCardIconName = (typeof ConnectorConnectionCardCatalog)[ConnectorConnectionCardId]["iconName"];

export const ConnectorConnectionCardIds = Object.keys(ConnectorConnectionCardCatalog) as [
  ConnectorConnectionCardId,
  ...ConnectorConnectionCardId[],
];

/**
 * The grant a Google connection needs to carry one of its activity events.
 * Google is one connector type with two connections (Mail and Calendar;
 * Drive, Docs and Sheets), and which one announces an event is which grant
 * it holds. Docs and Sheets changes arrive through the Drive polling stream.
 */
export function googleActivityCapability(eventType: string): "gmail.read" | "calendar.read" | "drive.read" {
  return eventType.startsWith("email.") ? "gmail.read" : eventType.startsWith("calendar.") ? "calendar.read" : "drive.read";
}

/**
 * The personal connection card that connects or reconnects the account a
 * connector's events come from, for a person asked to let those events in
 * (`docs/sidekick-sources.md`). Null when no card can make that connection
 * here (a webhook, X, a custom MCP server), or when the events span both
 * Google connections, which no one card answers.
 */
export function sourceConnectionCardId(connectorType: string, eventTypes: readonly string[]): ConnectorConnectionCardId | null {
  const cards = ConnectorConnectionCardIds.filter((connectorId) => {
    const entry = ConnectorConnectionCardCatalog[connectorId];
    return entry.providerType === connectorType && (entry.scopes as readonly string[]).includes("personal");
  });
  if (connectorType !== "google") return cards.length === 1 ? cards[0]! : null;
  const prefixes = new Set(eventTypes.map((eventType) => googleActivityCapability(eventType).split(".")[0]! + "."));
  const covering = cards.filter((connectorId) =>
    [...prefixes].every((prefix) => (ConnectorConnectionCardCatalog[connectorId].capabilityPrefixes as readonly string[]).includes(prefix)));
  return covering.length === 1 ? covering[0]! : null;
}

const personalOnlyConnectorIds = ConnectorConnectionCardIds.filter((connectorId) =>
  !ConnectorConnectionCardCatalog[connectorId].scopes.includes("workspace" as never));
const personalOrWorkspaceConnectorIds = ConnectorConnectionCardIds.filter((connectorId) =>
  ConnectorConnectionCardCatalog[connectorId].scopes.includes("workspace" as never));

const ConnectorConnectionCardShape = z.strictObject({
  connectorId: z.enum(ConnectorConnectionCardIds).describe(
    `Connector to check or show. Personal only: ${personalOnlyConnectorIds.join(", ")}. Personal or workspace: ${personalOrWorkspaceConnectorIds.join(", ")}.`
    + " google-drive is Google Drive, Docs and Sheets.",
  ),
  scope: z.enum(ConnectorConnectionCardScopes).describe(
    "Use personal for the current user's account. Use workspace only for an id described as personal or workspace.",
  ),
});

export const ConnectorConnectionCardInputSchema = ConnectorConnectionCardShape.superRefine(
  (input, context) => {
    const supportedScopes: readonly ConnectorConnectionCardScope[] = ConnectorConnectionCardCatalog[input.connectorId].scopes;
    if (supportedScopes.includes(input.scope)) return;
    context.addIssue({
      code: "custom",
      path: ["scope"],
      message: `${input.connectorId} does not support a ${input.scope} connection card`,
    });
  },
);

export type ConnectorConnectionCardInput = z.infer<typeof ConnectorConnectionCardInputSchema>;

// Read old transcript cards without advertising the retired id to the model.
const LEGACY_GOOGLE_DRIVE_CARD_ID = "google-drive-workspace";
const StoredConnectorConnectionCardInputSchema = z.union([
  ConnectorConnectionCardInputSchema,
  ConnectorConnectionCardShape.extend({ connectorId: z.literal(LEGACY_GOOGLE_DRIVE_CARD_ID) })
    .transform((input): ConnectorConnectionCardInput => ({ connectorId: "google-drive", scope: input.scope })),
]);

export const ConnectorConnectionStateSchema = z.enum([
  "connected",
  "reconnect_required",
  "not_connected",
  "unavailable",
]);
/**
 * What the state check accepts: the card's selection with the scope optional.
 *
 * The check always covers every scope the connector offers, so `scope` is
 * accepted only so calls written before that still validate. Models asked to
 * pick one picked the workspace scope for people whose personal Drive was
 * connected, read `not_connected`, and asked them to connect what they had;
 * honoring an explicit scope let that happen again whenever a model named one.
 */
export const ConnectorConnectionStateInputSchema = z.strictObject({
  connectorId: ConnectorConnectionCardShape.shape.connectorId,
  scope: z.enum(ConnectorConnectionCardScopes).optional().describe(
    "Leave out. Every scope this connector offers is checked whatever is sent.",
  ),
});
export type ConnectorConnectionStateInput = z.infer<typeof ConnectorConnectionStateInputSchema>;

/**
 * One saved connection the caller can use: the person's own, or the
 * Organization's. `account` is which account it is (an email, a handle, a team)
 * as the connection's name in Settings shows it, or null when that name carries
 * none.
 */
export const ConnectorConnectionAccountSchema = z.strictObject({
  scope: z.enum(ConnectorConnectionCardScopes),
  state: z.enum(["connected", "reconnect_required"]),
  account: z.string().nullable(),
});
export type ConnectorConnectionAccount = z.infer<typeof ConnectorConnectionAccountSchema>;

export const ConnectorConnectionStateResultSchema = z.strictObject({
  connectorId: z.enum(ConnectorConnectionCardIds),
  /** The best state across `connections`: connected if any scope is. */
  state: ConnectorConnectionStateSchema,
  connections: z.array(z.strictObject({
    scope: z.enum(ConnectorConnectionCardScopes),
    state: ConnectorConnectionStateSchema,
  })).min(1),
  /** Every saved connection behind `connections`; a person may hold two Google accounts. */
  accounts: z.array(ConnectorConnectionAccountSchema),
});
export type ConnectorConnectionStateResult = z.infer<typeof ConnectorConnectionStateResultSchema>;

/** `list_connectors` takes nothing: the whole catalog is a dozen rows. */
export const ConnectorListInputSchema = z.strictObject({});

export const ConnectorListResultSchema = z.strictObject({
  families: z.array(z.strictObject({
    family: z.enum(ConnectorFamilies),
    label: z.string(),
    connectors: z.array(ConnectorConnectionStateResultSchema.extend({ label: z.string() })).min(1),
  })),
});
export type ConnectorListResult = z.infer<typeof ConnectorListResultSchema>;

/**
 * Group per-connector states by family, in catalog order. A connector in two
 * families appears in both, so a model reading one family sees all it needs.
 */
export function groupConnectorsByFamily(states: readonly ConnectorConnectionStateResult[]): ConnectorListResult {
  return {
    families: ConnectorFamilies.flatMap((family) => {
      const connectors = states
        .filter((state) => (ConnectorConnectionCardCatalog[state.connectorId].families as readonly ConnectorFamily[]).includes(family))
        .map((state) => ({ ...state, label: ConnectorConnectionCardCatalog[state.connectorId].label }));
      return connectors.length === 0 ? [] : [{ family, label: ConnectorFamilyCatalog[family].label, connectors }];
    }),
  };
}

export function connectorListSummary(result: ConnectorListResult): string {
  const connected = new Set(result.families.flatMap(({ connectors }) =>
    connectors.filter(({ state }) => state === "connected").map(({ connectorId }) => connectorId)));
  return `Listed connectors in ${result.families.length} families; connected: ${connected.size === 0 ? "none" : [...connected].join(", ")}`;
}

/**
 * Which account a saved connection is, from its name. Every connector names a
 * connection `<product> · <account>` (`Google Mail + Calendar · ada@example.com`,
 * `GitHub · octo-org`); one with no separator, such as `Canva`, names none.
 */
export function connectorConnectionAccountLabel(displayName: string): string | null {
  const separator = displayName.indexOf(" · ");
  if (separator < 0) return null;
  const account = displayName.slice(separator + 3).trim();
  return account.length > 0 ? account : null;
}

const STATE_PRECEDENCE = ["connected", "reconnect_required", "not_connected", "unavailable"] as const;

/** Fold per-scope states into the one a caller acts on first. */
export function bestConnectorConnectionState(
  states: readonly z.infer<typeof ConnectorConnectionStateSchema>[],
): z.infer<typeof ConnectorConnectionStateSchema> {
  return STATE_PRECEDENCE.find((state) => states.includes(state)) ?? "not_connected";
}

export function connectorConnectionStateSummary(result: ConnectorConnectionStateResult): string {
  return `${result.connectorId}: ${result.connections.map(({ scope, state }) => `${scope} ${state}`).join(", ")}`;
}

/**
 * The canonical definition names, which are also the model-facing wire names:
 * `rally:core` carries no wire prefix, so Bind advertises these unchanged.
 */
export const CONNECTOR_CONNECTION_CARD_TOOL_NAME = "show_connector_connection";
export const CONNECTOR_CONNECTION_CARD_WIRE_NAME = CONNECTOR_CONNECTION_CARD_TOOL_NAME;
export const CONNECTOR_CONNECTION_STATE_TOOL_NAME = "get_connector_connection_state";
export const CONNECTOR_CONNECTION_STATE_WIRE_NAME = CONNECTOR_CONNECTION_STATE_TOOL_NAME;
export const CONNECTOR_LIST_TOOL_NAME = "list_connectors";

/**
 * What every card row written before the prefix was dropped still carries. A
 * durable tool event stores the wire name it was called under, so recognizing
 * a card is a match against both names for as long as those rows exist —
 * matching only the current one silently turns every historical card back into
 * a plain tool row.
 */
export const LEGACY_CONNECTOR_CONNECTION_CARD_WIRE_NAME = `core_${CONNECTOR_CONNECTION_CARD_TOOL_NAME}`;
export const LEGACY_CONNECTOR_CONNECTION_STATE_WIRE_NAME = `core_${CONNECTOR_CONNECTION_STATE_TOOL_NAME}`;

/**
 * True for either name a connector card row may have been stored under.
 *
 * This is one-directional, and deliberately so: a client built after the rename
 * renders a card from either spelling, but a client built *before* it compares
 * against the old constant alone and will read a new `show_connector_connection`
 * row as ordinary tool activity — the row still says "Prepared a connector",
 * without the Connect button beside it. Nothing in the renderer can close that;
 * only shipping the desktop client ahead of the Worker can, so this is a release
 * sequencing constraint rather than a code one.
 */
export function isConnectorConnectionCardWireName(name: string | undefined): boolean {
  return name === CONNECTOR_CONNECTION_CARD_WIRE_NAME
    || name === LEGACY_CONNECTOR_CONNECTION_CARD_WIRE_NAME;
}

export function connectorConnectionCardSummary(input: ConnectorConnectionCardInput): string {
  return `Presented the ${input.connectorId} ${input.scope} connection card`;
}

/**
 * Recover a card selection from a completed durable tool event.
 *
 * The validated started-event input is carried forward into terminal facts.
 * The shared summary parser also covers summary-only interrupted-run recovery.
 */
export function connectorConnectionCardInputFromToolEvent(event: {
  name: string;
  input?: unknown;
  output?: unknown;
  summary?: string;
  status?: string;
} | undefined): ConnectorConnectionCardInput | null {
  if (!isConnectorConnectionCardWireName(event?.name) || event?.status !== "completed") return null;
  for (const candidate of [event.input, event.output]) {
    const parsed = StoredConnectorConnectionCardInputSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  for (const connectorId of ConnectorConnectionCardIds) {
    for (const scope of ConnectorConnectionCardScopes) {
      const candidate = { connectorId, scope };
      if (event.summary !== connectorConnectionCardSummary(candidate)) continue;
      const parsed = ConnectorConnectionCardInputSchema.safeParse(candidate);
      if (parsed.success) return parsed.data;
    }
  }
  for (const scope of ConnectorConnectionCardScopes) {
    if (event.summary === `Presented the ${LEGACY_GOOGLE_DRIVE_CARD_ID} ${scope} connection card`) {
      return { connectorId: "google-drive", scope };
    }
  }
  return null;
}

/** Authorization availability is separate from the last background operation's health. */
export function connectorAuthorizationStatus(status: string): "healthy" | "reconnect_required" | "disabled" {
  if (status === "needs_reconnect") return "reconnect_required";
  if (status === "disabled") return "disabled";
  return "healthy";
}
