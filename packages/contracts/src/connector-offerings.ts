import { z } from "zod";

/**
 * The connector offerings a person can be shown and asked to connect.
 *
 * An *offering* is not a connector type. `google` is one connector with one
 * OAuth client, and Avalon presents it as two separate things to connect —
 * mail and calendar, or Drive and the editors — because nobody wants the union
 * of those grants to read one document. Every surface that offers a connection
 * therefore has to name the offering rather than the provider, and this is the
 * one place that mapping is written down: the Settings pane renders from it,
 * the connector cards in a work-stream feed render from it, and the agent tool
 * that publishes those cards validates against it.
 *
 * Capabilities live here for the same reason. They are what the OAuth start
 * endpoint is called with, so a second list somewhere else is a second grant
 * that drifts silently — a member gets a narrower connection depending on which
 * button they happened to press, and nothing fails until a tool call does.
 */

/** Icon per offering, resolved to real artwork by whichever surface renders it. */
export const ConnectorOfferingIconSchema = z.enum([
  "at-sign",
  "calendar",
  "file-text",
  "git-branch",
  "hard-drive",
  "message-square",
  "webhook",
  "workflow",
]);
export type ConnectorOfferingIcon = z.infer<typeof ConnectorOfferingIconSchema>;

/** Every `connector_connections.connector_type` an offering can produce. */
export const ConnectorTypeSchema = z.enum([
  "google",
  "github",
  "granola",
  "linear",
  "notion",
  "slack",
  "generic_webhook",
  "x",
]);
export type ConnectorType = z.infer<typeof ConnectorTypeSchema>;

/**
 * What a connector is *for*, in the words somebody describes a task in.
 *
 * These exist so a request can be turned into an offer. "Email my boss three
 * open slots from my calendar" names two categories and no products, and
 * without them the only way to answer it with a connection is for a model to
 * already know that Gmail is Avalon's email connector. A category is a small
 * closed set the model can enumerate from a schema, which is the difference
 * between finding the right connector first try and guessing at product names.
 *
 * An offering belongs to as many as apply: Google's mail-and-calendar
 * authorization is genuinely both, and a request for either should surface it.
 * They are properties of the *offering* rather than the connector, because
 * that is the granularity a person is asked to authorize — Google's other
 * offering is `documents` and shares neither category.
 */
export const ConnectorCategorySchema = z.enum([
  "email",
  "calendar",
  "messaging",
  "meetings",
  "documents",
  "project_tracking",
  "code",
  "social",
  "custom",
]);
export type ConnectorCategory = z.infer<typeof ConnectorCategorySchema>;

/**
 * What each category covers, written for a model choosing between them. Kept
 * beside the enum because a category name without a boundary is guesswork:
 * "documents" and "messaging" both sound right for a shared Slack canvas.
 */
export const CONNECTOR_CATEGORY_DESCRIPTIONS: Readonly<Record<ConnectorCategory, string>> = {
  email: "Reading, drafting, and sending email.",
  calendar: "Reading availability and creating or changing calendar events.",
  messaging: "Team chat: reading conversations and posting messages.",
  meetings: "Meeting recordings, transcripts, and the notes taken from them.",
  documents: "Documents, files, notes, and knowledge bases.",
  project_tracking: "Issues, tickets, roadmaps, and project status.",
  code: "Repositories, pull requests, checks, and development activity.",
  social: "Public social content and timelines.",
  custom: "Systems with no native connector, delivering signed inbound events.",
};

export interface ConnectorOffering {
  /** Stable id. Stored in message payloads, so it is a name, not an index. */
  readonly id: string;
  /** The `connector_connections.connector_type` a connection of this offering carries. */
  readonly connectorType: ConnectorType;
  readonly name: string;
  readonly description: string;
  readonly icon: ConnectorOfferingIcon;
  /**
   * What this offering is for. At least one, enforced by
   * `connector-offerings.test.ts`: an offering in no category is unreachable
   * from a request that describes a need rather than a product name, which is
   * the only way most requests arrive.
   */
  readonly categories: readonly ConnectorCategory[];
  /** The ownership scopes this offering can be connected in. */
  readonly scopes: readonly ("personal" | "workspace")[];
  /**
   * The subset of `scopes` that `POST /connections/<provider>/start` can begin.
   * Everything else needs something a card cannot do on its own — an admin API
   * key, a generated signing secret — and is handed to Settings instead.
   */
  readonly oauthScopes: readonly ("personal" | "workspace")[];
  readonly personalCapabilities: readonly string[];
  readonly workspaceCapabilities: readonly string[];
}

/**
 * `linear.agent` is deliberately absent from Linear's workspace capabilities.
 * The native-agent grant is gated by a build flag the desktop client owns, and
 * a shared registry that always asked for it would widen every workspace's
 * Linear grant the moment this file was imported somewhere new. The renderer
 * appends it when its flag is on; see `renderer/lib/connector-offerings.ts`.
 */
export const CONNECTOR_OFFERINGS: readonly ConnectorOffering[] = [
  {
    id: "google-mail-calendar",
    categories: ["email", "calendar"],
    connectorType: "google",
    name: "Google Mail + Calendar",
    description: "Search Gmail, create drafts, send mail, and work with calendar events.",
    icon: "calendar",
    scopes: ["personal"],
    oauthScopes: ["personal"],
    personalCapabilities: ["gmail.read", "gmail.draft", "gmail.send", "calendar.read", "calendar.write"],
    workspaceCapabilities: [],
  },
  {
    id: "google-drive-workspace",
    categories: ["documents"],
    connectorType: "google",
    name: "Google Drive + Docs + Sheets",
    description: "Read Drive files and work with Google Docs and Sheets content.",
    icon: "hard-drive",
    scopes: ["personal", "workspace"],
    oauthScopes: ["personal", "workspace"],
    personalCapabilities: ["drive.read", "docs.read", "docs.write", "sheets.read", "sheets.write"],
    workspaceCapabilities: ["drive.read", "docs.read", "docs.write", "sheets.read", "sheets.write"],
  },
  {
    id: "github",
    categories: ["code", "project_tracking"],
    connectorType: "github",
    name: "GitHub",
    description: "Repositories, issues, pull requests, checks, and development events.",
    icon: "git-branch",
    scopes: ["personal", "workspace"],
    oauthScopes: ["personal", "workspace"],
    personalCapabilities: [
      "github.metadata.read",
      "github.contents.read",
      "github.issues.read",
      "github.issues.write",
      "github.pull_requests.read",
      "github.pull_requests.write",
      "github.actions.read",
      "github.checks.read",
    ],
    workspaceCapabilities: [
      "github.metadata.read",
      "github.contents.read",
      "github.issues.read",
      "github.issues.write",
      "github.pull_requests.read",
      "github.pull_requests.write",
      "github.actions.read",
      "github.checks.read",
    ],
  },
  {
    id: "granola",
    categories: ["meetings", "documents"],
    connectorType: "granola",
    name: "Granola",
    description:
      "Personal meeting context through Granola MCP, or workspace notes and transcripts through an admin API key.",
    icon: "file-text",
    scopes: ["personal", "workspace"],
    // A workspace Granola connection is an admin pasting a `grn_` key, which is
    // a form rather than an authorization redirect.
    oauthScopes: ["personal"],
    personalCapabilities: ["granola.personal.read"],
    workspaceCapabilities: ["granola.workspace.read"],
  },
  {
    id: "linear",
    categories: ["project_tracking"],
    connectorType: "linear",
    name: "Linear",
    description:
      "Connect personally to act as you, or install Avalon for shared workspace access and real-time activity.",
    icon: "workflow",
    scopes: ["personal", "workspace"],
    oauthScopes: ["personal", "workspace"],
    personalCapabilities: ["linear.read", "linear.issue.create", "linear.comment.create", "linear.write"],
    workspaceCapabilities: ["linear.read", "linear.issue.create", "linear.comment.create", "linear.write"],
  },
  {
    id: "slack",
    categories: ["messaging"],
    connectorType: "slack",
    name: "Slack",
    description: "Messages, files, people, canvases, conversations, and the Avalon workspace Agent.",
    icon: "message-square",
    scopes: ["personal", "workspace"],
    oauthScopes: ["personal", "workspace"],
    personalCapabilities: [
      "slack.search",
      "slack.messages.read",
      "slack.files.read",
      "slack.users.read",
      "slack.messages.write",
      "slack.conversations.write",
      "slack.reactions.write",
      "slack.canvases.read",
      "slack.canvases.write",
    ],
    workspaceCapabilities: ["slack.agent", "slack.notifications.write"],
  },
  {
    id: "notion",
    categories: ["documents"],
    connectorType: "notion",
    name: "Notion",
    description: "Selected pages, data sources, comments, and change notifications.",
    icon: "file-text",
    scopes: ["personal"],
    oauthScopes: ["personal"],
    personalCapabilities: [
      "notion.read",
      "notion.insert",
      "notion.update",
      "notion.comment.read",
      "notion.comment.insert",
    ],
    workspaceCapabilities: [],
  },
  {
    id: "generic-webhook",
    categories: ["custom"],
    connectorType: "generic_webhook",
    name: "Inbound webhook",
    description: "Receive signed activity from systems that do not have a native Avalon connector.",
    icon: "webhook",
    scopes: ["personal", "workspace"],
    // Creating one mints a signing secret shown once; there is nowhere in a
    // transcript to put a credential that must be copied.
    oauthScopes: [],
    personalCapabilities: [],
    workspaceCapabilities: [],
  },
  {
    id: "x",
    categories: ["social"],
    connectorType: "x",
    name: "Public X via TwitterAPI.io",
    description:
      "Read-only public X timelines, threads, replies, and Lists using an Avalon-managed third-party API key.",
    icon: "at-sign",
    scopes: ["workspace"],
    oauthScopes: [],
    personalCapabilities: [],
    workspaceCapabilities: ["x.read"],
  },
] as const;

export const CONNECTOR_OFFERING_IDS = CONNECTOR_OFFERINGS.map((offering) => offering.id);

/**
 * Hand-written rather than derived from `CONNECTOR_OFFERINGS`, because `z.enum`
 * needs a literal tuple to produce a union type, and a `string`-typed schema
 * here would let an unknown id through every producer that validates with it.
 * `connector-offerings.test.ts` asserts the two lists agree.
 */
export const ConnectorOfferingIdSchema = z.enum([
  "google-mail-calendar",
  "google-drive-workspace",
  "github",
  "granola",
  "linear",
  "slack",
  "notion",
  "generic-webhook",
  "x",
]);
export type ConnectorOfferingId = z.infer<typeof ConnectorOfferingIdSchema>;

export function connectorOffering(id: ConnectorOfferingId): ConnectorOffering {
  const offering = CONNECTOR_OFFERINGS.find((candidate) => candidate.id === id);
  // Unreachable through the schema, and typed as total so no caller has to
  // invent a fallback name for an offering that cannot be missing.
  if (!offering) throw new Error(`Unknown connector offering: ${id}`);
  return offering;
}

export function connectorOfferingCapabilities(
  offering: ConnectorOffering,
  scope: "personal" | "workspace",
): readonly string[] {
  return scope === "personal" ? offering.personalCapabilities : offering.workspaceCapabilities;
}

export function connectorOfferingsInCategory(
  category: ConnectorCategory,
): readonly ConnectorOffering[] {
  return CONNECTOR_OFFERINGS.filter((offering) => offering.categories.includes(category));
}

/** The minimum an existing connection has to say for an offering to claim it. */
export interface ConnectorConnectionIdentity {
  connectorType: string;
  scope: "personal" | "workspace";
  grantedCapabilities: readonly string[];
}

/**
 * Whether an existing connection is one of *this* offering's.
 *
 * Connector type alone is not enough, and this is the single subtlety the whole
 * offering model exists for: Google's two offerings share one connector type
 * and one OAuth client, so a Gmail connection matched by type would report
 * Drive as connected and hide the authorization that actually reads documents.
 * The capability overlap is what separates them.
 *
 * It lives in contracts rather than in either caller because both the desktop
 * client (deciding what a card shows) and the API (deciding what an agent is
 * told is missing) have to answer it identically. Two implementations drift
 * into a card that says connected beside a model that says it is not.
 *
 * An offering that declares no capabilities — the inbound webhook — matches on
 * type, which is correct for it because there is nothing narrower to compare.
 */
export function connectionMatchesOffering(
  connection: ConnectorConnectionIdentity,
  offering: ConnectorOffering,
  scope?: "personal" | "workspace",
): boolean {
  if (connection.connectorType !== offering.connectorType) return false;
  if (scope && connection.scope !== scope) return false;
  const capabilities = scope
    ? connectorOfferingCapabilities(offering, scope)
    : [...offering.personalCapabilities, ...offering.workspaceCapabilities];
  if (capabilities.length === 0) return true;
  return capabilities.some((capability) => connection.grantedCapabilities.includes(capability));
}

/** The structured-content discriminator that makes a message a card block. */
export const CONNECTOR_CARDS_BLOCK_KIND = "connector_cards";

/**
 * How many cards one block may carry. There are nine offerings in total, and a
 * block naming most of them is not an offer — it is the Settings pane pasted
 * into a conversation, which is where somebody who wants the whole list should
 * be sent instead.
 */
export const CONNECTOR_CARDS_MAX = 6;

export const ConnectorCardSchema = z.object({
  offeringId: ConnectorOfferingIdSchema,
  /**
   * Which grant is being offered. Absent means the reader chooses among the
   * offering's scopes — the honest state when the producer has no opinion,
   * rather than a silent default to the narrower or wider one.
   */
  scope: z.enum(["personal", "workspace"]).optional(),
  /** One line saying why this connection is being offered here. */
  note: z.string().max(240).optional(),
});
export type ConnectorCard = z.infer<typeof ConnectorCardSchema>;

/**
 * What a connector-cards message carries. Deliberately *only* the identity of
 * each offering: a card's connected/disconnected state is resolved by whoever
 * renders it, from the connections that exist at that moment. A state written
 * into the row would be wrong within seconds of somebody connecting, and this
 * row is durable — it is still in the transcript a year later.
 */
export const ConnectorCardsBlockSchema = z.object({
  kind: z.literal(CONNECTOR_CARDS_BLOCK_KIND),
  heading: z.string().max(120).optional(),
  cards: z.array(ConnectorCardSchema).min(1).max(CONNECTOR_CARDS_MAX),
});
export type ConnectorCardsBlock = z.infer<typeof ConnectorCardsBlockSchema>;

/**
 * A fallback sentence for the row's `text_content`.
 *
 * The block is UI state, so a client that does not know this `kind` renders the
 * text instead of nothing, and the row stays legible in any surface that reads
 * transcripts as prose.
 */
export function connectorCardsFallbackText(block: ConnectorCardsBlock): string {
  const names = block.cards.map((card) => connectorOffering(card.offeringId).name);
  const list = names.length === 1
    ? names[0]!
    : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]!}`;
  return block.heading ? `${block.heading} — ${list}` : `Connect ${list} to Avalon.`;
}
