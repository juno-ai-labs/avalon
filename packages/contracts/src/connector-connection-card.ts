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

const ConnectorConnectionCardShape = z.strictObject({
  connectorId: z.enum(ConnectorConnectionCardIds).describe(
    "Connector to check or show. Use one listed value.",
  ),
  scope: z.enum(ConnectorConnectionCardScopes).describe(
    "Use personal for the current user's account. Use workspace for the shared workspace account.",
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
]);
export const ConnectorConnectionStateResultSchema = z.strictObject({
  connectorId: z.enum(ConnectorConnectionCardIds),
  scope: z.enum(ConnectorConnectionCardScopes),
  state: ConnectorConnectionStateSchema,
});
export type ConnectorConnectionStateResult = z.infer<typeof ConnectorConnectionStateResultSchema>;

/** The canonical definition name; Bind adds the `core_` wire prefix. */
export const CONNECTOR_CONNECTION_CARD_TOOL_NAME = "show_connector_connection";
export const CONNECTOR_CONNECTION_CARD_WIRE_NAME = `core_${CONNECTOR_CONNECTION_CARD_TOOL_NAME}`;
export const CONNECTOR_CONNECTION_STATE_TOOL_NAME = "get_connector_connection_state";
export const CONNECTOR_CONNECTION_STATE_WIRE_NAME = `core_${CONNECTOR_CONNECTION_STATE_TOOL_NAME}`;

/**
 * Recover a card selection from a completed durable tool event.
 *
 * New terminal facts carry the validated selection as structured output. The
 * input remains useful for live events, while the exact generated summary is a
 * compatibility path for facts written before terminal output was retained.
 */
export function connectorConnectionCardInputFromToolEvent(event: {
  name: string;
  input?: unknown;
  output?: unknown;
  summary?: string;
  status?: string;
} | undefined): ConnectorConnectionCardInput | null {
  if (event?.name !== CONNECTOR_CONNECTION_CARD_WIRE_NAME || event.status !== "completed") return null;
  for (const candidate of [event.input, event.output]) {
    const parsed = ConnectorConnectionCardInputSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  for (const connectorId of ConnectorConnectionCardIds) {
    for (const scope of ConnectorConnectionCardScopes) {
      if (event.summary !== `Presented the ${connectorId} ${scope} connection card`) continue;
      const parsed = ConnectorConnectionCardInputSchema.safeParse({ connectorId, scope });
      if (parsed.success) return parsed.data;
    }
  }
  return null;
}
