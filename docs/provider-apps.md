# Provider app registrations

Rally registers **one public app per provider** and routes each account to its
own region, rather than registering a Global app and an EU app. Providers whose
callback model cannot be smart-routed are the exception and use distinct
registrations. Provider payloads are persisted and processed only in each
connected workspace's selected region.

This document is the registration reference: the exact settings, redirect URIs,
scopes, permissions, and Worker secrets each provider app needs, and the reasons
behind the shapes that look arbitrary. Read it before changing a registration, a
callback URL, a requested scope, or a manifest in `config/provider-apps`. Provider
client secrets, signing secrets, and GitHub private keys are never committed.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `config/provider-apps/github.json` | The GitHub App manifest that is registered. |
| `config/provider-apps/linear.json` | The production Linear resource manifest. |
| `config/provider-apps/linear-native-agent.preview.json` | A later configuration snapshot for that **same** Linear app. |
| `config/provider-apps/slack.json` | The Slack app manifest; `slack manifest validate` reads it through the checked-in `.slack` hook. |
| `packages/connectors/src/*.ts` | The adapter each registration serves. |
| `apps/api/src/routes/connections.ts` | Every regional OAuth callback. |
| `apps/api/src/*-routing-bridge.ts`, `apps/api/src/services/*-routing-service.ts` | The Global account-to-region directories the shared ingresses consult. |
| `apps/api/src/lib/notion-ingress.ts`, `github-install-state.ts` | The two ingresses with non-obvious state handling. |

## How it works

### The zero-copy connector boundary

In Rally, **zero-copy means we do not recreate a connected product inside
Rally**. A connector must not turn the provider into a parallel inbox, channel
browser, document store, source-of-truth database, or generally searchable
replica.

Zero-copy does not mean that no provider data may cross the boundary, that Rally
cannot subscribe to activity, or that every byte must remain transient. Rally may
receive webhooks, poll incremental changes, retain bounded normalized trigger
evidence and provenance, fetch authorized task-specific context on demand, and
persist the prompts, work history, outputs, and receipts needed to perform
user-requested work. Those copies must serve a Rally task, automation, audit, or
reliability function; they must not accumulate into a replacement for the connected
product.

A connector review therefore asks whether each ingestion, read, and retention path
is purpose-bound, authorization-preserving, and bounded — not whether the
implementation literally stores zero copies.

### Google OAuth clients and APIs

Google platform identity and Google connector consent use **two separate** Google
Cloud OAuth 2.0 *Web application* clients in the same Google Cloud project:

1. **Rally Login** is used only for platform identity and requests
   `openid email profile`.
2. **Rally Google Connectors** is used only for Gmail, Calendar, Drive, Docs, and
   Sheets connections.

Enable these APIs in the project that owns the connector client: Gmail API, Google
Calendar API, Google Drive API, Google Docs API, Google Sheets API.

Register these exact hosted authorized redirect URIs:

| OAuth client | Authorized redirect URI |
| --- | --- |
| Rally Login | `https://api.rallywith.ai/auth/google/callback` |
| Rally Google Connectors | `https://api.rallywith.ai/connections/google/callback` |
| Rally Google Connectors | `https://eu.api.rallywith.ai/connections/google/callback` |

`https://rallywith.ai/auth/desktop/` is Rally's post-callback browser handoff
for login and every connector, and `rallywithai://auth/complete` is its allowlisted
desktop return URI. Provider codes always terminate at the owning API callback
first; **neither handoff URI is a Google OAuth redirect URI.** Add the
corresponding `http://127.0.0.1:<port>` API callbacks only to a development client
used for local provider testing.

Configure the consent screen for the exact scopes Rally requests:

| Purpose or capability | Google OAuth scope |
| --- | --- |
| Identity | `openid`, `email`, `profile` |
| `gmail.read`, `gmail.draft`, `gmail.send` | `https://www.googleapis.com/auth/gmail.modify` |
| `calendar.read` | `https://www.googleapis.com/auth/calendar.readonly` |
| `calendar.write` | `https://www.googleapis.com/auth/calendar.events` |
| `drive.read`, `docs.read`, `sheets.read` | `https://www.googleapis.com/auth/drive.readonly` |
| `docs.write`, `sheets.write` | `https://www.googleapis.com/auth/drive.file` |

Settings groups those capabilities into **Google Mail + Calendar** and **Google
Drive + Docs + Sheets**, but there is only one `google` provider implementation.
Drive change-token polling supplies Drive, Docs, and Sheets change activity; Rally
does not currently configure Gmail Pub/Sub watches, Calendar notification channels,
Drive push notifications, or a Google webhook endpoint.

The capability-to-scope mapping deliberately matches the scopes approved for the
production connector client. `gmail.modify` covers Rally's Gmail reads, drafts,
and sends; Rally does not expose its additional mailbox-mutation authority.
`drive.readonly` covers Drive discovery and native Docs/Sheets reads. `drive.file`
covers Docs/Sheets creation and edits only for files created by Rally or
explicitly opened or shared with Rally; arbitrary existing files discovered
through Drive remain read-only. Google granular consent is checked at callback
time, and Rally refuses to mark a connection healthy when any selected capability
was not actually granted.

### GitHub App

Register `github.json` as one public GitHub App installable on any account. Upload
`assets/brand/rally-mark.png`, enable expiring user-to-server tokens, keep SSL
verification enabled, and leave device flow and OAuth-during-installation disabled.
Keep **Redirect on update** disabled: repository-selection changes arrive through
`installation_repositories`, while the setup URL accepts only one-use Rally
install state.

| Setting | Value |
| --- | --- |
| Name | `Rally With AI` |
| Description | `Connect GitHub repositories to Rally work streams and automations.` |
| Homepage URL | `https://rallywith.ai` |
| Callback URLs | `https://api.rallywith.ai/connections/github/callback`, `https://eu.api.rallywith.ai/connections/github/callback`, `https://api.with-avalon.com/connections/github/callback`, and `https://eu.api.with-avalon.com/connections/github/callback` |
| Setup URL | `https://github.rallywith.ai/connections/github/setup` |
| Webhook URL | `https://github.rallywith.ai/ingest/github` |
| Webhook secret | The shared local `GITHUB_WEBHOOK_SECRET` value (or the existing `GITHUB_WEBHOOK_SECRET_GLOBAL` value while migrating) |
| Installability | Any account |

Set repository permissions to **Metadata: read**, **Contents: read and write**, **Issues:
read and write**, **Pull requests: read and write**, **Actions: read**, and
**Checks: read**. Leave every other repository, organization, account, and
enterprise permission at **No access**. Subscribe to **Push**, **Release**,
**Issues**, **Issue dependencies**, **Issue comment**, **Sub-issues**, **Pull
request**, **Pull request review**, **Pull request review comment**, **Workflow
run**, **Check run**, and **Repository**. GitHub sends the `installation`,
`installation_repositories`, and `github_app_authorization` lifecycle events
automatically; they do not belong in the explicit event selection. Release requires
Contents read, while Terminal's `full_access` policy mints a single-repository token
with Contents write so standard `git push` works. The App registration therefore
keeps the write ceiling. Terminal bootstrap and publisher tokens are narrowed to
the selected repository and effective access level. The general connector token
inherits the installation's selected repositories and installed permission ceiling;
its exposed tools remain independently capability-gated and include no Contents
write operation. Issue dependencies and sub-issues require the existing Issues
permission, so those subscriptions do not broaden App access.

The shared setup and webhook host, `github.rallywith.ai`, runs on Rally's
Global ingress Worker. It verifies GitHub's signature before parsing, maps an
installation to every Rally region where it is connected, and forwards the exact
signed bytes over a Worker service binding. Each regional Worker verifies the
delivery again before regional persistence and processing. OAuth callbacks remain
regional so user tokens never cross the selected boundary.

The setup URL is deliberately separate from the OAuth callback: Rally first
validates the installation with an app JWT, then starts a one-use PKCE user
authorization and proves that the authorizing user can access that installation.

Capture the app ID, client ID, client secret, slug, webhook secret, and PEM private
key, then install the same App configuration in both regional Workers. The webhook
secret must be byte-identical in both. GitHub supports multiple App private keys, so
production may use a separate key per regional Worker without creating another App.
The registered production App is `Rally With AI` with slug `rally-with-ai`.
Renaming a GitHub App changes the slug GitHub uses in installation URLs. Update
`GITHUB_APP_SLUG` in the EU Worker and then the Global Worker in the same change
window, and run `pnpm health:regions`; otherwise existing installation tokens keep
working but every new connection starts at a dead App URL.

### Linear OAuth app

Register `linear.json` as one public Linear OAuth app. Public distribution permits
installation by other workspaces; listing it in Linear's integration directory is a
separate review. The manifest registers both regional callback URLs and the single
webhook URL `https://linear.rallywith.ai/ingest/linear`. It is the
production-safe resource configuration and intentionally does not subscribe to
`AgentSessionEvent` or `AppUserNotification`.

The existing production registration keeps its client ID, client secret, signing
secret, installation base, scopes, and event selections. Its public registration
must match this table:

| Setting | Value |
| --- | --- |
| Name | Rally |
| Developer | Juno AI Labs |
| Developer URL | `https://rallywith.ai` |
| Description | Bring Linear issues, projects, documents, and updates into Rally work streams. |
| Redirect URIs | Both `rallywith.ai` callbacks followed by both `with-avalon.com` compatibility callbacks from `linear.json` |
| Webhook URL | `https://linear.rallywith.ai/ingest/linear` |
| Publicly available | Enabled |

The compatibility callbacks remain registered during the domain migration. Do
not create a second app or rotate credentials for this public-identity change.

Rally uses Authorization Code with PKCE S256. The same public app requests
`actor=user` for a personal, owner-only connection and `actor=app` for a workspace
connection whose capabilities roll down to every Rally workspace member. The
selected, workspace-only `linear.agent` capability requests `app:assignable` and
`app:mentionable`, making Rally a delegatable and mentionable app user, plus
`write` so the host can immediately acknowledge activation with a reaction.
Resource tools request only their corresponding `read`, `issues:create`,
`comments:create`, or `write` scopes. The callback verifies the returned actor,
identity, organization, and every selected scope before marking the connection
healthy.

The shared Global ingress verifies the exact signed body and timestamp before
reading its organization ID. It retains only an opaque organization-to-region route
and sends the untouched bytes over a Worker service binding to each owning region,
where the signature is verified again before regional persistence. Workspace app
connections receive matching real-time resource deliveries directly. Personal Linear
connections also participate in organization routing, but the regional Worker must
prove the owner's access to the signed resource or a signed parent with that
personal token before creating an owner-only activity.

Store the same client ID, client secret, and webhook signing secret in both
regional Workers. `linear-native-agent.preview.json` is a later configuration
snapshot for that **same app**, applied only after the native-session acceptance
gate passes. [`linear-integration.md`](linear-integration.md) owns the protocol,
surface model, event matrix, and that gate.

### Notion public connection

The personal Notion connection uses the official hosted MCP server at
`https://mcp.notion.com/mcp`. It requires no second Notion Developer portal app,
client ID, client secret, webhook, or checked-in provider manifest. Rally uses
MCP OAuth discovery and dynamic client registration for each authorization,
with PKCE and the shared
`https://notion.rallywith.ai/connections/notion/callback` redirect. The DCR
client and rotating credentials are encrypted in the member's owning region.
New dynamic registrations identify the OAuth client as `Rally`, and every new
hosted-MCP session sends `clientInfo.name = "Rally"`. Existing encrypted DCR
client IDs, refresh tokens, and connection records remain valid; they are reused
until the provider itself requires a new registration or authorization.
The public connection below is still required for the separate workspace bot
and webhook mode. The API registers personal Notion even when the public client
ID and secret are absent; attempting workspace authorization in that state fails
with an explicit configuration error rather than hiding personal MCP too.

Create **one** public Notion connection in the Notion Developer portal, serving
both regions:

| Setting | Value |
| --- | --- |
| Name | Rally |
| Installation scope | Any workspace |
| Redirect URI | `https://notion.rallywith.ai/connections/notion/callback` |
| Webhook URL | Run `pnpm notion:webhook:prepare` and paste the URL it copies |

A Rally workspace owner or administrator initiates installation. The authorize
URL deliberately uses Notion's `owner=user`, because public OAuth needs a human
approver and page picker; do not change that parameter to model Rally scope.
Rally stores the resulting bot grant as a workspace connection with no user
owner. The approver's Notion identity remains encrypted metadata, while edits and
comments made through the API appear as the Rally integration bot.

A Notion connection accepts one redirect URI and delivers to one webhook URL, and
it has no way to know which region a Notion workspace belongs to — so unlike Linear
and Slack, its callbacks cannot be regional. Both URLs are the Global ingress,
which routes each callback and delivery to the owning region;
`notion.rallywith.ai` must exist as a custom domain on `avalon-api-global`
before registration. [`notion-ingress.md`](notion-ingress.md) owns that design.

Use the read, insert, update, comment-read, and comment-insert capabilities and
upload `assets/brand/rally-mark.png`. A public Notion connection can be installed
into any workspace permitted by its immutable installation scope. Marketplace
publication is a separate, optional review.

Apply migration `0071_notion_webhook_setup_nonces.sql` and deploy the API before
preparing the URL. `pnpm notion:webhook:prepare` writes only a SHA-256 nonce hash
to Global D1 and copies a URL whose plaintext nonce expires after 30 minutes. It
replaces the current generation in one D1 transaction, and the database permits
only one current generation, so concurrent preparation cannot leave two live URLs.

Create the subscription with that URL. Notion sends a one-time
`verification_token`; the ingress atomically binds the nonce to that token,
encrypts the token in D1, and replicates it to EU so that region can verify
signatures for itself. Run `pnpm notion:webhook:copy-token` to decrypt the Global
row locally and copy the plaintext directly to the clipboard, then paste it into
Notion's **Verify subscription** dialog. Neither command prints the nonce, URL,
or verification token. The copy command refuses until the encrypted row is linked
to the current consumed nonce and its plaintext hash matches that nonce's token
binding. The token then signs every later `X-Notion-Signature`.

Notion does not allow an existing subscription's URL to be edited. To move an
active compatibility-host subscription, first prepare the fresh Rally URL, then
delete and recreate the subscription with the same API version and event
selection, and complete the verification flow above. The compatibility ingress
remains served until that cutover; deleting first without a prepared URL creates
an avoidable delivery gap.

### Slack app

One public Slack Marketplace app serves both regions. OAuth callbacks are regional;
events, interactivity, commands, and unfurls use `https://slack.rallywith.ai`
and the opaque team router. Enable Slack's **Delayed Events** retry option: Rally
verifies requests immediately, admits work through an idempotent regional ingress
job, and enforces a 2.6-second end-to-end response budget.
[`slack-permissions.md`](slack-permissions.md) owns the scope-to-tool mapping and
[`slack-integration.md`](slack-integration.md) owns scope rationale, user linking,
App Home, zero-copy behavior, automation delivery, review evidence, and acceptance
tests.

### Regional Worker secrets

Install the platform login client **only on the Global Worker**:

- `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`

Install the separate Google service connector client in **both** regional Workers,
so each region can complete connector OAuth and refresh connector tokens:

- `GOOGLE_CONNECTOR_OAUTH_CLIENT_ID`, `GOOGLE_CONNECTOR_OAUTH_CLIENT_SECRET`

Global and EU share one public GitHub App identity and webhook secret:

- `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`,
  `GITHUB_APP_SLUG`, `GITHUB_WEBHOOK_SECRET`
- `GITHUB_APP_PRIVATE_KEY` may be a distinct private key generated by that same App
  for each region.
- `GITHUB_APP_SLUG` must equal the live GitHub URL slug exactly. The current value
  is `rally-with-ai` in both regions.

Global and EU share one public Linear app identity and webhook secret:

- `LINEAR_OAUTH_CLIENT_ID`, `LINEAR_OAUTH_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET`

Global and EU share one public Slack Marketplace app identity and request-signing
secret:

- `SLACK_APP_ID`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`

Global and EU share the same single public Notion connection identity:

- `NOTION_OAUTH_CLIENT_ID`, `NOTION_OAUTH_CLIENT_SECRET`, `NOTION_INTEGRATION_ID` —
  identical in both regions, because there is one connection. Webhook setup has
  no long-lived Worker secret; the operator command stores a short-lived nonce
  hash in Global D1.

Both regions need `TWITTER_API_IO_API_KEY` to expose the read-only X connector, and
`FIRECRAWL_API_KEY` for the agent's web search and page fetch tools.

## Invariants

- **One public app per provider, routed by account.** Separate regional
  registrations split Marketplace and directory identity and break route
  uniqueness; do not create them for GitHub, Linear, Slack, or Notion.
- **Connector callbacks never go on the login client, and the login callback never
  goes on a connector client.** That separation is what keeps platform
  authentication independent of sensitive and restricted Google Workspace scopes
  and their verification lifecycle.
- **A provider code always terminates at the owning regional API callback first.**
  `https://rallywith.ai/auth/desktop/` and `rallywithai://auth/complete` are Rally's
  own handoff, never a provider redirect URI.
- **The webhook secret is byte-identical in both regions**, for every provider whose
  ingress is shared. The signature is verified at the ingress *and again* in the
  owning region; a per-region secret makes the second check fail.
- **Never request `admin` from Linear.** Linear app actors do not support it.
- **An organization or team ID match is never authorization.** A personal
  connection must prove access with its own token before an activity is created for
  it.
- **`linear-native-agent.preview.json` updates the one registered Linear app.**
  Registering it separately creates a second app and splits every installation.
- **The Linear production manifest does not subscribe to `AgentSessionEvent`.**
  Subscribing exposes Agent Session UI to customers immediately, even when added
  only for debugging.
- **Do not publish broader Google scopes than the two presets request.** The
  capability mapping matches the scopes approved for the production client; adding
  one re-opens verification.
- **The Notion `verification_token` is accepted only by an unexpired one-time
  setup nonce**, is encrypted in D1, and never appears in logs or source control.
  A consumed nonce is bound to the first token it sees, and a superseded nonce
  cannot restore an earlier signing secret.
- **`notion.rallywith.ai` exists as a custom domain on `avalon-api-global`
  before the connection is registered**, or the one redirect URI Notion accepts
  points at nothing.

## Boundary

This document owns what is registered with each provider and which secrets each
region holds. It does not own the adapters behind those registrations, or the
routing machinery the shared ingresses use:

| For | Read |
| --- | --- |
| The registry, manifest model, and adapter invariants | [`connectors.md`](connectors.md) |
| The region boundary the shared ingresses sit on | [`regionalization.md`](regionalization.md) |
| Linear's protocol, event matrix, and native-agent gate | [`linear-integration.md`](linear-integration.md) |
| Slack's product boundary and scope rationale | [`slack-integration.md`](slack-integration.md), [`slack-permissions.md`](slack-permissions.md) |
| The single Notion ingress design | [`notion-ingress.md`](notion-ingress.md) |
| Setting the secrets on a hosted Worker | [`runbook.md`](runbook.md) |
| Credential encryption and webhook verification rules | [`security.md`](security.md) |

## Failure modes and limits

- **A Linear installation-race delivery with no route returns a retryable error and
  is not retained in Global**, which is what prevents an EU payload from being
  stored outside the EU boundary. The same rule holds for Notion, which answers
  `503`.
- **A Slack event that misses the durable-admission budget returns `503`** so Slack
  retries the same event identity, rather than being acknowledged and lost.
- **A Google connection with any ungranted selected capability is not marked
  healthy.** Granular consent means a successful callback is not evidence of a
  complete grant.
- **A working callback or test-user consent is not evidence that public Google
  verification is complete.** Google may classify requested user-data scopes as
  sensitive or restricted, and its classifications or review requirements can
  change. Before allowing external production users: configure the app home page,
  privacy policy, authorized domains, support and developer contacts, and test
  users; move the consent screen out of Testing; and complete Google's verification
  and any security assessment required for the exact requested scopes. Do not mark
  the Google connectors release-ready until both preset flows in
  [`e2e.md`](e2e.md) pass.
- **Linear's native Agent APIs are still Developer Preview.** Enabling the surface
  requires an `operational` native-agent runtime,
  `VITE_LINEAR_NATIVE_AGENT_ENABLED=true` in the desktop build, and
  `LINEAR_NATIVE_AGENT_ENABLED=true` in each regional Worker — and none of those
  replace updating the one registered app to the preview manifest.
- **The agent's web search and page fetch tools are omitted entirely when
  `FIRECRAWL_API_KEY` is absent.** They degrade to nonexistent, not to failing.

## Testing

A registration lives at the provider, so most of it cannot be asserted from this
repository. What can be:

- `slack manifest validate` reads `config/provider-apps/slack.json` through the
  checked-in `.slack` hook — run it after editing that manifest.
- `packages/connectors/src/*.test.ts` cover the scope derivation, callback
  verification, and webhook normalization each registration is paired with; run one
  with `pnpm --filter @rally/connectors exec vitest run src/<name>.test.ts`.
- `apps/api/test/*-routing.test.ts` cover the account-to-region directories the
  shared ingresses consult.
- The manual provider acceptance flows in [`e2e.md`](e2e.md) are the only check
  that a registration's redirect URIs, permissions, and event subscriptions match
  what this document says. A change here that is not exercised there is unverified.

## Changelog

### 2026-08-25 — Linear and Notion registrations moved without new app identities

**What changed:** The registration guide now records the live Rally identity for
the existing Linear app and Notion public connection. Linear keeps both legacy
callbacks while its canonical webhook and public metadata move to Rally. New
Notion hosted-MCP dynamic registrations and sessions identify as Rally. Moving an
active Notion webhook is documented as a prepared delete-and-recreate cutover
because Notion makes the subscription URL immutable.

**Why:** Provider dashboards, consent screens, and request logs were still
publishing Avalon even though the product and canonical ingress hosts are Rally.
The identity update must not be mistaken for authority to rotate credentials,
replace existing installations, or drop compatibility callbacks.

**Considered and rejected:** Creating new Linear or Notion apps. That would split
installations, credentials, webhook delivery, and OAuth state for a cosmetic
rename. Deleting the Notion webhook before preparing its one-use setup URL was
also rejected because it lengthens the delivery gap with no benefit.

**Consequences:** Existing OAuth grants and encrypted hosted-MCP credentials stay
valid. Linear may be edited in place. Notion's public metadata may be edited in
place, but its webhook host changes only through the explicit recreate and
verification flow. The reasoning behind provider-app decisions before the
existing changelog began was not reconstructed.

### 2026-08-25 — The GitHub App registration became Rally With AI

**What changed:** The one production GitHub App kept its App ID, credentials,
installation, repository selection, permissions, and events while its public name,
description, homepage, logo provenance, canonical callbacks, setup URL, webhook
URL, and slug moved to Rally. Compatibility callbacks stay registered during the
domain migration. The checked-in manifest now records the live `rally-with-ai`
registration and the Contents-write ceiling used by Terminal `full_access`.

**Why:** Renaming the provider page without rotating `GITHUB_APP_SLUG` left new
connection attempts pointing at the removed `avalon-workstreams` URL. The earlier
manifest also described Contents read even though production and the token minting
path require write access for ordinary Git pushes.

**Considered and rejected:** Creating a second App or reinstalling the renamed one.
That would split the public identity, App credentials, webhook routing, and existing
installation for a cosmetic rename. Reducing Contents to read was also rejected
because it would turn every configured `full_access` repository into a broken write
path.

**Consequences:** A future App rename must rotate the slug secret in EU and Global
and pass regional health plus a fresh installation start. Terminal bootstrap and
publisher tokens stay narrowed per repository and policy even though the App's
installed ceiling permits Contents writes. General connector tokens retain the
installation selection and installed permission ceiling, with capability checks
controlling which operations Rally exposes.

### 2026-08-12 — Public Notion credentials gate only workspace mode

**What changed:** The Notion adapter is registered with its shared redirect URI
even when no public-integration client ID and secret are configured. Workspace
OAuth operations require the pair at the point of use.

**Why:** Personal hosted MCP dynamically registers its own OAuth client and does
not use the public integration. Gating the whole adapter on workspace secrets
made the supposedly independent personal mode unavailable.

**Considered and rejected:** Registering two Notion provider types. They share
one product card and callback router, and splitting them would duplicate the
connection lifecycle merely to express optional configuration.

**Consequences:** Personal-only environments can connect Notion. The workspace
button may still be shown by the connector-level catalog, but starting it returns
the specific missing-public-integration error; production environments offering
workspace mode continue storing the same credentials in both Workers.

Shipped in the pull request for this change.

### 2026-08-12 — Personal Notion MCP needs no developer registration

**What changed:** The registration guide now separates the hosted personal MCP
flow, which discovers and dynamically registers an OAuth client, from the one
public integration used for workspace bot installs and webhooks.

**Why:** Reusing `NOTION_OAUTH_CLIENT_ID` and its public-integration secret for a
personal MCP connection would couple two provider identities and bypass the
official server's advertised authorization flow. Asking operators to create a
second static registration would duplicate something the server creates through
DCR.

**Considered and rejected:** A separate callback or a second manually registered
Notion connection for personal use. Neither changes the regional destination of
the token, and both add provider configuration the standards-based flow does not
need.

**Consequences:** The existing Notion secrets remain required in both Workers
for workspace mode only. A personal MCP outage or DCR change is diagnosed at
the hosted server boundary, not by editing the public connection dashboard.

Shipped in the pull request for this change.

### 2026-08-12 — Notion's user approver installs a Rally workspace bot

**What changed:** The registration guide now distinguishes Notion's required
`owner=user` OAuth parameter from Rally's workspace-only connection scope. An
Rally owner or administrator authorizes the selected pages, the regional row has
no user owner, and the installed bot is the provider actor.

**Why:** The provider dashboard and token response name the approving user, which
made it tempting to classify the connection as personal. That classification was
wrong for the product surface: the integration bot authors mutations and the
selected pages are intended as a shared Rally workspace capability. Changing the
provider parameter was rejected because it would break the public OAuth contract
rather than change Rally's authorization model.

### 2026-08-12 — Notion setup secrets leave the webhook URL and Cloudflare logs

**What changed:** Notion's reusable `NOTION_WEBHOOK_SETUP_TOKEN` was replaced by
a 30-minute, single-use nonce prepared in Global D1. Two operator commands copy
the subscription URL and the captured verification token directly to the local
clipboard without printing either. Recreating a subscription prepares a new
current generation in one D1 transaction; its first challenge supersedes every
older nonce, and an older in-flight request cannot win the ciphertext write in
Global or arrive late and overwrite a newer EU replica.

**Why:** Cloudflare records full request URLs independently of Rally's logger,
so a reusable query-string guard became a 90-day credential in Workers Logs and
Logpush. Logging the verification token instead would be worse: it is the HMAC
secret for every later delivery. A public reveal endpoint was rejected because
it would add a remotely reachable secret-reading surface solely for a one-time
operator action. The D1-and-local-clipboard path keeps the only plaintext handoff
on the operator's machine, while token-binding and supersession retain safe
retries without letting an old URL rotate the active secret.

Earlier registration reasoning was not recorded in a changelog; the prose above,
`git log`, and the PRDs under `docs/PRDs/` are the surviving record.
