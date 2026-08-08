# Running Avalon in a Linux sandbox

Avalon targets macOS for the desktop client and Cloudflare for the API. Almost
all of it still runs on a headless Linux container with no Cloudflare, Google,
or OpenRouter credentials. This document records what runs, what does not, and
the exact deviations required.

Verified on Linux x86_64, Node.js 22.22, pnpm 11.13.0, Electron 43.2.0.

## What runs unchanged

```text
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm db:migrate
pnpm db:seed
```

`pnpm build` includes the API's `wrangler deploy --dry-run`, the Electron main,
preload, and renderer bundles, the site, and the release-retention Worker. None
of them contact Cloudflare. `pnpm db:migrate` and `pnpm db:seed` apply every
migration and the development seed to both regional local D1 databases under
`apps/api/.wrangler/state/`.

Start from a `.env.local` copied from `.env.example`. `pnpm env:sync` generates
the missing signing and encryption values, so the Workers boot with development
authentication enabled and every provider integration reported as
`not configured` by `/health`.

## The one required deviation: remote-only Worker bindings

`pnpm dev:api` fails in a credential-less environment:

```text
Failed to start the remote proxy session. Error reloading remote server: In a
non-interactive environment, it's necessary to set a CLOUDFLARE_API_TOKEN
environment variable for wrangler to work.
```

Wrangler opens a remote proxy session for the `ai`, `vectorize`, and `images`
bindings because those products have no local implementation. The session is
established during startup, so the whole Worker refuses to boot even for
requests that never touch them.

`node scripts/make-sandbox-wrangler.mjs` writes ignored
`apps/api/wrangler.sandbox.{global,eu}.jsonc` copies with exactly those three
bindings removed. Run each region directly against them:

```text
cd apps/api
npx wrangler dev --config wrangler.sandbox.global.jsonc --env-file .dev.vars.global \
  --persist-to .wrangler/state/global --port 8787 --inspector-port 9230
npx wrangler dev --config wrangler.sandbox.eu.jsonc --env-file .dev.vars.eu \
  --persist-to .wrangler/state/eu --port 8788 --inspector-port 9231
```

Both Workers then report `{"ok":true}` with D1, R2, Durable Objects, Queues, and
Workflows all available locally. Anything that reaches Workers AI, Vectorize, or
Images — today that is scoped agent memory and image derivatives — fails at call
time instead of at boot. Never deploy from the generated configs.

Cron triggers are not fired automatically in local dev; invoke the scheduled
handler with `curl http://127.0.0.1:8787/cdn-cgi/local/scheduled`.

## Desktop client on Linux

`pnpm install` does not always fetch the Electron binary. When
`node_modules/.pnpm/electron@*/node_modules/electron/dist` is missing, run that
package's `install.js` once.

The app runs headless under Xvfb. As root, Electron also needs its sandbox
disabled:

```text
ELECTRON_DISABLE_SANDBOX=1 xvfb-run -a --server-args="-screen 0 1440x900x24" pnpm dev:desktop
```

The built app can be driven with Playwright's Electron support against
`node_modules/.pnpm/electron@*/node_modules/electron/dist/electron` with
`apps/desktop` as the argument. Signing in with **Use local development
account** loads the seeded workspace, work-stream list, transcript, tool
receipts, and right sidebar. D-Bus and IPv6 socket errors in the log are
container noise and do not affect rendering. Only one instance runs at a time —
`app.requestSingleInstanceLock()` makes a second launch exit silently with code
0.

macOS-only surfaces stay unavailable: `pnpm package:desktop` and
`pnpm package:desktop:release` refuse to run off Darwin by design, and so do
notarization, Gatekeeper verification, and the packaged-launch smoke.

The renderer can also be opened directly at `http://127.0.0.1:5173/` in a normal
browser. `ALLOWED_ORIGINS` already lists that origin, and the whole workspace UI
works there, which is the cheapest way to inspect the client.

## Agent harness

The harness runs end to end locally. Posting a message starts a Workflow
instance, creates the `harness_runs` row, projects the model transcript, calls
OpenRouter, records `inference_attempts` with routing decisions and fallback
classification, and terminalizes the run. Outbound HTTPS from workerd reaches
`openrouter.ai`, `api.firecrawl.dev`, and `api.resend.com`. Only credentials are
missing: without `OPENROUTER_API_KEY` the run fails as
`harness_execution_failed` before any model call, and with an invalid key it
fails as an `http` classification after the real request. Supply a key in
`.env.local` and re-run `pnpm env:sync` to exercise real agent runs.

## Known gaps in `pnpm smoke:local`

Two assertions in `scripts/smoke-local.mjs` cannot pass against the current seed
and Durable Object, in any environment:

1. `detail.body.connections` is asserted non-empty, but `packages/db/seed.sql`
   never inserts a `connector_connections` row, so the work-stream detail always
   returns an empty list.
2. The realtime snapshot never arrives. `WorkstreamRoom.loadSnapshot` builds its
   `WorkstreamDetail` without the read-state fields
   (`latestAttentionSequenceNumber`, `readThroughSequenceNumber`, `hasUnread`,
   `firstUnreadSequenceNumber`, `manualUnreadFromSequenceNumber`,
   `manualUnreadGeneration`) that `workstream-service.ts` derives from
   `latest_attention_sequence_number`. `WorkstreamDetailSchema.parse` throws, the
   caught error becomes `snapshot_unavailable`, and every subscriber is told to
   resynchronize over REST instead of receiving a snapshot.

Everything before those assertions passes: health, the protected route set,
region binding, the full invitation lifecycle, the resource fixture, the
persisted tool transcript, and message idempotency replay.
