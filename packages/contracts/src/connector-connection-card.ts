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
    capabilityPrefixes: ["gmail.", "calendar."],
    iconName: "google",
    providerType: "google",
    scopes: ["personal"],
  },
  "google-drive-workspace": {
    capabilityPrefixes: ["drive.", "docs.", "sheets."],
    iconName: "google-drive",
    providerType: "google",
    scopes: ["personal", "workspace"],
  },
  github: { capabilityPrefixes: [], iconName: "github", providerType: "github", scopes: ["personal", "workspace"] },
  ashby: { capabilityPrefixes: [], iconName: "ashby", providerType: "ashby", scopes: ["personal"] },
  canva: { capabilityPrefixes: [], iconName: "canva", providerType: "canva", scopes: ["personal"] },
  // Personal only, like Ashby and Granola: the workspace scope is an
  // administrator pasting a key into Settings, which is not something a card in
  // a transcript can offer a participant.
  fireflies: { capabilityPrefixes: [], iconName: "fireflies", providerType: "fireflies", scopes: ["personal"] },
  granola: { capabilityPrefixes: [], iconName: "granola", providerType: "granola", scopes: ["personal"] },
  linear: { capabilityPrefixes: [], iconName: "linear", providerType: "linear", scopes: ["personal", "workspace"] },
  slack: { capabilityPrefixes: [], iconName: "slack", providerType: "slack", scopes: ["personal", "workspace"] },
  notion: { capabilityPrefixes: [], iconName: "notion", providerType: "notion", scopes: ["personal", "workspace"] },
} as const satisfies Record<string, {
  capabilityPrefixes: readonly string[];
  iconName: string;
  providerType: string;
  scopes: readonly ConnectorConnectionCardScope[];
}>;

export type ConnectorConnectionCardId = keyof typeof ConnectorConnectionCardCatalog;
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
    `Connector to check or show. Personal only: ${personalOnlyConnectorIds.join(", ")}. Personal or workspace: ${personalOrWorkspaceConnectorIds.join(", ")}.`,
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

export const ConnectorConnectionStateSchema = z.enum([
  "connected",
  "reconnect_required",
  "not_connected",
  "unavailable",
]);
export const ConnectorConnectionStateResultSchema = z.strictObject({
  connectorId: z.enum(ConnectorConnectionCardIds),
  scope: z.enum(ConnectorConnectionCardScopes),
  state: ConnectorConnectionStateSchema,
});
export type ConnectorConnectionStateResult = z.infer<typeof ConnectorConnectionStateResultSchema>;

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
    const parsed = ConnectorConnectionCardInputSchema.safeParse(candidate);
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
  return null;
}
