# When adding a new HTTP header

Use this checklist whenever the Electron renderer adds or consumes a header on a
regional API request. The renderer runs at `app://rallywithai`, so Chromium enforces
CORS before the request reaches the Worker.

## Request headers

0. Name it on the product prefix and add it to `RALLY_HEADERS` in
   `packages/contracts/src/http-headers.ts`. Never write the string literal at a
   request or read site: a header on that prefix has a superseded `x-avalon-`
   spelling that installed builds still send, and going through the constant is
   what makes both resolve. `docs/domain-migration.md` owns why.
1. Add the header at its renderer request site, keyed by the constant. Shared API
   mutations normally use `apps/desktop/src/renderer/lib/api.ts`.
2. Read it on the Worker with `readRallyHeader`, never `c.req.header("…")`
   directly, and spread `rallyHeaderAliases(RALLY_HEADERS.…)` into
   `securityMiddleware()`'s `allowHeaders` list in
   `apps/api/src/middleware/request-context.ts` so both spellings are admitted.
   The browser matches `Access-Control-Request-Headers` literally, so a list
   holding only the current spelling rejects every pre-rename build at the
   preflight — before any route code runs, and therefore with no request log.
3. Add it to `access-control-request-headers` in the desktop mutation preflight in
   `apps/api/test/security-and-config.test.ts`, then assert that the returned
   `Access-Control-Allow-Headers` contains both spellings. If the header carries
   authority or changes routing, add a reading-side case to
   `apps/api/test/legacy-header-compatibility.test.ts` as well.
4. Keep the client, Worker allowlist, and regression test in the same pull
   request. The middleware is shared by configured deployments; do not add a wildcard or a
   region-specific bypass.

If the header contains authority or user content, stop and review
[`security.md`](security.md) before implementation. Never put credentials,
provider payloads, prompts, message text, filenames, or request bodies into a
diagnostic header.

## Response headers

Set the header in the owning API route or middleware. If renderer JavaScript must
read a non-safelisted response header, also add its lowercase name to
`securityMiddleware()`'s `exposeHeaders` list and assert it in the relevant API
test. Do not expose a response header merely because it exists on the wire.

## Verification

Run the focused API suite:

```bash
pnpm --filter @rally/api exec vitest run test/security-and-config.test.ts
```

For a hosted endpoint, verify the real browser preflight shape before releasing:

```bash
curl -i -X OPTIONS https://api.rallywith.ai/canvases \
  -H 'Origin: app://rallywithai' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization,content-type,x-example-header'
```

A missing CORS entry appears as a renderer transport failure. Chromium does not
send the product request, so the blocked mutation has no Worker request log. The
shared renderer API boundary reports a sanitized `network_error`, but it does not
retry the mutation.

Browser WebSockets are different: renderer code cannot attach an arbitrary
handshake header. Follow [`realtime-sockets.md`](realtime-sockets.md) rather than
this HTTP-header checklist.
