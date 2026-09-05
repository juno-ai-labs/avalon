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

/** Every product header name a request may carry, canonical spelling. */
export const RALLY_HEADERS = Object.freeze({
  DEV_USER_ID: "x-rally-dev-user-id",
  DEV_WORKSPACE_ID: "x-rally-dev-workspace-id",
  DRAFT_ID: "x-rally-draft-id",
  OPERATION_ID: "x-rally-operation-id",
  /**
   * The parent a conversation object belongs to, on a Worker-to-object socket
   * upgrade: `PARENT_KIND` is `workstream` or `automation`, `PARENT_ID` the
   * parent's id. Internal headers only, never sent by a client, so the CORS
   * allowlist does not name them.
   */
  PARENT_ARCHIVED: "x-rally-parent-archived",
  PARENT_ID: "x-rally-parent-id",
  PARENT_KIND: "x-rally-parent-kind",
  PLACEMENT_AFFINITY: "x-rally-placement-affinity",
  REGION: "x-rally-region",
  SESSION_ID: "x-rally-session-id",
  SIGNATURE: "x-rally-signature",
  SOCKET_ADMISSION_AUTHORITY_GENERATION: "x-rally-socket-admission-authority-generation",
  SOCKET_ADMISSION_ROLE: "x-rally-socket-admission-role",
  SOCKET_ADMISSION_VERSION: "x-rally-socket-admission-version",
  SOCKET_ADMISSION_MEMBERSHIP_VERSION: "x-rally-socket-admission-membership-version",
  SOCKET_ANALYTICS_WORKSPACE_ID: "x-rally-socket-analytics-workspace-id",
  SOCKET_AFTER_SEQUENCE: "x-rally-socket-after-sequence",
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
