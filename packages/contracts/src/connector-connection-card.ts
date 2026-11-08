import { z } from "zod";

export const ConnectorConnectionCardScopes = ["personal", "workspace"] as const;
export type ConnectorConnectionCardScope = (typeof ConnectorConnectionCardScopes)[number];

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
    capabilityPrefixes: ["gmail.", "calendar."],
    iconName: "google",
    providerType: "google",
    scopes: ["personal"],
  },
  "google-drive": {
    label: "Google Drive",
    capabilityPrefixes: ["drive.", "docs.", "sheets."],
    iconName: "google-drive",
    providerType: "google",
    scopes: ["personal", "workspace"],
  },
  github: { label: "GitHub", capabilityPrefixes: [], iconName: "github", providerType: "github", scopes: ["personal", "workspace"] },
  apollo: { label: "Apollo", capabilityPrefixes: [], iconName: "apollo", providerType: "apollo", scopes: ["personal"] },
  ashby: { label: "Ashby", capabilityPrefixes: [], iconName: "ashby", providerType: "ashby", scopes: ["personal"] },
  canva: { label: "Canva", capabilityPrefixes: [], iconName: "canva", providerType: "canva", scopes: ["personal"] },
  // Personal only, like Ashby and Granola: the workspace scope is an
  // administrator pasting a key into Settings, which is not something a card in
  // a transcript can offer a participant.
  fireflies: { label: "Fireflies", capabilityPrefixes: [], iconName: "fireflies", providerType: "fireflies", scopes: ["personal"] },
  granola: { label: "Granola", capabilityPrefixes: [], iconName: "granola", providerType: "granola", scopes: ["personal"] },
  linear: { label: "Linear", capabilityPrefixes: [], iconName: "linear", providerType: "linear", scopes: ["personal", "workspace"] },
  slack: { label: "Slack", capabilityPrefixes: [], iconName: "slack", providerType: "slack", scopes: ["personal", "workspace"] },
  notion: { label: "Notion", capabilityPrefixes: [], iconName: "notion", providerType: "notion", scopes: ["personal", "workspace"] },
} as const satisfies Record<string, {
  /** The name a question asking for this connection says, in product case. */
  label: string;
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

export const ConnectorConnectionStateResultSchema = z.strictObject({
  connectorId: z.enum(ConnectorConnectionCardIds),
  /** The best state across `connections`: connected if any scope is. */
  state: ConnectorConnectionStateSchema,
  connections: z.array(z.strictObject({
    scope: z.enum(ConnectorConnectionCardScopes),
    state: ConnectorConnectionStateSchema,
  })).min(1),
});
export type ConnectorConnectionStateResult = z.infer<typeof ConnectorConnectionStateResultSchema>;

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
