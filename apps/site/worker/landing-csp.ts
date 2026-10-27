/**
 * The landing pages' CSP, which adds Apollo, LiveIntent and X to the global
 * one. `/start-fast/*` and `/concepts/*` set the same value in
 * `public/_headers`; keep the three identical. The homepage's copy lives here
 * because an exact `/` rule in `_headers` was served alongside the global
 * `/*` policy in production, and browsers enforce both, which blocked Apollo.
 * The Worker sets it after the asset layer, replacing whatever that layer
 * attached. It lives in its own module because a Worker's entry may export
 * only handlers.
 */
export const LANDING_CSP = "default-src 'self'; style-src 'self'; img-src 'self' data: https://t.co https://analytics.twitter.com https://rp.liadm.com https://rpr.liadm.com; script-src 'self' https://static.ads-twitter.com https://assets.apollo.io https://d-code.liadm.com; frame-src https://i.liadm.com; connect-src https://t.co https://analytics.twitter.com https://aplo-evnt.com https://idx.liadm.com https://rp.liadm.com https://rpr.liadm.com https://api.rallywith.ai https://api.with-avalon.com https://p.rallywith.ai; worker-src blob:; object-src 'none'; base-uri 'self'; form-action https://api.rallywith.ai/access/downloads/redeem; frame-ancestors 'none'; upgrade-insecure-requests";
