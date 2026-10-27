/**
 * Paths whose URL carries a sign-in ticket, invitation token, download grant
 * or resource id. No third-party script (PostHog's SDK, X's pixel) runs on
 * them, because those scripts record or report the full page URL. Every other
 * page allows them by default, so a new page is covered without an edit here;
 * a new page that receives a credential in its URL must be added before it
 * ships.
 */
const CREDENTIAL_PATHS: readonly RegExp[] = [
  /^\/download(?:\/|$)/u,
  /^\/invite(?:\/|$)/u,
  /^\/auth\//u,
  /^\/slack\/link(?:\/|$)/u,
  /^\/open(?:\/|$)/u,
  /^\/app(?:\/|$)/u,
  // Not a path but the 404 page: a mistyped handoff link lands here with its
  // token still in the URL.
  /^\/404(?:\.html)?$/u,
];

/** Whether a third-party script may run on this path: not one in `CREDENTIAL_PATHS`. */
export function allowsThirdPartyScripts(pathname: string): boolean {
  const path = pathname.toLowerCase();
  return !CREDENTIAL_PATHS.some((denied) => denied.test(path));
}
