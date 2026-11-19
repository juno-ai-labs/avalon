import { z } from "zod";

import { ORGANIZATION_MODEL_NAMES, modelEnum, modelName, withModelNames } from "./model-names";
import {
  ConnectorProductCatalog,
  ConnectorProductIds,
  ConnectorScopes,
  type ConnectorProductId,
  type ConnectorScope,
} from "./connector-catalog";

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
    `Connector to check or show. Personal only: ${personalOnlyConnectorIds.join(", ")}. Personal or organization: ${personalOrWorkspaceConnectorIds.join(", ")}.`
    + " google-drive is Google Drive, Docs and Sheets.",
  ),
  // The Organization's scope is stored as `workspace`. A model reads and
  // writes `organization`; a stored event's input may hold either spelling.
  scope: modelEnum(ConnectorScopes, ORGANIZATION_MODEL_NAMES).describe(
    "Use personal for the current user's account. Use organization, the Organization's shared account, only for an id described as personal or organization.",
  ),
});

export const ConnectorConnectionCardInputSchema = ConnectorConnectionCardShape.superRefine(
  (input, context) => {
    if (cardScopes(input.connectorId).includes(input.scope)) return;
    context.addIssue({
      code: "custom",
      path: ["scope"],
      message: `${input.connectorId} has no ${modelName(ORGANIZATION_MODEL_NAMES, input.scope)} connection card`,
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
 * What the state check accepts: a connector, and nothing else.
 *
 * The check always covers every scope the connector offers, so it takes no
 * scope. It once accepted one and ignored it: models asked to pick a scope
 * picked the workspace one for people whose personal Drive was connected, read
 * `not_connected`, and asked them to connect what they had. A scope it is sent
 * now fails as an unrecognized key, rather than being silently dropped.
 */
export const ConnectorConnectionStateInputSchema = z.strictObject({
  // Every product, not only those with a card: `list_connectors` returns all
  // of them, and a model checking one it listed must not be refused.
  connectorId: z.enum(ConnectorProductIds).describe(
    "Connector to check: any connectorId list_connectors returns. google-drive is Google Drive, Docs and Sheets. Every scope it offers is checked.",
  ),
});
export type ConnectorConnectionStateInput = z.infer<typeof ConnectorConnectionStateInputSchema>;

/** `list_connectors` takes nothing: the whole catalog is a dozen rows. */
export const ConnectorListInputSchema = z.strictObject({});

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

/**
 * A connector result as a model reads it: every `scope` that is the stored
 * `workspace` reads `organization`. The states, the list and the card are
 * built by code the product's screens share, so they hold stored scopes.
 */
export function connectorScopesForModel<T>(result: T): T {
  return withModelNames(result, ORGANIZATION_MODEL_NAMES, ["scope"]);
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
    for (const scope of ConnectorScopes) {
      const candidate = { connectorId, scope };
      if (event.summary !== connectorConnectionCardSummary(candidate)) continue;
      const parsed = ConnectorConnectionCardInputSchema.safeParse(candidate);
      if (parsed.success) return parsed.data;
    }
  }
  for (const scope of ConnectorScopes) {
    if (event.summary === `Presented the ${LEGACY_GOOGLE_DRIVE_CARD_ID} ${scope} connection card`) {
      return { connectorId: "google-drive", scope };
    }
  }
  return null;
}
