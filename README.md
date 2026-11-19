# Rally

Rally is an AI workspace for building shared dashboards, internal tools,
websites, and reports that can stay current as work changes in your connected
tools.

- **Canvases** pair a shared Chat with the artifact Rally builds. Start with a
  prompt or a template, attach files or point Rally at a connected source,
  and ask for what you need. Teammates can follow the conversation, leave
  comments, and ask Rally to publish a new version. The Canvas and the
  published artifact have separate sharing settings, so people can use the
  result without joining the Chat.
- **Sidekicks** are shared agents you configure in plain language. They can
  run on a schedule, on events from connected tools, by email, or on
  request. A run can update an artifact's data, publish a new version,
  send a result through a connected tool, or report back in its conversation.
  Instruction-only Sidekicks give Rally reusable guidance in Canvases.

Interactive artifacts can store their own data and ask a Sidekick to run.
For example, a feedback board can collect votes from teammates while a
Sidekick adds requests from new interview notes. The team can discuss
priorities in the Canvas Chat.

[Open Rally](https://app.rallywith.ai/) · [Read the product manual](https://rallywith.ai/help/)

Rally runs in the browser and on macOS and Linux. This repository also
includes the iOS and Android Canvas client. Cloudflare Workers host the API
and published artifacts, backed by D1, R2, Durable Objects, Queues, and
Workflows. The server routes model requests through the configured inference
providers. The prototype name Avalon remains in some internal identifiers.

## Repository

```text
apps/desktop            Electron main/preload and the React renderer both clients share
apps/browser            Browser host for the shared renderer
apps/mobile             Expo iOS and Android Canvas client
apps/mcp                User-facing MCP server for Canvases and publishing
apps/api                Global and regional Hono Worker, its Durable Objects and runtime components
apps/site               Public site: landing page, help centre, blog, compare and trust pages
apps/engineering-mcp    Internal engineering MCP server
apps/release-retention  Scheduled R2 desktop-release archival Worker
packages/contracts      Shared Zod contracts
packages/db             D1 migrations, repositories, and the explicit local seed
packages/agent-harness  Agent loop, model routing, classifiers, and tool execution
packages/connectors     Connector adapters (Google, GitHub, Linear, Notion, Slack, and others)
packages/electron-network  Chromium upload transport for the Electron main process
packages/ui             Shared desktop/browser components and themes
docs                    Product, architecture, security, and operations
```

## Local setup

Use Node.js 22 or newer and the pnpm version pinned in `package.json`.
Run these commands from a fresh checkout.

```sh
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm env:sync
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Once the Workers are ready, run `pnpm db:open-authority` in another terminal
to load the seeded Canvases and Sidekicks. Use **Use local development
account** to sign in. For browser development, start the API and follow
the browser-origin setup in the development-environment guide before
running `pnpm dev:browser`.

Use [.env.example](.env.example) as the template for local configuration.
Keep server keys in the ignored `.env.local` and reserve `VITE_` for client
configuration. `pnpm env:sync` generates development signing and encryption
material and writes the allowed settings into ignored Worker environment
files. Set `OPENROUTER_API_KEY` and sync the environment again to try model
calls locally.

## Quality commands

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm docs:check
```

## Desktop builds and releases

Before packaging locally, get the existing `RALLY_DESKTOP_SESSION_KEY` from a
desktop release maintainer and set it in the ignored `.env.local`. Both
packaging commands read this file and verify that the key matches existing
installs so the packaged app can open their saved sessions.

```text
pnpm package:desktop
pnpm start:desktop:packaged
pnpm package:desktop:release
pnpm publish:desktop:release -- --dry-run
```

`pnpm package:desktop` builds a Developer ID-signed local QA app into `apps/desktop/release/local`; `pnpm start:desktop:packaged` launches it through macOS LaunchServices against the production Rally APIs. Do not invoke `Rally.app/Contents/MacOS/Rally` directly from a sandboxed terminal. Distribution builds use `pnpm package:desktop:release`, and a live publish requires `--confirm <exact-version>`. Signing, notarization, the Stable and Faster update channels, the version policy and release retention are owned by the operations runbook. The local seed is never run by production startup, and packaged builds disable development authentication regardless of local environment values.

## Brand

The mark is a tennis-ball seam on a sphere, drawn as one line. `scripts/generate-rally-mark.py` generates every vector copy from the seam equation, and `scripts/generate-brand-assets.py` renders the rasters; the macOS app icon is the Icon Composer asset at `apps/desktop/resources/icon.icon`. Brand primary is `#CCFF00` (volt); secondary is `#47C7FC`. The desktop-icons document owns the pipeline; read it before changing the artwork.

## Documentation

[The documentation index](docs/README.md) is the single registry: it lists every product, architecture, agent, connector, development, and operations document with the scope each one owns, and which to read before touching an area. Start there rather than looking for a reading list here.

## License

Rally is dual licensed under the GNU AGPL v3 and a commercial license from
Juno AI Labs Inc. See [LICENSING.md](LICENSING.md) for the terms, what they do
not cover, and the Contributor License Agreement.

## Hosted deployment

Put Cloudflare deployment credentials in your local deployment environment or
the applicable GitHub environment. Use Worker secrets for runtime provider
keys. Rally encrypts account and Organization connector credentials before
storing them. The operations runbook in the documentation index covers
regional secret management, migrations, health verification, and deployment.

## Manual setup for a new hosted deployment

Standing Rally up on fresh Cloudflare, GitHub, Apple and Expo accounts still
takes the one-time steps below. The operations runbook has the exact values and
order for each. The goal is to automate this list away; remove an item here in
the change that automates it.

The deploy workflows already create these, so they are not on the list: R2
buckets a Worker binds (Wrangler creates them on deploy), Queues and their dead-letter queues, D1
databases and KV namespaces (found by name and their ids pinned into the
Wrangler files during the deploy), D1 migrations, Worker custom domains on
existing zones, the engineering MCP's Worker secrets and Access settings, the lakehouse
pipelines (reconciled, with the account's own stream IDs adopted, on a deploy to
any account other than the pinned one).

### Cloudflare account and zones

- Create the account and add the zones `rallywith.ai`, `with-avalon.com` and
  `rallyusercontent.com`.
- Create the deploy API token, scoped to the account and those zones, with the
  permissions the runbook lists. Rotate any broader bootstrap token afterwards.
- Add `*.api.rallywith.ai` to an Advanced Certificate Manager pack (a paid
  add-on) and wait until it is active.
- DNS: a proxied wildcard `AAAA *.rallyusercontent.com -> 100::` for artifact
  hosting, and the `probe-redirect` and `probe-private` records the terminal
  network probes use.
- Zone settings: Always Use HTTPS on, and HSTS with a one-year max-age,
  `includeSubDomains` and `nosniff`.
- Turn on Email Sending and verify `rallywith.ai`, keeping its MX, SPF and DKIM
  records.
- Create the desktop release archive bucket with its location and storage
  class, and attach `downloads.rallywith.ai` as an R2 custom domain on
  `avalon-desktop-releases`.
- Dispatch `deploy-release-retention.yml` once after the archive bucket exists;
  later changes deploy on merge to `main`.
- Set up a Zero Trust team and identity provider, and create the Access
  application and policy for `mcp.internal.rallywith.ai` before its first deploy.
- Make sure Workers Paid, Containers, Browser Run, Images, Workers AI and
  Analytics Engine are available on the account.
- Run `pnpm cloudflare:observability` once for Logpush and the saved
  Observability views. No workflow runs it.

### GitHub repository

Create the environments `api-production`, `site-production`, `desktop-release`
and `mobile-production`, without required reviewers on `api-production`. Each
needs the `CLOUDFLARE_API_TOKEN` secret and the `CLOUDFLARE_ACCOUNT_ID` variable
its workflows read, plus:

- `api-production`: the engineering MCP's Cloudflare tokens, and the Daytona key,
  URL, target and snapshot pull-request token the weekly terminal snapshot
  rebuild uses.
- `desktop-release`: the Apple notarization key, Developer ID certificate and
  password, provisioning profile, desktop session key, a release GitHub token,
  the zone id, and the release and telemetry bucket names.
- `mobile-production`: `EXPO_TOKEN`.

The workflows name every secret and variable they read.

### Third-party providers

Register each by hand and store its credentials as Worker secrets:

- Google: the sign-in and connector OAuth clients, the consent screen and scope
  verification.
- Sign in with Apple: the Services ID, key, domains, return URLs and private
  relay senders.
- The GitHub App, Linear OAuth app, Slack app and Notion connection, from the
  manifests in `config/provider-apps/` (`pnpm notion:webhook:prepare` prepares
  Notion's webhook URL). Apollo, Ashby and Fireflies need registration
  but no server secret.
- Stripe: products, prices, tax settings and the webhook.
- API keys for OpenRouter, Typesafe, Turbopuffer, Firecrawl, twitterapi.io,
  Azure OpenAI and Azure AI Inference, PostHog, and Daytona (then
  `pnpm --filter @rally/api terminal:ensure-webhook` installs the Daytona webhook
  secrets).

### Worker secrets

Set with `wrangler secret put` on the Global API Worker: the locally generated
session, OAuth-state and connector-credential keys; every provider credential
above; the APNs and Web Push keys; and the Stripe keys and billing config.
`apps/api/src/env.ts` declares every secret the Worker reads.

### Apple, Expo and mobile

- An Apple developer team with the desktop and mobile bundle ids (Push and
  Associated Domains on desktop), a Developer ID certificate, an App Store
  Connect API key, an APNs key, and the App Store Connect app record with its
  TestFlight groups.
- An Expo project; store its build credentials with `eas credentials` and
  register test devices with `eas device:create`. Store submission is an explicit
  `eas workflow:run submit.yml`.

### Values a fork must change

The hostnames and senders in the `vars` block of
`apps/api/wrangler.global.jsonc`, the engineering MCP's Access team domain,
`config/regions.json`, the Apple team and App Store Connect ids, the Expo owner,
project id and update URL, and the Worker names that service bindings expect.
