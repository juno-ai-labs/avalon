# Provider app registrations

Avalon uses one public GitHub App and one public Linear app with account-aware regional routing. Providers whose callback model cannot be smart-routed use distinct Global and EU registrations. Provider payloads are persisted and processed only in each connected workspace's selected region.

The source manifests live in `config/provider-apps`. Provider client secrets, signing secrets, and GitHub private keys are never committed.

## Google OAuth clients and APIs

Google platform identity and Google connector consent use two separate Google Cloud OAuth 2.0 **Web application** clients in the same Google Cloud project:

1. **Avalon Login** is used only for platform identity and requests `openid email profile`.
2. **Avalon Google Connectors** is used only for Gmail, Calendar, Drive, Docs, and Sheets connections.

Do not put connector callbacks on the login client or the login callback on the connector client. This keeps platform authentication independent from sensitive/restricted Google Workspace scopes and their verification lifecycle. Enable these APIs in the project that owns the connector client:

- Gmail API
- Google Calendar API
- Google Drive API
- Google Docs API
- Google Sheets API

Register these exact hosted authorized redirect URIs:

| OAuth client | Authorized redirect URI |
| --- | --- |
| Avalon Login | `https://api.with-avalon.com/auth/google/callback` |
| Avalon Google Connectors | `https://api.with-avalon.com/connections/google/callback` |
| Avalon Google Connectors | `https://eu.api.with-avalon.com/connections/google/callback` |

`https://with-avalon.com/auth/desktop/` is Avalon's post-callback browser handoff for login and every connector, and `avalon://auth/complete` is its allowlisted desktop return URI. Provider codes always terminate at the owning API callback first; neither handoff URI is a Google OAuth redirect URI. Add the corresponding `http://127.0.0.1:<port>` API callbacks only to a development client used for local provider testing.

Configure the consent screen for the exact scopes Avalon requests:

| Purpose or capability | Google OAuth scope |
| --- | --- |
| Identity | `openid`, `email`, `profile` |
| `gmail.read` | `https://www.googleapis.com/auth/gmail.readonly` |
| `gmail.draft` | `https://www.googleapis.com/auth/gmail.compose` |
| `gmail.send` | `https://www.googleapis.com/auth/gmail.send` |
| `calendar.read` | `https://www.googleapis.com/auth/calendar.events.readonly` and `https://www.googleapis.com/auth/calendar.calendarlist.readonly` |
| `calendar.write` | `https://www.googleapis.com/auth/calendar.events` |
| `drive.read` | `https://www.googleapis.com/auth/drive.readonly` |
| `docs.read` | `https://www.googleapis.com/auth/documents.readonly` |
| `docs.write` | `https://www.googleapis.com/auth/documents` |
| `sheets.read` | `https://www.googleapis.com/auth/spreadsheets.readonly` |
| `sheets.write` | `https://www.googleapis.com/auth/spreadsheets` |

Settings groups those capabilities into **Google Mail + Calendar** and **Google Drive + Docs + Sheets**, but there is only one `google` provider implementation. Do not register separate OAuth clients merely to represent the two cards. Drive change-token polling supplies Drive, Docs, and Sheets change activity; Avalon does not currently configure Gmail Pub/Sub watches, Calendar notification channels, Drive push notifications, or a Google webhook endpoint.

When a preset contains a write capability, Avalon removes the redundant narrower scope from that authorization request: `gmail.compose` subsumes `gmail.send`, `calendar.events` subsumes `calendar.events.readonly`, `documents` subsumes `documents.readonly`, and `spreadsheets` subsumes `spreadsheets.readonly`. `calendar.calendarlist.readonly` remains so the Calendar connection can identify the user's calendars. Google granular consent is checked at callback time; Avalon refuses to mark a connection healthy when any selected capability was not actually granted.

Google may classify requested user-data scopes as sensitive or restricted, and its classifications or review requirements can change. Before allowing external production users, configure the app home page, privacy policy, authorized domains, support/developer contacts, and test users; move the consent screen out of Testing; and complete Google's verification and any security assessment required for the exact requested scopes. A working callback or test-user consent is not evidence that public verification is complete. Do not publish broader scopes than the two presets request, and do not mark the Google connectors release-ready until both preset flows in `docs/E2E.md` pass.

## GitHub App

Register `github.json` as one public GitHub App installable on any account. Upload `assets/brand/avalon-mark.png`, enable expiring user-to-server tokens, keep SSL verification enabled, and leave device flow and OAuth-during-installation disabled. Keep **Redirect on update** disabled: repository-selection changes arrive through `installation_repositories`, while the setup URL accepts only one-use Avalon install state.

Use these registration values:

| Setting | Value |
| --- | --- |
| Name | `Avalon Workstreams` |
| Description | `Connect GitHub repositories to Avalon work streams and automations.` |
| Homepage URL | `https://with-avalon.com` |
| Callback URLs | `https://api.with-avalon.com/connections/github/callback` and `https://eu.api.with-avalon.com/connections/github/callback` |
| Setup URL | `https://github.with-avalon.com/connections/github/setup` |
| Webhook URL | `https://github.with-avalon.com/ingest/github` |
| Webhook secret | The shared local `GITHUB_WEBHOOK_SECRET` value (or the existing `GITHUB_WEBHOOK_SECRET_GLOBAL` value while migrating) |
| Installability | Any account |

Set repository permissions to **Metadata: read**, **Contents: read**, **Issues: read and write**, **Pull requests: read and write**, **Actions: read**, and **Checks: read**. Leave every other repository, organization, account, and enterprise permission at **No access**. Subscribe to **Push**, **Release**, **Issues**, **Issue dependencies**, **Issue comment**, **Sub-issues**, **Pull request**, **Pull request review**, **Pull request review comment**, **Workflow run**, **Check run**, and **Repository**. GitHub sends the `installation`, `installation_repositories`, and `github_app_authorization` lifecycle events automatically; they do not belong in the explicit event selection. Release requires the existing Contents read permission, while issue dependencies and sub-issues require the existing Issues permission, so these subscriptions do not broaden App access.

The shared setup and webhook host, `github.with-avalon.com`, runs on Avalon's Global ingress Worker. It verifies GitHub's signature before parsing, maps an installation to every Avalon region where it is connected, and forwards the exact signed bytes over a Worker service binding. Each regional Worker verifies the delivery again before regional persistence and processing. OAuth callbacks remain regional so user tokens never cross the selected boundary.

Capture the app ID, client ID, client secret, slug, webhook secret, and PEM private key, then install the same App configuration in both regional Workers. The webhook secret must be byte-identical in both. GitHub supports multiple App private keys, so production may use a separate key per regional Worker without creating another App.

The registered production App is `Avalon Workstreams` with slug `avalon-workstreams`.

The setup URL is deliberately separate from the OAuth callback. Avalon first validates the installation with an app JWT, then starts a one-use PKCE user authorization and proves that the authorizing user can access that installation.

## Linear OAuth app

The researched protocol, surface model, event matrix, and native-agent launch gate are documented in [LINEAR_INTEGRATION.md](LINEAR_INTEGRATION.md).

Register `linear.json` as one public Linear OAuth app. Public distribution permits installation by other workspaces; listing it in Linear's integration directory is a separate review. The manifest registers both regional callback URLs and the single webhook URL `https://linear.with-avalon.com/ingest/linear`. It is the production-safe resource configuration and intentionally does not subscribe to `AgentSessionEvent` or `AppUserNotification`.

Avalon uses Authorization Code with PKCE S256. The same public app requests `actor=user` for a personal, owner-only connection and `actor=app` for a workspace connection whose capabilities roll down to every Avalon workspace member. The selected, workspace-only `linear.agent` capability requests `app:assignable` and `app:mentionable`, making Avalon a delegatable and mentionable app user, plus `write` so the host can immediately acknowledge activation with a reaction. Resource tools request only their corresponding `read`, `issues:create`, `comments:create`, or `write` scopes. Never add `admin`; Linear app actors do not support it. The callback verifies the returned actor, identity, organization, and every selected scope before marking the connection healthy.

The shared Global ingress verifies the exact signed body and timestamp before reading its organization ID. It retains only an opaque organization-to-region route and sends the untouched bytes over a Worker service binding to each owning region, where the signature is verified again before regional persistence. An installation-race delivery with no route returns a retryable error and is not retained in Global, which prevents an EU payload from being stored outside the EU boundary.

Only workspace app connections register for this real-time routing today. Personal Linear connections support private interactive tools and scheduled queries. Do not route organization-wide webhooks to personal connections until the regional durable inbox can prove the owner's access to each signed resource before owner-only activity routing.

`linear-native-agent.preview.json` is a later configuration snapshot for that **same app**, not a second Linear registration. Apply it only after the native-session acceptance gate passes. Linear exposes Agent Session UI as soon as `AgentSessionEvent` is subscribed, even for debugging, so enabling the subscription before Avalon can acknowledge the session and publish activity within Linear's deadlines creates a broken public experience.

Store the same client ID, client secret, and webhook signing secret in both regional Workers. Linear's native Agent APIs are still Developer Preview. Enabling the surface requires an `operational` native-agent runtime, `VITE_LINEAR_NATIVE_AGENT_ENABLED=true` in the desktop build, and `LINEAR_NATIVE_AGENT_ENABLED=true` in each regional Worker; these controls do not replace updating the one registered app to the preview manifest.

## Notion public connection

Create two public Notion connections in the Notion Developer portal:

| Setting | Global | EU |
| --- | --- | --- |
| Name | Avalon Global | Avalon EU |
| Installation scope | Any workspace | Any workspace |
| Redirect URI | `https://api.with-avalon.com/connections/notion/callback` | `https://eu.api.with-avalon.com/connections/notion/callback` |
| Webhook URL | `https://api.with-avalon.com/ingest/notion?setup=<regional setup token>` | `https://eu.api.with-avalon.com/ingest/notion?setup=<regional setup token>` |

Use the read, insert, update, comment-read, and comment-insert capabilities and upload `assets/brand/avalon-mark.png`. A public Notion connection can be installed into any workspace permitted by its immutable installation scope. Marketplace publication is a separate, optional review.

When the webhook subscription is created, Notion sends a one-time `verification_token`. Avalon accepts it only when the regional setup token matches, encrypts it in D1, and uses it for every later `X-Notion-Signature` check. Do not paste that token into logs or source control.

## Regional Worker secrets

Install the platform login client only on the Global Worker:

- `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`

Install the separate Google service connector client in both regional Workers so each region can complete connector OAuth and refresh connector tokens:

- `GOOGLE_CONNECTOR_OAUTH_CLIENT_ID`, `GOOGLE_CONNECTOR_OAUTH_CLIENT_SECRET`

Global and EU use the same public GitHub App identity and webhook secret:

- `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_SLUG`, `GITHUB_WEBHOOK_SECRET`
- `GITHUB_APP_PRIVATE_KEY` may be a distinct private key generated by that same App for each region.

Global and EU use the same public Linear app identity and webhook secret:

- `LINEAR_OAUTH_CLIENT_ID`, `LINEAR_OAUTH_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET`

Global and EU use the same public Slack Marketplace app identity and request-signing secret:

- `SLACK_APP_ID`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`
- The source manifest is `config/provider-apps/slack.json`; `slack manifest validate` reads it through the checked-in `.slack` hook.
- OAuth callbacks are regional. Events, interactivity, commands, and unfurls use `https://slack.with-avalon.com` and the opaque team router.
- Do not create separate regional Slack apps: that would split Marketplace/MCP identity and break team-route uniqueness.

See `docs/SLACK_PERMISSIONS.md` for the exact scope-to-tool mapping and
`docs/SLACK_INTEGRATION.md` for scope rationale, user linking, App Home,
zero-copy behavior, automation delivery, review evidence, and acceptance tests.

Global and EU each need region-specific values for:

- `NOTION_OAUTH_CLIENT_ID`, `NOTION_OAUTH_CLIENT_SECRET`, `NOTION_INTEGRATION_ID`, `NOTION_WEBHOOK_SETUP_TOKEN`

Both regions need `TWITTER_API_IO_API_KEY` to expose the read-only X connector.

Both regions also need `FIRECRAWL_API_KEY`. The agent's web search and page fetch tools are omitted entirely when it is absent.
