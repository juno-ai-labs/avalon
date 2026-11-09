/**
 * The desktop client's custom URL scheme — the one link shape that reaches the
 * installed app directly.
 *
 * It lives here, alone, because five places have to agree on it and they cannot
 * check each other: the Worker validates the redirect target it is configured
 * with, the public site decides whether a handoff fragment is safe to follow,
 * the desktop registers the scheme with the operating system and matches it on
 * the way back in, and the work-stream link module mints it. A copy of the list
 * that fell behind would not fail loudly — it would silently classify a real
 * link as untrusted, on one surface only.
 *
 * Two schemes are live, and the pairing is not symmetric: `rallywithai:` is
 * minted and `avalon:` is only ever read. A scheme is claimed by an *installed*
 * build, so the old one keeps arriving from clients that have not updated, and
 * from links already sitting in inboxes and Slack history — neither of which
 * anyone here can reissue. `avalon:` is removed once those are gone, and
 * removing it is the whole reason it is named separately rather than folded
 * into one list.
 *
 * Kept free of dependencies (no zod) so the static site can import it without
 * pulling a validation library into a page.
 */

/** The scheme every surface mints today. */
export const DESKTOP_DEEP_LINK_PROTOCOL = "rallywithai:";

/** Schemes still honoured inbound, and deliberately never emitted. */
export const LEGACY_DESKTOP_DEEP_LINK_PROTOCOLS: readonly string[] = Object.freeze([
  "avalon:",
]);

/** Every scheme a desktop deep link may arrive as. */
export const DESKTOP_DEEP_LINK_PROTOCOLS: readonly string[] = Object.freeze([
  DESKTOP_DEEP_LINK_PROTOCOL,
  ...LEGACY_DESKTOP_DEEP_LINK_PROTOCOLS,
]);

/**
 * The scheme to mint when the target has to reach a build whose registrations
 * are not known.
 *
 * Most deep links can answer in the caller's own scheme, because the caller
 * supplies it — identity sign-in sends its `returnUri`. Connector OAuth does
 * not: its start request carries only a scope and capabilities, and the
 * completion is reached through a target the server minted earlier. A build
 * shipped before the rename registered the legacy scheme and nothing else,
 * while every build since registers the current scheme *and* the legacy one, so
 * the legacy scheme is the single target that reaches both generations.
 *
 * This is the one value the migration writes in its superseded form on purpose,
 * and it retires itself: when the last legacy scheme leaves the list above,
 * this becomes the current scheme with no other edit.
 */
export const COMPATIBLE_DESKTOP_DEEP_LINK_PROTOCOL: string =
  LEGACY_DESKTOP_DEEP_LINK_PROTOCOLS[0] ?? DESKTOP_DEEP_LINK_PROTOCOL;

/** Whether a `URL.protocol` names a desktop deep link, current or legacy. */
export function isDesktopDeepLinkProtocol(protocol: string): boolean {
  return DESKTOP_DEEP_LINK_PROTOCOLS.includes(protocol);
}
