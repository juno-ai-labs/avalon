/**
 * The product-prefixed HTTP headers, and the superseded spelling every reader
 * still accepts.
 *
 * The rename from Avalon to Rally moved the prefix from `x-avalon-` to
 * `x-rally-`. A header name is not a private detail: it is written by one
 * deployment and read by another, and the two cannot be updated at the same
 * instant. Three of the writers are outside this repository's control on the
 * timescale of a deploy — a desktop build carries its header names compiled in,
 * a third party's webhook configuration names `x-avalon-signature` in their own
 * console, and a hibernating WebSocket carries an attachment written by whatever
 * version accepted the upgrade.
 *
 * So this follows the rule the hostname rename established in
 * `docs/domain-migration.md`: **switch what is written, widen what is read.**
 * Every reader goes through {@link readRallyHeader}, which tries the canonical
 * name and falls back to the superseded one; every writer emits the canonical
 * name alone. That removes the need for a coordinated cutover, because a Rally
 * client reaching an Avalon-era Worker and an Avalon-era client reaching a Rally
 * Worker both resolve.
 *
 * Kept free of dependencies (no zod) so the static site can import it without
 * pulling a validation library into a page.
 */

/** The prefix every product header is minted with. */
export const RALLY_HEADER_PREFIX = "x-rally-";

/**
 * Prefixes still honoured inbound, and deliberately never emitted.
 *
 * Removed only when nothing is observed arriving on them, which is a decision
 * about shipped desktop builds and third-party webhook registrations rather
 * than about this repository.
 */
export const LEGACY_RALLY_HEADER_PREFIXES: readonly string[] = Object.freeze([
  "x-avalon-",
]);

/**
 * The wire contract this build of a client speaks.
 *
 * One integer, sent on every request a client makes, so a Worker can tell a
 * build that understands its payloads from one that would drop them. It exists
 * because the Spaces cutover changed two payloads a shipped desktop parses with
 * **strict** schemas — the workspace socket's opening sidebar and the Channel
 * rows inside it — and a strict schema does not ignore a field it has never
 * heard of, it rejects the whole object. An explicit refusal is the only honest
 * answer to a build that would render nothing.
 *
 * `1` is the Organization/Space/Channel hierarchy. Absent means a build from
 * before this header, which is exactly what a pre-cutover desktop is.
 * `2` adds browser script/reset support.
 * `3` adds explicit import verification checks and parallel file downloads, required by import admission.
 * `4` opens a guest relationship: platform discovery lists one and activation admits it.
 * `5` reads a Space whose scope is `individual` (a Personal Channel).
 * `6` reads a Channel feed item of kind `message`.
 * `7` reads a Channel message's `merge` and a message item's `attentionSequenceNumber`.
 * `8` reads an Activity row of kind `artifact_updated` and its `artifact`.
 * `9` reads a Channel merge's `private`, from a thread the reader cannot open.
 * `10` reads resolution suggestions in conversation snapshots and events.
 * `11` reads human reply Activity, its preview and unread message count.
 */
export const CLIENT_CONTRACT_VERSION = 11;
/** Import verification includes explicit check outcomes and parallel file downloads. */
export const SESSION_IMPORT_CLIENT_CONTRACT = 3;
/**
 * First client contract that opens a guest relationship. A desktop before it
 * asks member-only routes for every stored workspace, so it is not offered one.
 */
export const GUEST_WORKSPACES_CLIENT_CONTRACT = 4;
/**
 * First client contract that reads a Space scoped `individual`. An older
 * desktop parses Space summaries strictly, so it is shown such a Space as
 * `personal` (`spaceScopeForClient`) rather than dropping every snapshot.
 */
export const INDIVIDUAL_SPACE_CLIENT_CONTRACT = 5;
/**
 * First client contract that reads a Channel feed item of kind `message`. An
 * older desktop parses the feed strictly, so it is served the feed without
 * them.
 */
export const CHANNEL_MESSAGES_CLIENT_CONTRACT = 6;
/**
 * First client contract that reads a merged thread's result in a Channel: a
 * Channel message's `merge` and a message item's `attentionSequenceNumber`.
 * Both schemas are strict, so an older desktop is served the message without
 * them, as a plain message from the person who merged.
 */
export const CHANNEL_MERGES_CLIENT_CONTRACT = 7;
/**
 * First client contract that reads an Activity row about a pinned artifact's
 * new version. `ActivityItemSchema` is strict, so an older desktop is served
 * the page without those rows.
 */
export const ARTIFACT_UPDATES_CLIENT_CONTRACT = 8;
/**
 * First client contract that reads a Channel merge from a thread the reader
 * cannot open (`merge.private`). The merge schema is strict, so an older
 * desktop is served the feed without those merges, as before they existed.
 */
export const CHANNEL_PRIVATE_MERGES_CLIENT_CONTRACT = 9;
/** Human reply Activity rows and their preview. */
export const NEW_MESSAGES_CLIENT_CONTRACT = 11;

/** Conversation snapshots may contain the mark_resolved suggestion kind. */
export const RESOLUTION_SUGGESTIONS_CLIENT_CONTRACT = 10;

/**
 * The oldest client contract a Worker still answers.
 *
 * Deliberately a second constant equal to the first rather than a reuse of it.
 * The Worker deploys before the client does, so a Worker that required
 * whatever the newest client sends would refuse every shipped build for the
 * length of a rollout. Raising this is a decision about which builds are still
 * in the field; raising {@link CLIENT_CONTRACT_VERSION} is a statement about
 * what this source tree speaks.
 */
export const MINIMUM_SERVED_CLIENT_CONTRACT = 1;

/** Every product header name a request may carry, canonical spelling. */
export const RALLY_HEADERS = Object.freeze({
  /** The wire contract the calling build speaks; see {@link CLIENT_CONTRACT_VERSION}. */
  CLIENT_CONTRACT: "x-rally-client-contract",
  DEV_USER_ID: "x-rally-dev-user-id",
  DEV_WORKSPACE_ID: "x-rally-dev-workspace-id",
  DRAFT_ID: "x-rally-draft-id",
  OPERATION_ID: "x-rally-operation-id",
  /**
   * The parent a conversation object belongs to, on a Worker-to-object socket
   * upgrade: `PARENT_KIND` is a `ConversationParentKind`, `PARENT_ID` the
   * parent's id. `space` never reaches here — the ticket route refuses one
   * before it is signed — but the header carries the vocabulary rather than a
   * subset of it, so the object parses what the contract defines. Internal headers only, never sent by a client, so the CORS
   * allowlist does not name them.
   */
  PARENT_ARCHIVED: "x-rally-parent-archived",
  PARENT_ID: "x-rally-parent-id",
  PARENT_KIND: "x-rally-parent-kind",
  PLACEMENT_AFFINITY: "x-rally-placement-affinity",
  REGION: "x-rally-region",
  /**
   * What a conversation object reports on the 101 it answers a feed upgrade
   * with: how long its own accept ran, and how old the object instance that
   * ran it was. The edge records the wait outside the accept separately;
   * it includes routing, activation, constructor work, and queueing. Both
   * headers are internal, stripped before the client handshake.
   * `docs/performance-tracing.md` owns the attributes they become.
   */
  ROOM_ACCEPT_MS: "x-rally-room-accept-ms",
  ROOM_INSTANCE_AGE_MS: "x-rally-room-instance-age-ms",
  SESSION_ID: "x-rally-session-id",
  SIGNATURE: "x-rally-signature",
  SOCKET_ADMISSION_AUTHORITY_GENERATION: "x-rally-socket-admission-authority-generation",
  SOCKET_ADMISSION_ROLE: "x-rally-socket-admission-role",
  SOCKET_ADMISSION_VERSION: "x-rally-socket-admission-version",
  SOCKET_ADMISSION_MEMBERSHIP_VERSION: "x-rally-socket-admission-membership-version",
  SOCKET_ANALYTICS_WORKSPACE_ID: "x-rally-socket-analytics-workspace-id",
  SOCKET_AFTER_SEQUENCE: "x-rally-socket-after-sequence",
  /**
   * The Rally staff member behind a support session (`docs/impersonation.md`),
   * signed into the socket ticket and forwarded to the object on upgrade so
   * the socket skips the person's read, unseen and presence writes and audits
   * its own. Internal only; the edge strips every inbound spelling first.
   */
  SOCKET_IMPERSONATOR_ID: "x-rally-socket-impersonator-id",
  /**
   * `1` when the build that asked for a workspace socket ticket reads a Space
   * scoped `individual` (`INDIVIDUAL_SPACE_CLIENT_CONTRACT`), signed into the
   * ticket and forwarded on upgrade. Internal only, stripped like the
   * impersonator id; a socket without it is told `personal`.
   */
  SOCKET_READS_INDIVIDUAL_SPACES: "x-rally-socket-reads-individual-spaces",
  SOCKET_SPECULATIVE: "x-rally-socket-speculative",
  SOCKET_TICKET_EXPIRES_AT: "x-rally-socket-ticket-expires-at",
  SOCKET_TICKET_ID: "x-rally-socket-ticket-id",
  SUBSTREAM_ID: "x-rally-substream-id",
  TELEMETRY_CAPABILITY: "x-rally-telemetry-capability",
  TELEMETRY_VERSION: "x-rally-telemetry-version",
  USER_ID: "x-rally-user-id",
  /**
   * The viewer identity the artifact serving path injects into every request
   * it forwards to model-authored code.
   *
   * They are listed here for the reason everything else is: this table is the
   * one place a product header name exists, and the anti-spoof strip that
   * guards these two reads `rallyHeaderAliases` to cover the superseded
   * spelling as well. A header family whose readers widen and whose stripper
   * does not is a family with a forgeable back door.
   */
  VIEWER_ID: "x-rally-viewer-id",
  VIEWER_NAME: "x-rally-viewer-name",
  WORKSPACE_ID: "x-rally-workspace-id",
  WORKSTREAM_ID: "x-rally-workstream-id",
} as const);

/**
 * The canonical name paired with every superseded spelling of it.
 *
 * A CORS allowlist has to name both: the browser matches
 * `Access-Control-Request-Headers` literally, so a build still sending the
 * superseded name is rejected at the preflight — which fails before any route
 * code runs and therefore leaves no request log to diagnose it from.
 */
export function rallyHeaderAliases(name: string): readonly string[] {
  if (!name.startsWith(RALLY_HEADER_PREFIX)) return Object.freeze([name]);
  const suffix = name.slice(RALLY_HEADER_PREFIX.length);
  return Object.freeze([
    name,
    ...LEGACY_RALLY_HEADER_PREFIXES.map((prefix) => `${prefix}${suffix}`),
  ]);
}

/** A `Headers`-like source, or hono's `c.req.header` accessor. */
export type RallyHeaderSource =
  | { get(name: string): string | null }
  | ((name: string) => string | undefined);

function headerValue(source: RallyHeaderSource, name: string): string | undefined {
  const value = typeof source === "function" ? source(name) : source.get(name);
  return value ?? undefined;
}

/**
 * Read a product header by its canonical name, falling back to every superseded
 * spelling.
 *
 * Every read site goes through this rather than naming the header directly, so
 * that retiring a legacy prefix is one edit to the list above rather than a
 * sweep nobody can prove is complete.
 */
export function readRallyHeader(
  source: RallyHeaderSource,
  name: string,
): string | undefined {
  for (const alias of rallyHeaderAliases(name)) {
    const value = headerValue(source, alias);
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}
