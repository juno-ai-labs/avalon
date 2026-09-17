# Canva platform research

> Read 2026-09-17 from Canva's published documentation. Everything here is
> documentation, not live observation: no Canva integration has been registered
> and no delivery has been received. Anything marked **unverified** must be
> confirmed against the live provider before it is built against, and the
> confirmation recorded in [`provider-apps.md`](../../provider-apps.md) with its
> date, the way Fireflies' and Ashby's were.

## The two platforms, and which one is which

Canva ships two developer surfaces, and they are not alternatives to each other.
They authenticate differently, they are registered differently, and only one of
them emits events.

| | Connect APIs | Canva MCP |
| --- | --- | --- |
| What it is | A REST API over designs, folders, assets, comments, brand templates, exports, autofill, imports, resizes, merges, analytics | A remote Streamable HTTP MCP server |
| Endpoint | `https://api.canva.com/rest/v1/…` | `https://mcp.canva.com/mcp` |
| Registration | An integration in the [Developer Portal](https://www.canva.com/developers/), client ID + client secret | A redirect URI allowlisted by Canva; OAuth client identified by CIMD |
| Authorization | OAuth 2.0 authorization code + PKCE, per Canva user | OAuth, per Canva user |
| Events | Webhook notifications (preview) | None |
| Tenancy | Per user. There is no team or service credential | Per user, explicitly: permissions are "per-user basis, not at the organization level" |

Sources:
[Connect overview](https://www.canva.dev/docs/connect/),
[MCP overview](https://www.canva.dev/docs/mcp/),
[Creating integrations](https://www.canva.dev/docs/connect/creating-integrations/).

## Canva MCP

- **One endpoint, one transport.** `https://mcp.canva.com/mcp`, Streamable HTTP.
  Canva documents `mcp-remote` over stdio only for clients that cannot speak
  remote MCP; Rally can, so it is irrelevant here.
- **CIMD is the recommended client identity.** The OAuth `client_id` is an HTTPS
  URL serving a JSON document describing the client, so no client is
  pre-registered and no client secret is held. **Dynamic Client Registration is
  documented as deprecated** in favour of CIMD, though still accepted for
  backward compatibility. This is the first provider Rally would meet where the
  hosted-MCP helper's DCR path is the deprecated one.
- **The redirect URI must be allowlisted by Canva, by application.** Canva's
  documented route is a [waitlist
  form](https://www.canva.dev/docs/mcp/) reviewed for "brand alignment, trust and
  safety considerations, compliance readiness, technical fit, and strategic
  alignment". Canva states that many established AI tools already have access.
  This is a business gate on a calendar Rally does not control, and it blocks
  the personal connection entirely — not partially.
- **Documented capability areas** (Canva publishes no tool list): design
  generation, design editing, design discovery, asset and brand management,
  design export, collaborative commenting.
- **Per-user only.** "Each user needs to authenticate", and each needs their own
  Canva account. There is no organization-level MCP connection to build.

**Unverified:** the live `tools/list` catalog, the authorization-server metadata
(scopes published, whether a refresh token is issued), and whether Canva's server
assigns an MCP session ID. Rally's pass-through does not need the catalog — it
must not be copied into source — but the metadata decides whether a personal
connection can renew itself or must be reconnected, which is the thing Fireflies
taught us to check before shipping rather than after.

## Connect API webhook notifications

### Configuration is per integration, not per connection

In the Developer Portal, under **Notifications**, an integration enables
`collaboration:event` and enters **one Webhook URL**. That is the entire
configuration surface. There is no webhook API, no per-user subscription, no
per-event toggle, and no way for Rally to register or rotate anything
programmatically.

Three consequences follow, and they shape the whole design:

1. **One URL serves every Canva user who has authorized the integration**, in
   every Canva team, for every Rally workspace. Routing is Rally's problem, and
   the payload is the only thing that can solve it.
2. **Enabling notifications enables all eleven event types.** "Which events do we
   subscribe to" is not a question Canva lets anyone answer. The only choice
   available is which delivered events Rally ingests and which it refuses.
3. **Registration, rotation and removal are manual**, in a UI, by whoever holds
   the Canva developer account — the same posture as Fireflies, and the reason
   [`connector-installation-lifecycle.md`](../../connector-installation-lifecycle.md)
   exists.

### Scopes required for each notification family

| Notification type | Required scopes |
| --- | --- |
| Comments | `collaboration:event`, `design:meta:read`, `comment:read` |
| Design access requests | `collaboration:event`, `design:meta:read` |
| Design approvals | `collaboration:event`, `design:meta:read` |
| Design sharing events | `collaboration:event`, `design:meta:read` |
| Folder access requests | `collaboration:event`, `folder:permission:write` |
| Folder sharing events | `collaboration:event`, `folder:read` |
| Team access invitations | `collaboration:event` |

Canva is explicit that scopes are not hierarchical: `asset:write` does not grant
`asset:read`. Note the trap in row five — receiving a *folder access request*
notification requires `folder:permission:write`, a write scope, to read an event.

Full scope list:
[Scopes appendix](https://www.canva.dev/docs/connect/appendix/scopes/).

### The eleven event types

Delivered as `POST` with a JSON body. Every notification carries `id`,
`created_at` (UNIX seconds) and `content`, and `content.type` is the
discriminant.

| `content.type` | Subject | Distinguishing fields |
| --- | --- | --- |
| `comment` | `design` | `comment_event` (`new` \| `reply`), `comment_url`, thread with `thread_type` (`comment` \| `suggestion`), `content.plaintext`/`markdown`, `mentions` |
| `design_mention` | `design` | as comment, scoped to a mention of the receiving user |
| `suggestion` | `design` | a suggestion-typed thread |
| `design_access_requested` | `design` | `triggering_user` is a `TeamUser` |
| `design_approval_requested` | `design` | *see below* |
| `design_approval_response` | `design` | `initial_requesting_user`, `responding_groups[]` with `external: boolean` |
| `design_approval_reviewer_invalidated` | `design` | **no `triggering_user`** — the system, not a person, invalidated the reviewer |
| `share_design` | `design` | optional `share` (`ShareAction`) carrying a `message` |
| `share_folder` | `folder` | optional `share` with `message` |
| `folder_access_requested` | `folder` | `folder` (`FolderSummary`) |
| `team_invite` | neither | `receiving_user` (a `User`, not a `TeamUser`), `inviting_team` with `external: boolean` |

**`design_approval_requested` publishes no field list.** Its documentation page
carries only a worked example, where every sibling page carries a property table.
Its shape is inferred from `design_approval_response` and must be confirmed live
before a schema is frozen — it is the one event whose parse is a guess.

Shared shapes:

- `User`: `id` (required), `display_name`.
- `TeamUser`: `user_id`, `team_id`, `display_name` — **all three optional**,
  except on `TeamUserSummary` (`design_approval_reviewer_invalidated`), where
  `user_id` and `team_id` are required.
- `DesignSummary`: `id`, `urls.edit_url`, `urls.view_url`, `created_at`,
  `updated_at` (all required), `title`, `url`, `thumbnail`, `page_count`.
- `FolderSummary`: `id`, `name`, `created_at`, `updated_at` (required), `url`,
  and a deprecated `title`.
- `Thumbnail`: `width`, `height`, `url` — **the URL expires after 15 minutes**.
- Mentions are keyed `"<user_id>:<team_id>"` and appear inline in comment text as
  `[user_id:team_id]`.

Notice what is *not* in that table: there is no `design.created`,
`design.updated`, `design.published`, `export.completed`, or `folder.item_added`.
**Canva emits collaboration notifications, not content-change events.** Rally
cannot learn that a design changed by subscribing; it can only learn that someone
said something about it, asked for it, approved it, or shared it.

Sources: [Webhooks overview](https://www.canva.dev/docs/connect/webhooks/) and
the eleven per-type pages beneath it.

### Verification

`GET https://api.canva.com/rest/v1/connect/keys` is public and unauthenticated. It
returns a JWKS of Ed25519 public keys: `kty` is `OKP`, `crv` is `Ed25519`, `x` is
the Base64urlUInt public key, and `kid` selects one. Canva says the keys rotate,
and recommends caching them and refetching only on an unrecognized `kid`. Canva
names replay attacks as the threat the mechanism addresses.

**Unverified, and load-bearing:** the exact wire form of the signature — the
header name, whether the body is delivered as a signed JWT or as JSON alongside a
detached signature, and what is covered by the signature. Canva's own prose says
"decrypt the webhook signature", which is not a description of any signature
scheme, and the published pages do not settle it. Two candidate shapes are in
circulation: Standard Webhooks' `webhook-id` / `webhook-timestamp` /
`webhook-signature: v1a,<base64>` asymmetric profile, and a signed JWT verified
against the same JWKS. **This must be resolved by receiving one real delivery
before any verification code is written**, and the answer recorded in
`provider-apps.md` with the date it was observed.

The Keys API is itself flagged **preview**.

### Preview status blocks a public integration

Canva states that "public integrations that use preview APIs or features will not
pass the review process, and can't be made available to all Canva users", and that
preview features may break without an API version change. Webhook notifications
and the Keys API are both preview. So the Canva integration Rally registers is
**private**, which Canva restricts to the developer's own team on a Canva
Enterprise plan, for as long as webhooks remain preview.

## Connect API surface relevant to a workspace connection

Endpoints Rally would plausibly call, from the [API
reference](https://www.canva.dev/docs/connect/):

- **Designs**: create, list, get, get pages, get export formats, get dataset.
- **Folders**: create, get, update, delete, list items, move item.
- **Comments**: create thread, create reply, get thread, get reply, list replies.
  (`create comment` is deprecated.)
- **Brand templates**: list, get, get dataset, publish.
- **Autofill**: create design autofill job, get job.
- **Exports**: create export job, get job.
- **Assets**: create upload job (bytes or URL), get job, get, update, delete.
- **Design imports**, **resizes**, **merges**: all create-job + get-job.
- **Analytics**: design views, viewers, links, page views, views over time.
- **Users**: `users/me`, profile, capabilities.

**Six of those families are asynchronous job APIs** — autofill, export, asset
upload, design import, resize, merge. Each is create-then-poll, Canva recommends
exponential backoff, and none of them documents an idempotency key. That is a
shape Rally has no primitive for yet, and it is the most interesting thing the
Connect API asks of the codebase.

`GET /v1/users/me/capabilities` reports what the connected account may do, which
is the honest answer to the question Fireflies could not answer about its own API
key — whether the connection can see the team or only one person.

**Unverified:** published rate limits. Canva documents "trial quotas" as a
preview feature and recommends backoff for job polling, but the pages read do not
give a request-per-minute figure per endpoint.

## What this rules out

- **No workspace-level credential.** Every token on both platforms belongs to one
  Canva user. A Rally workspace connection is therefore one named Canva account
  acting on the workspace's behalf, and that must be stated in the setup copy
  rather than implied — the same honesty Fireflies' setup copy carries about
  Enterprise visibility.
- **No content-change events.** Any "the deck changed" behavior has to be polled
  or asked for, and neither is in scope here.
- **No programmatic webhook management.** Nothing can be created, rotated,
  reconciled or removed by Rally.
- **No per-tenant webhook secret.** Every Rally workspace's deliveries arrive on
  the same URL signed by the same rotating Canva keys, so a delivery's *content*
  is the only thing that says which tenant it belongs to.
