import { z } from "zod";

/**
 * The connector product catalog: every connector a person can add to Rally,
 * as the product presents it. This is the one place that says what a product
 * is called, what it is for, which provider authorizes it, which scopes it is
 * offered in, which of those a card in a conversation can connect, and which of
 * a provider connection's grants belong to it. The connection card's ids, the
 * agent's connector list, Settings' Connections list, the transcript's
 * connector presentation, Google's per-product plugins and every connection's
 * stored name are views of it; none keeps a copy. See
 * docs/connectors.md#connector-products-and-families.
 *
 * A product is not a provider. Google is one provider and two products, split
 * by `capabilityPrefixes`; a product with no prefixes owns every grant of its
 * provider.
 */

export const ConnectorScopes = ["personal", "workspace"] as const;
export type ConnectorScope = (typeof ConnectorScopes)[number];

/**
 * What kind of work a connector serves, so an agent asked for something can
 * find the products that would help with it, connected or not.
 *
 * A family names a job a person has, not a provider: Linear and GitHub both
 * track issues. Order here is the order families are listed in. A family is
 * added with its first product; none is listed empty.
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
  social_media: { label: "Social media" },
  other: { label: "Custom tools and events" },
} as const satisfies Record<string, { label: string }>;

export type ConnectorFamily = keyof typeof ConnectorFamilyCatalog;
export const ConnectorFamilies = Object.keys(ConnectorFamilyCatalog) as [ConnectorFamily, ...ConnectorFamily[]];

type ConnectorProduct = {
  /** The product's name wherever a person reads it, and the first half of its connections' names. */
  name: string;
  /** One sentence on what it reaches; Settings' card, the transcript and the agent's list all show it. */
  description: string;
  /** What it is for, most fitting first; see `ConnectorFamilyCatalog`. */
  families: readonly [ConnectorFamily, ...ConnectorFamily[]];
  /** The stored `connector_type` that authorizes it. */
  providerType: string;
  /** The grants of a provider connection that belong to this product; empty means all of them. */
  capabilityPrefixes: readonly string[];
  /**
   * Grants Rally itself uses (events in, notices out) that give the agent no
   * tools: the manifest's capabilities of kind `host`, mirrored here and
   * checked against it when the registry is built. A connection holding only
   * these, such as Ashby's workspace events installation, is not a connection
   * the agent can use, so it does not count toward the product's state.
   */
  hostCapabilities?: readonly string[];
  /** Scopes the product is offered in at all. */
  scopes: readonly [ConnectorScope, ...ConnectorScope[]];
  /**
   * The subset a card in a conversation can connect. The rest are made in
   * Settings: an administrator pasting a key, or a server somebody configures.
   * A product with none has no card.
   */
  cardScopes: readonly ConnectorScope[];
  /**
   * What tells one of its connections from another. `account`: the provider
   * account the connection's name carries after ` · `. `name`: the whole name,
   * which a person typed (a custom server, a webhook).
   */
  instance: "account" | "name";
  /** A stable mark name for clients; null when the client draws its own. */
  iconName: string | null;
};

export const ConnectorProductCatalog = {
  "google-mail-calendar": {
    name: "Google Mail + Calendar",
    description: "Gmail messages, drafts, sent mail, and calendar events.",
    families: ["email_calendar"],
    providerType: "google",
    capabilityPrefixes: ["gmail.", "calendar."],
    scopes: ["personal"],
    cardScopes: ["personal"],
    instance: "account",
    iconName: "google",
  },
  "google-drive": {
    name: "Google Drive + Docs + Sheets",
    description: "Drive files, Google Docs, and Sheets content.",
    families: ["file_storage", "documents_wikis"],
    providerType: "google",
    capabilityPrefixes: ["drive.", "docs.", "sheets."],
    scopes: ["personal", "workspace"],
    cardScopes: ["personal", "workspace"],
    instance: "account",
    iconName: "google-drive",
  },
  github: {
    name: "GitHub",
    description: "Repositories, issues, pull requests, checks, and development events.",
    families: ["code", "issue_tracking"],
    providerType: "github",
    capabilityPrefixes: [],
    scopes: ["personal", "workspace"],
    cardScopes: ["personal", "workspace"],
    instance: "account",
    iconName: "github",
  },
  apollo: {
    name: "Apollo.io",
    description: "Prospects, companies, contact enrichment, lists, sequences, and sales tasks.",
    families: ["sales"],
    providerType: "apollo",
    capabilityPrefixes: [],
    scopes: ["personal"],
    cardScopes: ["personal"],
    instance: "account",
    iconName: "apollo",
  },
  ashby: {
    name: "Ashby",
    description: "Hiring, candidates, interviews, applicant tracking, and pipelines.",
    families: ["recruiting"],
    providerType: "ashby",
    capabilityPrefixes: [],
    // The workspace scope is an administrator pasting a key into Settings,
    // which a card in a transcript cannot offer a participant.
    scopes: ["personal", "workspace"],
    cardScopes: ["personal"],
    hostCapabilities: ["ashby.workspace.events"],
    instance: "account",
    iconName: "ashby",
  },

  fireflies: {
    name: "Fireflies",
    description: "Meeting transcripts, summaries, and the action items they name.",
    families: ["meeting_notes"],
    providerType: "fireflies",
    capabilityPrefixes: [],
    // Personal only. The workspace connection was one administrator's API key
    // that every member read through, so it handed the whole workspace every
    // meeting that key can see; the adapter still serves connections made
    // before that was withdrawn (`connectableScopes` in
    // `packages/connectors/src/fireflies.ts`).
    scopes: ["personal"],
    cardScopes: ["personal"],
    instance: "account",
    iconName: "fireflies",
  },
  granola: {
    name: "Granola",
    description: "Meeting notes, transcripts, and the context they capture.",
    families: ["meeting_notes"],
    providerType: "granola",
    capabilityPrefixes: [],
    scopes: ["personal", "workspace"],
    cardScopes: ["personal"],
    instance: "account",
    iconName: "granola",
  },
  linear: {
    name: "Linear",
    description: "Issues, projects, cycles, comments, and team activity.",
    families: ["issue_tracking"],
    providerType: "linear",
    capabilityPrefixes: [],
    scopes: ["personal", "workspace"],
    cardScopes: ["personal", "workspace"],
    instance: "account",
    iconName: "linear",
  },
  slack: {
    name: "Slack",
    description: "Messages, files, people, canvases, and conversations.",
    families: ["team_chat"],
    providerType: "slack",
    capabilityPrefixes: [],
    scopes: ["personal", "workspace"],
    cardScopes: ["personal", "workspace"],
    hostCapabilities: ["slack.notifications.write"],
    instance: "account",
    iconName: "slack",
  },
  notion: {
    name: "Notion",
    description: "Pages, databases, comments, and change notifications.",
    families: ["documents_wikis"],
    providerType: "notion",
    capabilityPrefixes: [],
    scopes: ["personal", "workspace"],
    cardScopes: ["personal", "workspace"],
    instance: "account",
    iconName: "notion",
  },
  x: {
    name: "Public X via TwitterAPI.io",
    description: "Public X timelines, threads, replies, and Lists, read-only.",
    families: ["social_media"],
    providerType: "x",
    capabilityPrefixes: [],
    scopes: ["workspace"],
    cardScopes: [],
    instance: "account",
    iconName: "x",
  },
  "custom-mcp": {
    name: "Custom MCP server",
    description: "Any Model Context Protocol server, connected by URL.",
    families: ["other"],
    providerType: "custom_mcp",
    capabilityPrefixes: [],
    scopes: ["personal", "workspace"],
    cardScopes: [],
    instance: "name",
    iconName: "model-context-protocol",
  },
  "generic-webhook": {
    name: "Inbound webhook",
    description: "Signed inbound activity from systems without a native connector.",
    families: ["other"],
    providerType: "generic_webhook",
    capabilityPrefixes: [],
    scopes: ["personal", "workspace"],
    cardScopes: [],
    instance: "name",
    iconName: null,
  },
} as const satisfies Record<string, ConnectorProduct>;

export type ConnectorProductId = keyof typeof ConnectorProductCatalog;
export const ConnectorProductIds = Object.keys(ConnectorProductCatalog) as [ConnectorProductId, ...ConnectorProductId[]];

/**
 * Which products one provider connection serves: every product of its
 * provider whose prefixes match one of its grants. A Google connection granted
 * both mail and Drive serves both; one granted neither serves none.
 */
export function connectorProductsForConnection(connection: {
  connectorType: string;
  capabilities: readonly string[];
}): ConnectorProductId[] {
  return ConnectorProductIds.filter((id) => connectorConnectionServesProduct(id, connection));
}

export function connectorConnectionServesProduct(
  id: ConnectorProductId,
  connection: { connectorType: string; capabilities: readonly string[] },
): boolean {
  const product: ConnectorProduct = ConnectorProductCatalog[id];
  if (product.providerType !== connection.connectorType) return false;
  if (product.capabilityPrefixes.length === 0) return true;
  return connection.capabilities.some((capability) =>
    product.capabilityPrefixes.some((prefix) => capability.startsWith(prefix)));
}

/**
 * The product half of a connection's stored name: the one product its grants
 * serve. A connection serving none or several (a Google grant of both mail and
 * Drive) is named after its provider, which the caller passes because a
 * provider's name is its manifest's, not the catalog's.
 */
export function connectorConnectionProductName(
  connection: { connectorType: string; capabilities: readonly string[] },
  providerName: string,
): string {
  const products = connectorProductsForConnection(connection);
  return products.length === 1 ? ConnectorProductCatalog[products[0]!].name : providerName;
}

const CONNECTION_NAME_SEPARATOR = " · ";
/** A connection's stored name is bounded where it is reserved; this is that bound. */
const CONNECTION_NAME_MAX_CHARS = 180;

/**
 * A connection's stored name: `<product> · <account>`, flattened and bounded.
 * `connectorConnectionAccount` is its inverse, so every producer goes through
 * here rather than spelling the separator itself.
 */
export function connectorConnectionName(product: string, account: string): string {
  return `${product}${CONNECTION_NAME_SEPARATOR}${account}`
    .replace(/\s+/gu, " ").trim().slice(0, CONNECTION_NAME_MAX_CHARS);
}

/**
 * Which instance a connection is, read from its stored name: the account after
 * the separator, or for a product whose connections a person names, the whole
 * name. Null when the name carries none (`Ashby workspace events`).
 */
export function connectorConnectionAccount(
  instance: ConnectorProduct["instance"],
  displayName: string,
): string | null {
  if (instance === "name") return displayName.trim() || null;
  const separator = displayName.indexOf(CONNECTION_NAME_SEPARATOR);
  if (separator < 0) return null;
  return displayName.slice(separator + CONNECTION_NAME_SEPARATOR.length).trim() || null;
}

/** Authorization availability is separate from the last background operation's health. */
export function connectorAuthorizationStatus(status: string): "healthy" | "reconnect_required" | "disabled" {
  if (status === "needs_reconnect") return "reconnect_required";
  if (status === "disabled") return "disabled";
  return "healthy";
}

export const ConnectorConnectionStateSchema = z.enum([
  "connected",
  "reconnect_required",
  "not_connected",
  "unavailable",
]);
export type ConnectorConnectionState = z.infer<typeof ConnectorConnectionStateSchema>;

const STATE_PRECEDENCE = ["connected", "reconnect_required", "not_connected", "unavailable"] as const;

/** Fold states into the one a caller acts on first. */
export function bestConnectorConnectionState(states: readonly ConnectorConnectionState[]): ConnectorConnectionState {
  return STATE_PRECEDENCE.find((state) => states.includes(state)) ?? "not_connected";
}

/**
 * One product's saved state for one caller. `connections` is one row per scope
 * the product is offered in, with where a missing one is made: `conversation`
 * when a card can connect it, `settings` otherwise. `accounts` is every saved
 * connection behind those rows; a person may hold two Google accounts.
 */
export const ConnectorProductStateSchema = z.strictObject({
  connectorId: z.enum(ConnectorProductIds),
  name: z.string(),
  description: z.string(),
  /** The best state across `connections`: connected if any scope is. */
  state: ConnectorConnectionStateSchema,
  connections: z.array(z.strictObject({
    scope: z.enum(ConnectorScopes),
    state: ConnectorConnectionStateSchema,
    connectIn: z.enum(["conversation", "settings"]),
  })).min(1),
  accounts: z.array(z.strictObject({
    scope: z.enum(ConnectorScopes),
    state: z.enum(["connected", "reconnect_required"]),
    account: z.string().nullable(),
  })),
});
export type ConnectorProductState = z.infer<typeof ConnectorProductStateSchema>;

/** A saved connection as the fold reads it; the caller has already narrowed it to what the caller may see. */
export type ConnectorConnectionRecord = {
  connectorType: string;
  scope: ConnectorScope;
  /** The stored status (`healthy`, `error`, `needs_reconnect`, `disabled`). */
  status: string;
  capabilities: readonly string[];
  displayName: string;
};

/**
 * Each product's state from the caller's saved connections. Pure: the caller
 * reads the rows and says which providers this deployment registers; a product
 * whose provider it does not is `unavailable` in every scope. Disabled
 * connections are not connections, nor is one holding only grants that give
 * the agent no tools (`hostCapabilities`). Every other saved connection counts,
 * even in a scope the product no longer offers for new ones.
 */
export function foldConnectorProductStates(
  productIds: readonly ConnectorProductId[],
  connections: readonly ConnectorConnectionRecord[],
  registeredProviderTypes: ReadonlySet<string>,
): ConnectorProductState[] {
  return productIds.map((connectorId) => {
    const product: ConnectorProduct = ConnectorProductCatalog[connectorId];
    const connectIn = (scope: ConnectorScope) =>
      product.cardScopes.includes(scope) ? "conversation" as const : "settings" as const;
    if (!registeredProviderTypes.has(product.providerType)) {
      return {
        connectorId,
        name: product.name,
        description: product.description,
        state: "unavailable",
        connections: product.scopes.map((scope) => ({ scope, state: "unavailable", connectIn: connectIn(scope) })),
        accounts: [],
      };
    }
    const accounts = connections.flatMap((connection) => {
      const authorization = connectorAuthorizationStatus(connection.status);
      if (authorization === "disabled") return [];
      const host: readonly string[] = product.hostCapabilities ?? [];
      if (connection.capabilities.length > 0 && connection.capabilities.every((capability) => host.includes(capability))) return [];
      if (!connectorConnectionServesProduct(connectorId, connection)) return [];
      return [{
        scope: connection.scope,
        state: authorization === "reconnect_required" ? "reconnect_required" as const : "connected" as const,
        account: connectorConnectionAccount(product.instance, connection.displayName),
      }];
    });
    // Offered scopes, plus any scope a saved connection still holds: a scope
    // closed to new connections (a Fireflies workspace key) keeps the ones
    // made before, and they still work.
    const scopes = ConnectorScopes.filter((scope) =>
      (product.scopes as readonly ConnectorScope[]).includes(scope) || accounts.some((account) => account.scope === scope));
    const scopeStates = scopes.map((scope) => {
      const states = accounts.filter((account) => account.scope === scope).map(({ state }) => state);
      return {
        scope,
        state: states.length === 0 ? "not_connected" as const : bestConnectorConnectionState(states),
        connectIn: connectIn(scope),
      };
    });
    return {
      connectorId,
      name: product.name,
      description: product.description,
      state: bestConnectorConnectionState(scopeStates.map(({ state }) => state)),
      connections: scopeStates,
      accounts,
    };
  });
}

export function connectorProductStateSummary(state: ConnectorProductState): string {
  return `${state.connectorId}: ${state.connections.map(({ scope, state }) => `${scope} ${state}`).join(", ")}`;
}

export const ConnectorListResultSchema = z.strictObject({
  families: z.array(z.strictObject({
    family: z.enum(ConnectorFamilies),
    label: z.string(),
    connectors: z.array(ConnectorProductStateSchema).min(1),
  })),
});
export type ConnectorListResult = z.infer<typeof ConnectorListResultSchema>;

/**
 * Group product states by family, in catalog order. A product in two families
 * appears in both, so a reader of one family sees all it needs.
 */
export function groupConnectorProductsByFamily(states: readonly ConnectorProductState[]): ConnectorListResult {
  return {
    families: ConnectorFamilies.flatMap((family) => {
      const connectors = states.filter((state) =>
        (ConnectorProductCatalog[state.connectorId].families as readonly ConnectorFamily[]).includes(family));
      return connectors.length === 0 ? [] : [{ family, label: ConnectorFamilyCatalog[family].label, connectors }];
    }),
  };
}

export function connectorListSummary(result: ConnectorListResult): string {
  const connected = new Set(result.families.flatMap(({ connectors }) =>
    connectors.filter(({ state }) => state === "connected").map(({ connectorId }) => connectorId)));
  return `Listed connectors in ${result.families.length} families; connected: ${connected.size === 0 ? "none" : [...connected].join(", ")}`;
}
