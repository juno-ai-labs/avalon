/**
 * The homepage's marketing CSP matches the global policy in public/_headers.
 * The Worker replaces asset-layer headers because production previously served
 * duplicate policies on `/`; see docs/public-site-telemetry.md.
 * The help policy adds 'self' to connect-src for its search index.
 */
export const LANDING_CSP = "default-src 'self'; style-src 'self'; img-src 'self' data: https://t.co https://analytics.twitter.com https://rp.liadm.com https://rpr.liadm.com; script-src 'self' https://static.ads-twitter.com https://assets.apollo.io https://d-code.liadm.com; frame-src https://i.liadm.com; connect-src https://t.co https://analytics.twitter.com https://aplo-evnt.com https://idx.liadm.com https://rp.liadm.com https://rpr.liadm.com https://api.rallywith.ai https://api.with-avalon.com https://p.rallywith.ai; worker-src blob:; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests";
