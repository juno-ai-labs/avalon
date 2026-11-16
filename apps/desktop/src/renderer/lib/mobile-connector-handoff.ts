/**
 * Where a connector authorization a cookie session starts comes back: the
 * browser's completion page, unless the page runs inside the mobile app,
 * whose shell waits for it in an auth session (`docs/connectors.md`,
 * "Claiming a connector authorization"). Standalone so the browser's mobile
 * bridge can read it without the API client.
 */
let handoff: 'browser' | 'mobile' = 'browser';
export function selectMobileConnectorHandoff(): void { handoff = 'mobile'; }
export function browserConnectorHandoff(): 'browser' | 'mobile' { return handoff; }

/**
 * The authorization pages this page started for the mobile shell. The shell
 * opens only these in an auth session; every other link still leaves through
 * the system browser.
 */
const authorizations = new Set<string>();
export function recordMobileConnectorAuthorization(url: string): void { authorizations.add(url); }
export function isMobileConnectorAuthorization(url: string): boolean { return authorizations.has(url); }
