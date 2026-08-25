# When adding a new HTTP header

Use this checklist whenever the Electron renderer adds or consumes a header on a
regional API request. The renderer runs at `app://rallywithai`, so Chromium enforces
CORS before the request reaches the Worker.

## Request headers

1. Add the header at its renderer request site. Shared API mutations normally use
   `apps/desktop/src/renderer/lib/api.ts`.
2. Add the lowercase header name to `securityMiddleware()`'s `allowHeaders` list
   in `apps/api/src/middleware/request-context.ts`.
3. Add it to `access-control-request-headers` in the desktop mutation preflight in
   `apps/api/test/security-and-config.test.ts`, then assert that the returned
   `Access-Control-Allow-Headers` contains it.
4. Keep the client, Worker allowlist, and regression test in the same pull
   request. The middleware is shared by Global and EU; do not add a wildcard or a
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
pnpm --filter @avalon/api exec vitest run test/security-and-config.test.ts
```

For a hosted endpoint, verify the real browser preflight shape before releasing:

```bash
curl -i -X OPTIONS https://api.rallywith.ai/workstreams \
  -H 'Origin: app://rallywithai' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization,content-type,x-example-header'
```

Expect `204`, `Access-Control-Allow-Origin: app://rallywithai`, and the new header in
`Access-Control-Allow-Headers`. Repeat against the EU endpoint when the feature is
available there.

A missing CORS entry appears as a renderer transport failure. Chromium does not
send the product request, so the blocked mutation has no Worker request log. The
shared renderer API boundary reports a sanitized `network_error`, but it does not
retry the mutation.

Browser WebSockets are different: renderer code cannot attach an arbitrary
handshake header. Follow [`realtime-sockets.md`](realtime-sockets.md) rather than
this HTTP-header checklist.
