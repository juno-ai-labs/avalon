import { z } from "zod";

import {
  ConnectorProductCatalog,
  ConnectorProductIds,
  ConnectorScopes,
  ConnectorConnectionStateSchema,
  ConnectorProductStateSchema,
  connectorProductStateSummary,
  type ConnectorProductId,
  type ConnectorProductState,
  type ConnectorScope,
} from "./connector-catalog";

export const ConnectorConnectionCardScopes = ConnectorScopes;
export type ConnectorConnectionCardScope = ConnectorScope;

/**
 * The products a card in a conversation can connect: those with a card scope
 * in `ConnectorProductCatalog`. The model-visible enum and the card's scope
 * check derive from it; a product connected only in Settings has no card id.
 */
export type ConnectorConnectionCardId = {
  [Id in ConnectorProductId]: (typeof ConnectorProductCatalog)[Id]["cardScopes"] extends readonly [] ? never : Id
}[ConnectorProductId];

export const ConnectorConnectionCardIds = ConnectorProductIds.filter((id) =>
  ConnectorProductCatalog[id].cardScopes.length > 0) as [ConnectorConnectionCardId, ...ConnectorConnectionCardId[]];

function cardScopes(id: ConnectorConnectionCardId): readonly ConnectorScope[] {
  return ConnectorProductCatalog[id].cardScopes;
}

/**
 * The answer to a question a connection answers (`Elicitation.connection`)
 * that says the connection is made. The question's card sends it for the
 * person when the connection it shows becomes connected.
 */
export const CONNECTION_QUESTION_CONTINUE_ANSWER = "continue";

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
    const entry = ConnectorProductCatalog[connectorId];
    return entry.providerType === connectorType && (entry.cardScopes as readonly string[]).includes("personal");
  });
  if (connectorType !== "google") return cards.length === 1 ? cards[0]! : null;
  const prefixes = new Set(eventTypes.map((eventType) => googleActivityCapability(eventType).split(".")[0]! + "."));
  const covering = cards.filter((connectorId) =>
    [...prefixes].every((prefix) => (ConnectorProductCatalog[connectorId].capabilityPrefixes as readonly string[]).includes(prefix)));
  return covering.length === 1 ? covering[0]! : null;
}

const personalOnlyConnectorIds = ConnectorConnectionCardIds.filter((connectorId) =>
  !cardScopes(connectorId).includes("workspace"));
const personalOrWorkspaceConnectorIds = ConnectorConnectionCardIds.filter((connectorId) =>
  cardScopes(connectorId).includes("workspace"));

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
    if (cardScopes(input.connectorId).includes(input.scope)) return;
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

/** `list_connectors` takes nothing: the whole catalog is a dozen rows. */
export const ConnectorListInputSchema = z.strictObject({});

/** The state check answers with the product's state, as each row of the connector list does. */
export const ConnectorConnectionStateResultSchema = ConnectorProductStateSchema;
export type ConnectorConnectionStateResult = ConnectorProductState;
export const connectorConnectionStateSummary = connectorProductStateSummary;
export { ConnectorConnectionStateSchema };

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
