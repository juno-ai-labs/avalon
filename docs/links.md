# Links

Every surface that points at a Canvas or a Sidekick from outside the app uses
its canonical HTTPS link:

- a **Canvas**: `https://rallywith.ai/app/<region>/<organization-base58>/cv/<canvas-base58>/`,
  with `a/<artifact-base58>/` appended when the link opens the Canvas onto one
  of its artifacts;
- a **Sidekick**: `https://rallywith.ai/app/<region>/<organization-base58>/sk/<sidekick-base58>/`.

Each Base58 segment encodes the corresponding 16-byte UUID, and the
Organization's id follows the region segment. A Canvas's id is its
conversation's parent id ([`canvases.md`](canvases.md)), so a link to a Canvas
is also the link to its Chat. The `rallywithai://` deep link is what opens the
desktop app, but it is the last hop of the HTTPS page rather than the thing
Rally hands out — a custom scheme cannot be unfurled by Slack, is not linkified
by mail clients, and is dead for anyone without the app.

The Space, Channel, Breakout and Thread link forms went with those surfaces in
the [Canvases and Sidekicks pivot](PRDs/2026-11-06_canvases-and-sidekicks/prd.md).
Nothing mints them and nothing reads them; the handoff page and the web app
recognize their shapes only to say that what they named no longer exists.

Read this before emitting or parsing a link anywhere, and before changing the
handoff page or the Slack unfurl card.

## Where the code lives

| Concern | Location |
| --- | --- |
| Mint, parse and validate both forms and their deep links; recognize a retired form | `packages/contracts/src/links.ts` (`@rally/contracts/links`) |
| Encode and decode UUID segments | `packages/contracts/src/uuid-base58.ts` |
| The desktop deep-link grammar (`canvas`, `sidekick` intents) | `packages/contracts/src/desktop-deep-link-intent.ts` |
| A server-minted link for a conversation, from its parent kind | `conversationCanonicalUrl` in `apps/api/src/services/conversation-link-service.ts` |
| The handoff page every `/app/` path serves | `apps/site/app/open/index.html`, `apps/site/src/link-handoff.ts` |
| Make the dynamic path resolve | `apps/site/public/_redirects` (`/app/*  /app/open/  200`) |
| The signed-out name lookup the page's heading shows | `apps/api/src/routes/links.ts`, `WorkspaceDO.linkTitle` |
| Style every desktop-handoff page like the desktop sign-in screen | `apps/site/src/desktop-handoff.css` |
| Site telemetry path classification | `normalizedTelemetryPathname` in `apps/site/src/telemetry.ts` |
| The web app's rewrite to hash routes | `shellLocation` and `inPlaceHash` in `apps/browser/src/session.ts` |
| Slack unfurl | `unfurlAvalonLinks` in `apps/api/src/services/slack-agent-service.ts`; `slackUnfurlLinkTargets` and `linkUnfurlBlocks` in `slack-workstream-card.ts` |
| Copy link (Canvas title menu, Sidekick header) | `apps/desktop/src/renderer/lib/copy-link.ts` |
| Copy link from a detached artifact window | the `link` action in `apps/desktop/src/main/artifact-window-actions.ts` and `main/index.ts` |
| Open the deep link | `emitDeepLink` and `httpsLinkDeepLink` in `apps/desktop/src/main/`, `apps/desktop/src/renderer/lib/app-session.tsx` |
| The registered unfurl domains | `config/provider-apps/slack.json` |

## How it works

### The forms

| Form | Shape | Who mints it |
| --- | --- | --- |
| **Canvas** | `/app/<region>/<organization-base58>/cv/<canvas-base58>/` | The Canvas title menu's **Copy link**, a share invitation email, a notification about a Canvas's Chat |
| **Canvas onto an artifact** | Canvas link plus `a/<artifact-base58>/` | A detached artifact window's **Copy link**; a pinned artifact's push |
| **Canvas at a message** | Canvas link plus `?turn=<turn-uuid>&sequence=<n>` (no artifact segment) | A mention's or a reply's push and email |
| **Sidekick** | `/app/<region>/<organization-base58>/sk/<sidekick-base58>/` | The Sidekick header's **Copy link**, a notification about a Sidekick's conversation or one of its runs, a Slack App Home row |
| **Deep link** | `rallywithai://workspace/<region>/<organization-base58>/canvases/<canvas-base58>` (plus `/artifacts/<artifact-base58>`, or `?turn=<turn-uuid>&sequence=<n>`), or `.../sidekicks/<sidekick-base58>` | The handoff page's last hop, the desktop's own navigation |
| **Retired** | `/app/<region>/<organization>/s/...` (Space, Channel, Breakout, artifact), `/app/<region>/<organization>/i/...` (import), `/app/workspaces/<region>/<organization>/workstreams/...` (addressed Channel), `/app/workstreams/<id>` (ID-only) | Nothing; `isRetiredLinkPath` recognizes the shape. The web app's own Organization shell, `/app/workspaces/<region>/<organization>`, is not retired |

`canvasCanonicalUrl`, `sidekickCanonicalUrl` and `linkCanonicalUrl` mint the
HTTPS form; `canvasDeepLink`, `sidekickDeepLink` and `linkDeepLink` the deep
link. Each throws on anything that is not a UUID. `parseLinkTarget` reads
either form back as a `LinkTarget` (`{ kind: "canvas" } & CanvasLinkTarget` or
`{ kind: "sidekick" } & SidekickLinkTarget`), the HTTPS form only on an origin
the caller names and with no fragment, and with no query except a Canvas
link's message (`turn` and `sequence`, exactly those two, on a Canvas with no
artifact segment; `parseMessageSearch`, which the desktop intent parser reads
the deep link's query through too); `parseLinkPathTarget` reads a path
alone, with or without its trailing slash.

A Canvas belongs to the Organization, as a Sidekick does, so both sit directly
under the Organization segment; `cv` mirrors `sk`. The artifact segment is a
child of the Canvas segment rather than a query, because when it was added
every reader refused a canonical link carrying a query. A message is a query
(`?turn=&sequence=`) because it is not a resource of the Canvas but a place
in its Chat, the form the renderer's `canvasTurnRoute` already used; it is
the one query any reader takes.

### Links the server mints

`conversationCanonicalUrl(env, { region, workspaceId, parentId, artifactId? })`
asks the Organization's object what the parent is (`resolveHostedParent`, one
RPC): a Canvas's Chat links to the Canvas, a Sidekick's conversation or any of
its runs links to the Sidekick, and anything else — a Thread, a Breakout, a
Channel, or an id the Organization holds nothing for — has no link and gets
`null`. Every notification path is built on it: pushes (mentions, adds, Needs
input and finished runs among them), the mention and
participant emails, Slack DMs and the
Slack task controls. A delivery about a conversation with no link is skipped
with the named reason `conversation_not_linkable` and the parent's kind
(`parent_kind`, `missing` for a deleted Canvas or nothing at all, so it reads
apart from a Thread), or, in the Slack task controls, sent without
the link: Thread surfaces are gone, so a link to one would open nothing. A
mention or an add resolves the link once (`conversationLink`) and hands it to
both its Slack and email transports; a push resolves it after the person's
notification choice has allowed the delivery.

A Canvas share's invitation email links to the Canvas on the web app
(`BROWSER_APP_ORIGIN`), which hands it to the desktop from there.

### The handoff page

Every `/app/` path renders one static page through a 200 rewrite in
`_redirects`; the path stays in `window.location.pathname`, and
`handoffPlan(pathname)` decides what the page does:

- **A Canvas or Sidekick link.** The heading reads `Opening “<name>” in
  Rally`, with the name cut at 40 characters. Holding a link is the permission
  to see the name of what it points at, private or not, so the page asks
  `GET /links/title?path=<its own path>` on the Global API with no sign-in. The
  route parses the path with the same reader and asks the Organization's object
  for that one title — `canvas_directory`'s, or a Sidekick's that is not
  deleted. It reads no viewer, no contents and no other field; a link onto an
  artifact still names the Canvas. An unknown Organization is refused from D1
  before any object opens. On a Mac the page tries the deep link once on load,
  shows **Open in Rally for Mac**, then **Continue in browser**, which opens
  the same path on `app.rallywith.ai`, then the Mac download. Anywhere else —
  Windows, Linux, Android, an iPhone or an iPad (whose Safari reports a Mac
  user agent, told apart by its touch points) — no Rally app runs, so the web
  app is the one button.
- **A retired link.** The heading reads **This link is to something that no
  longer exists**, a line says Canvases replaced Channels, Threads and
  Breakouts and to ask the sender for the Canvas's link, and **Go to Rally**
  opens the web app. Nothing is looked up: what the link named is gone, and
  the page must not suggest otherwise.
- **Anything else under `/app/`.** "This link did not lead to a Rally
  resource".

The page remembers in `localStorage` which button this browser last chose.
After **Continue in browser** it stops launching the app on load, because for
someone without the app that launch is an error prompt every time, but the app
stays the first button.

The heading's name rule is looser than the Slack unfurl's audience table on
purpose: the product call (2026-10-07) is that whoever holds a link may see the
name of what it points at. The unfurl differs because Rally itself posts the
card into a Slack channel, where people who never opened the link read it.

### The desktop app

The main process accepts only the deep links `parseDesktopDeepLinkIntent`
reads, so a Space, Channel, Breakout or Thread deep link (`rallywithai://…/spaces/…`,
`…/workstreams/…`, addressed or not, `workstreams/new` included) is refused
there. `emitDeepLink` does not drop it silently: `isRetiredDeepLink` in
`apps/desktop/src/main/deep-links.ts` recognizes the retired deep-link shapes
and main opens its deep-link error window with `RETIRED_LINK_MESSAGE`
(`@rally/contracts/links`), the sentence the web app's entry card shows:
**This link is to something that no longer exists. Rally replaced Channels,
Threads and Breakouts with Canvases.** A retired HTTPS link handed over as a
universal link is not claimed (`httpsLinkDeepLink` takes only Canvas,
Sidekick and Organization links), so it never reaches `isRetiredDeepLink`:
the browser opens it and the handoff page says the same.

The web app's own Organization URL opens the app too, on `rallywith.ai` and
`www`: `parseOrganizationShellTarget` reads
`/app/workspaces/<region>/<organization>` with no hash or `#/`, `#/canvases/<canvas>`
(with `?artifact=<artifact>` and nothing else, or `?turn=<turn>&sequence=<n>`
and nothing else) or `#/sidekicks/<sidekick>`,
ids as UUIDs, and `organizationShellDeepLink` turns it into the addressed
`home`, `canvases` or `sidekicks` deep link. `home` lands on `#/`, where the
landing restores this device's last route, as the web app does for the same
URL. Any other hash route, an outer query, or `app.rallywith.ai` is refused,
so that link stays in the browser.

A Canvas deep link that names an artifact navigates to
`#/canvases/<canvas>?artifact=<artifact>` (`canvasArtifactRoute`), the hash
the web app's `shellLocation` writes for the same link, so the Canvas screen
opens the artifact from one query on both hosts rather than from route state
on one and a query on the other.

### The web app

`app.rallywith.ai` serves the same paths. `shellLocation` rewrites a Canvas
link to `/app/workspaces/<region>/<organization>#/canvases/<canvas>` (with
`?artifact=<artifact>` when it opens one, which the Canvas screen turns into
the rail's open-resource state) and a Sidekick link to
`#/sidekicks/<sidekick>`; `inPlaceHash` routes a notification click in place
when the tab already shows that Organization. A retired path rewrites to
nothing, and the entry screen says what it named no longer exists.

### Why the id is in the path

The id sits in the **path**, not in a `#fragment`. A fragment is never sent to
a server, which is exactly right for the OAuth ticket handoffs in
[`security.md`](security.md), and exactly wrong for a link a server has to
recognize: Slack's unfurl handler reads the id off the shared URL.

The ids, region and Organization are not secrets and not a capability: opening
the link grants nothing on its own. The pair is routing context. The distinct
`workspace` deep-link host is a version boundary: desktop builds that predate
addressed links reject it instead of opening the resource in the active
Organization. When the link names the active Organization, the desktop opens it
with the session in use; otherwise it activates that exact Organization through
the platform service, verifies the returned session, and only then navigates
(`multiple-workspaces.md`). The regional API authorizes every read either way.

### What the Slack unfurl shows

`slackUnfurlLinkTargets` keeps, from one `link_shared` event, the Canvas and
Sidekick links (at most ten) that this Slack team's own Organization holds, on
either registered site domain. The card names the Canvas or Sidekick, linked to
the URL Slack reported, with an **Open in Rally** button — the same name the
handoff page shows, and nothing else: no contents, no status. A link to another
Organization, a retired link and anything that is not a Rally link are left to
Slack's own preview.

A Slack unfurl is one card per link per message, identical for everyone who can
read the channel, so the audience rule is:

| Condition | Card |
| --- | --- |
| The link names another Organization or region than this Slack team's | No card |
| Slack Connect: externally shared channel or external DM | Anonymous |
| Audience lookup (`conversations.info`) failed | Anonymous when posting |
| The name lookup found nothing (deleted, never existed) | Anonymous |
| Anything else — public, private, DM, group DM | The name |

A Canvas or Sidekick card carries nothing a status change would rewrite, so it
is not recorded in `slack_unfurled_links`. A rename shows on a card posted
after it.

### Thread cards posted before the pivot

A Thread card posted before Canvases replaced Threads stays in Slack as it was
last rendered. The five-minute maintenance sweep that rewrote those cards'
status badges and redacted a card whose channel became externally shared
(`refreshSlackWorkstreamUnfurls`) was deleted with the Thread storage it read,
so nothing rewrites them now; a click opens the handoff page's gone state.
`slack_unfurled_links` keeps their rows, unread, until a data migration drops
the table.

## Invariants

- **The Organization-addressed HTTPS link is the only form Rally hands out.**
  Never emit `rallywithai://` into anything a human can copy.
- **The id lives in the path, never in a fragment.**
- **Every link is minted by the `links.ts` minters and read by
  `parseLinkTarget` or `parseLinkPathTarget`.** A URL built by hand drifts from
  the site's rewrite rule.
- **A server-minted link comes from the parent's kind, asked of the
  Organization's object.** A conversation id alone does not say whether it is
  a Canvas, a Sidekick or a Thread.
- **Nothing mints or reads a Space, Channel, Breakout or Thread link.**
  `isRetiredLinkPath` recognizes their shapes so the reader is told the thing
  is gone; it never reads an id out of one.
- **A notification about a conversation with no link sends nothing that
  points at nothing**, and says why in a named reason.
- **The `_redirects` rewrite is load-bearing.** Deleting it turns every shared
  link into a 404, which no test of the page alone would catch; it is deploy
  configuration, which the deploy itself tests
  ([`testing.md`](testing.md#do-not-test-ci-or-deployment-configuration)).
- **A failed check degrades the card; it never drops the unfurl.**

## Boundary

This module owns the link forms, the page that serves them, the web app's
rewrite of them, and the Slack unfurl card and its refresh. It does not own the
Slack connector's ingress or scopes ([`slack-integration.md`](slack-integration.md),
[`slack-permissions.md`](slack-permissions.md)), the OAuth handoff the fragment
form is reserved for ([`security.md`](security.md)), what a Canvas or Sidekick
is ([`canvases.md`](canvases.md), [`automation-lifecycle.md`](automation-lifecycle.md)),
or who may open one (the regional API, per [`authorization.md`](authorization.md)).

### Adding a surface that links to a Canvas or Sidekick

1. On the server, call `conversationCanonicalUrl` when what you have is a
   conversation, or `canvasCanonicalUrl` / `sidekickCanonicalUrl` when you
   already know the kind. In the renderer, call `copyLink`. Do not build a URL
   by hand.
2. If the surface *reads* links, use `parseLinkTarget` and name every origin a
   link could have been minted on (`PUBLIC_WEB_BASE_URL` and
   `LEGACY_LINK_ORIGINS` for a URL a third party hands you).

### Deep links that have no canonical form

Settings and automation deep links go through the
`/open#target=` handoff, whose allowlist lives in the shared
`desktop-deep-link-intent` contract. They address no shareable object, so they
need neither a stable URL nor an unfurl, but every newly emitted one uses the
same `workspace/<region>/<organization>/<destination>` wrapper so a
notification cannot open the same section in whichever Organization happens to
be active.

Every browser handoff reports only its closed type (`canvas`, `sidekick`, or
`workstream` for a retired link), its `presented`/`automatic`/`manual`/
`browser` method and its local validity through the public-site telemetry
boundary. The ids, the deep link, query and fragment are deliberately excluded,
and the path is classified (`/app/:region/:organization/cv/:canvas`,
`.../cv/:canvas/a/:artifact`, `.../sk/:sidekick`, `/app/:retired`,
`/app/:unrecognized`). The site event is an attempt, not proof the app opened.

## Failure modes and limits

- **A desktop build older than this change refuses a Canvas deep link** and
  shows its generic link error; the web app, always current, opens it. The
  site must deploy before a desktop release that relies on a new path.
- **A Thread link in someone's inbox opens the gone page**, by design. Its
  title is not looked up.
- **A Canvas card in Slack keeps the name it was posted with.**
- **A Canvas link's name is visible to whoever holds the link**, private
  Canvas or not (the 2026-10-07 product call).
- **A Thread card in Slack is frozen.** Its status badge is whatever it showed
  when the sweep last ran, and a card in a channel that became externally
  shared afterwards is not redacted.

## Testing

| Suite | Covers |
| --- | --- |
| `packages/contracts/src/links.test.ts` | Minting and reading every form both ways against literal URLs, origin and query refusal, the retired forms read as nothing and recognized as retired. |
| `packages/contracts/src/desktop-deep-link-intent.test.ts` | The `canvas` and `home` intents among the addressed forms. |
| `apps/site/test/site.test.ts` | `handoffPlan` for Canvas, Sidekick, retired and invalid paths; the deep link per device; telemetry path classification. |
| `apps/browser/test/session.test.ts` | Canvas and Sidekick links rewritten to hash routes; retired forms not routed. |
| `apps/api/test-workers/canvas-conversation.test.ts` | `conversationCanonicalUrl` on the real Organization object (Canvas, Canvas onto an artifact, Sidekick, an unknown id) and `linkTitle` for a Canvas. |
| `apps/api/test-workers/canvas-hosting.test.ts` | A Canvas share's invitation email carries the Canvas link. |
| `apps/api/test/link-title-route.test.ts` | The title route's path reading and refusals. |
| `apps/api/test/slack-agent-ingress.test.ts` | Which shared links get a card, and the Canvas card's blocks. |
| `apps/api/test-workers/notice-email-sink.test.ts` | The link each kind's notice carries to its sinks. |
| `apps/desktop/src/main/push-links.test.ts`, `deep-links.test.ts` | Universal links, the Organization URL's accepted and refused shapes, the main process's deep-link boundary, and `isRetiredDeepLink`. |
| `apps/site/test/link-handoff.test.ts` | The handoff page's visible copy for a retired and a Canvas link. |
| `apps/desktop/src/renderer/lib/browser-entry.test.tsx` | The web app's entry screen shows the retired copy on a Thread path and not on its own Organization shell path. |

## Data model

`slack_unfurled_links` holds which Slack message carried which Thread link
posted before the pivot, plus `rendered_status`, `rendered_anonymous`,
`rendered_hash` and `refreshed_at`. Nothing reads or writes it now, and no
Canvas or Sidekick card is recorded.
[`data-model.md`](data-model.md) is authoritative for the columns.

## Apple universal links

Both Rally hosts serve `/.well-known/apple-app-site-association`, and the Mac
app claims `/app/*`. The main process adapts a claimed HTTPS link with
`httpsLinkDeepLink`, which takes a Canvas or Sidekick link, or the web app's
Organization URL, on the two Rally hosts and nothing else; a retired link stays
in the browser, where the handoff page answers it. `app.rallywith.ai`, where the
web app actually runs, is not an associated domain (the entitlement lists
`rallywith.ai` and `www.rallywith.ai`, and only `apps/site` serves the
association file), so an Organization URL copied from the web app's address bar
does not open the Mac app. Push clicks use the same adapter with notification
attribution. See [push](push-notifications.md).

## Changelog

### 2026-11-08 — A Canvas link can name a message

**What changed:** `CanvasLinkTarget` gains `turnId` and `sequence`. The
canonical link carries them as `?turn=<turn-uuid>&sequence=<n>`, the deep
link as the same query, and the web app's Organization URL as
`#/canvases/<canvas>?turn=…&sequence=…`; `parseLinkTarget`,
`parseDesktopDeepLinkIntent` (its canvas intent gains the two fields) and
`parseOrganizationShellTarget` read them, through one `parseMessageSearch`.
A mention's or a reply's push links there.

**Why:** The owner's answer of 2026-11-08 ("fix this") to a reply push
opening the conversation at its newest message instead of at the message.

**Considered and rejected:** A path segment, as the artifact took: a message
is a place in the Chat, not a resource, and the renderer already routed it as
`?turn=&sequence=` (`canvasTurnRoute`). Base58 for the turn id: the in-app
route and the shell hash carry UUIDs.

**What a future change must respect:** the message query is accepted only on
a Canvas link with no artifact segment, as exactly `turn` and `sequence`;
any other query is still refused. A build before this refuses such a link
(an older Mac opens the app without navigating).

### 2026-11-08 — The Mac app routes links as the web app does

**What changed:** Three divergences between the two hosts' routing closed. A
Canvas deep link onto an artifact navigates to `#/canvases/<canvas>?artifact=<artifact>`
(`canvasArtifactRoute`) instead of `#/canvases/<canvas>` with open-resource
route state, so the Canvas screen opens the artifact from the one query
`shellLocation` already wrote. The retired-link sentence is one constant,
`RETIRED_LINK_MESSAGE` in `@rally/contracts/links`, which the web app's entry
card and the desktop's deep-link error window both show; the desktop's had been
the shorter "This link is to something that no longer exists.", and
`isRetiredDeepLink` lost its HTTPS branch, which nothing could reach because
`continue-activity` hands an unclaimed link back to the browser and every other
path passes a scheme URL. And the web app's Organization URL,
`/app/workspaces/<region>/<organization>` with an optional landing, Canvas or
Sidekick hash, opens the Mac app on `rallywith.ai` and `www` through
`parseOrganizationShellTarget` and a new addressed `home` intent that lands on
`#/`.

**Why:** The owner asked for the Electron app's routing to match the
browser's. Both hosts mount the same router, so the differences were around
it: what a link put in front of the Canvas screen, the copy for a retired link,
and which inbound URLs the app would take.

**Considered and rejected:** Reusing the `activity` intent for the
Organization landing: it lands on the Canvases home and names the Activity
section, while the web app lands on `#/` and restores the last route.
Keeping the dead HTTPS branch with a comment. Letting `parseLinkTarget` read
hashes: it reads shareable links, which never carry one, and widening it would
widen every caller.

**Consequences:** `httpsLinkDeepLink` claims the Organization URL only on the
two associated hosts. `app.rallywith.ai`, where the web app runs and whose
address bar a person would copy from, is neither an associated domain nor
serving the association file, so its URLs still open in the browser; claiming
them changes the Mac app's signing entitlements and the release, and is the
owner's call. Only the main process mints a `home` deep link, from a claimed
universal link, so no older build is ever handed one. A Canvas screen change must keep
consuming `?artifact=`, which is now the only way any link opens an artifact.

### 2026-11-07 — Canvases get a link form; the Space, Channel, Breakout, Thread and iPhone forms go

**What changed:** A Canvas has a canonical link,
`/app/<region>/<organization>/cv/<canvas>/` (with `a/<artifact>/` onto one of
its artifacts) and `rallywithai://.../canvases/<canvas>`, beside the
Sidekick's `/sk/`. The contracts module is `links.ts` (this document was
`workstream-links.md`) with one reader, `parseLinkTarget`; the Space, Channel,
Breakout, Thread and import minters and readers are deleted, and
`isRetiredLinkPath` only recognizes their shapes. The site's handoff page moved
to `app/open`, hands a Canvas or Sidekick link to the Mac app or the web app,
and answers a retired link with "This link is to something that no longer
exists" instead of a 404. Server-minted links come from
`conversationCanonicalUrl`, which reads the parent's kind; a notification about
a Thread is skipped, named `conversation_not_linkable`. The Slack unfurl reads
Canvas and Sidekick links and shows the name only, recording nothing; the
sweep that kept old Thread cards current was deleted with the Thread storage
it read. The web app rewrites to `#/canvases/:id` and `#/sidekicks/:id`. The
iPhone entry in the Apple association file and the handoff's iPhone branches
went with `apps/ios`.

**Why:** The pivot deletes Threads, Breakouts and Channels and their client
surfaces, and the iOS client
([PRD](PRDs/2026-11-06_canvases-and-sidekicks/prd.md), plan steps B-5 and
B-9). A link to one now opens nothing, and a Canvas, the shared thing that
replaced them, had no link of its own: its Chat used the Thread forms in the
interim. Saying a retired link's thing is gone is the honest answer; a 404
reads as a broken link.

**Considered and rejected:** Keeping the Thread readers so an old link opens
"the Canvas with that id". Thread ids and Canvas ids share a namespace but no
meaning, so an old link would open the unavailable state at best. A Canvas
path under a Space-like hierarchy (`/s/.../cv/...`): a Canvas belongs to the
Organization, as a Sidekick does. Recording Canvas cards for a refresh sweep:
a name-only card has no status to keep current.

**Consequences:** The desktop's main process says "This link is to something
that no longer exists" in its deep-link error window for a retired deep link,
as the site and the web app do, rather than refusing it without a word. The
web app's Organization shell path, `/app/workspaces/<region>/<organization>`,
shares a prefix with the retired addressed form and must stay outside
`isRetiredLinkPath`. A desktop build older than this refuses a Canvas deep
link; the web app opens it. A Thread card already in Slack is frozen as last
rendered, and one in a channel that became externally shared afterwards is not
redacted; `slack_unfurled_links` keeps its rows until a data migration drops
it.

### 2026-10-17 — A link can open a thread onto an artifact

**What changed:** A Channel link may end in `/a/<artifact-base58>` (deep link
`/artifacts/<artifact-base58>`), and every reader in this tree takes it: the
desktop's main process and intent parser, the web app's `shellLocation`, the
site handoff, and the iPhone, which opens the thread. The desktop carries it
as `?artifact=` on `/workstreams/:id`, and `LoneThreadRoute` turns that into
the navigation state the sidebar's artifact row sends (`openThreadResourceState`),
so the artifact opens expanded. A pinned artifact's push is the one writer.

**Why:** A push about a new version of a pinned artifact should open that
artifact, not leave the person to find it in its thread.

**Considered and rejected:** A query parameter on the thread link. Every
reader refuses a canonical link with a query, so it would have opened nothing
anywhere, the same as a new segment, with none of a segment's validation.

**Consequences:** A build from before this refuses the link, so nothing
general mints it: it rides only `artifact_updated` pushes, which an older Mac
and iPhone already drop by kind. The addressed fallback form, for a thread no
Space holds, has no artifact segment and opens the thread. The site must
deploy before a desktop release that relies on it, as for any new path.


### 2026-10-10 — Links keep their shape; the app's routes say Channel and thread

**What changed:** In-app Space routes redirect to the Channel they now are, and
a thread opened on its own lands under one of its Channels. No link a writer
mints changed.

**Why:** The navigation redesign renamed the levels
([PRD](PRDs/2026-10-10_channels-threads-navigation/prd.md)); the HTTPS and deep
link paths already carried them in the right order.

**Considered and rejected:** New `/ch/` and `/t/` path segments: every link
already in Slack, email and push would need a reader for both, for words a
person never reads in a URL.

**Consequences:** The `s`, `c` and `b` segments now mean Channel, thread and
breakout. Do not rename them.

### 2026-10-07 — Deploys no longer re-check live link readers

**What changed:** The API deploy no longer probes the live handoff page and
update manifest before it ships, and the site deploy and desktop release no
longer compare the live Apple association file to a hardcoded copy. The
`rally-workspace-handoff-version` line is gone from `latest-mac.yml`.

**Why:** Each check compared a live copy of a file this repository owns to a
second copy pinned in the check, so it proved nothing a deploy had not already
done. The handoff probe matched button copy; when #1144 reworded the button,
every API deploy stopped there while the page itself was correct. The rollout
order these gates enforced was needed once, for the move to addressed links,
and every reader has shipped since.

**What to respect:** A change that needs the site or desktop to ship before the
API states that order in its pull request. Do not add a gate that pins a copy of
a checked-in file or page text.

### 2026-10-07 — A copied link opens in the web app too

**What changed:** The `/app/*` handoff page adds **Continue in browser**, which
opens the same path on `app.rallywith.ai`. Where no Rally app can open the link
the browser becomes the only button and the page skips the launch. The page
remembers a browser choice and then stops launching the app on load. The
browser client now also reads the Sidekick path. Telemetry gains a `browser`
handoff method. The heading names the linked resource through a new
signed-out `GET /links/title`, and the kind label and sub-line are gone.

**Why:** The page was a dead end for anyone without the Mac app: a teammate on
Windows, on a phone, or not yet installed got an app launch that did nothing
and a pointer to the marketing site, though the web app could already open the
same Organization, Space and Channel. Naming the resource signed out is safe
because holding the link is already the permission to see its name; the lookup
returns that one field and nothing inside the resource.

**Considered and rejected:** Minting copied links on `app.rallywith.ai`. That
drops the Slack unfurl and the Apple universal-link claim on `rallywith.ai`,
and skips the desktop for the people who have it. Sending a remembered browser
choice straight to the web app, which would end the nudge toward the desktop
for good after one click. Carrying the name in the link's fragment, which
every link reader refuses today, goes stale on a rename, and shows whatever an
edited link says.

**Consequences:** The desktop stays the first choice
wherever a Rally app can open the link. A new canonical path family needs the
browser client's `shellLocation` and entry target to read it, or the browser
button lands on the Organization root.

Shipped in juno-ai-labs/avalon#1144.

### 2026-09-25 — Sidekicks get a shareable link

**What changed:** The Sidekick screen's menu copies
`/app/<region>/<organization>/sk/<sidekick>/`. The site page, the
desktop HTTPS adapter, and the shared deep-link grammar read it and open the
Sidekick's own screen in the addressed Organization.

**Why:** There was no way to point a teammate at a Sidekick. A Sidekick belongs to
the Organization rather than to a Space, so it hangs off the Organization
segment instead of nesting under `/s/`. It uses `sk` because the one-letter
`s` already means Space, and `sk` stays short like the other segments while
still reading as "Sidekick". The desktop deep link keeps the spelled-out
`sidekicks` host, matching `spaces` and `channels` there.

**Considered and rejected:** A custom-scheme-only link, for the same reasons the
Channel link left it. A spelled-out `sidekicks` segment, which breaks the short
segment style of `s`, `c` and `b`.

**What a future change has to respect:** A desktop build older than this change
rejects the `sidekicks` deep link as unrecognized, and a site older than it
shows the invalid-link state. iOS claims neither path, so the link stays on the
web there.

### 2026-09-22 — Address Spaces, Channels, and Breakouts hierarchically

**What changed:** New HTTPS links put the Organization immediately after the
region, then `/s/` Space, `/c/` Channel, and optional `/b/` Breakout in one hierarchy. UUID path
segments use canonical Base58 encoding. The Space dashboard can copy its URL;
the browser opens shared Space roots as read-only overviews. Server-side Channel
links resolve one current Space placement from WorkspaceDO, while old URL shapes
remain readable. iOS universal-link claims stay on the old paths until the
new parser has shipped, while the site translates new links for older builds.

**Why:** The old path exposed the prototype Workspace/Workstream/Substream
taxonomy and could not address a Space dashboard. A shared codec and one
placement lookup keep every producer on the same URL contract.

**Considered and rejected:** Fabricating a Space ID from the Channel ID or
keeping separate hand-built URL rules in email, Slack, desktop, and iOS. Neither
would represent the actual many-to-many Space placement.

**Respect in future changes:** URL placement is not permission; resource reads
still pass through the owning authority. Keep legacy readers for links already
in circulation, and update the site rewrite and Apple association whenever a
new canonical path family is emitted.

### 2026-09-15 — Claim the iPhone on the same association file

**What changed:** The Apple association file now lists `7ZLT6A8W25.ai.rallywith.ios` next to the Mac bundle, on the same work-stream paths.

**Why:** The iOS client already claimed `applinks:` entitlements. Without the iPhone in the association file, those links stay in Safari. A second association document would have been two files for one path family.

**Considered and rejected:** Dropping the iOS applinks entitlement until a later site deploy. The phone is shipping in the same change that needs the claim.

**Consequences:** Site must deploy this file before a signed iPhone will accept HTTPS work-stream links. The live-host check runs after site deploy, not on pull-request CI.

### 2026-09-14 — Adapt HTTPS links into desktop navigation

Both Rally hosts now publish the Apple association file, and desktop universal
link events adapt supported work-stream paths into the existing scheme parser
and navigation dispatch. This keeps one navigation contract while preserving
the browser handoff page for clients without an associated app. Association
publication and signed-Mac acceptance must precede the desktop release.


### 2026-09-08 — Preserve private-child destinations

**What changed:** Canonical HTTPS links and desktop deep links accept an optional `/substreams/<id>` suffix. Notifications and Copy link preserve the child, including across workspace activation.

**Why:** A child notification that opens Main loses the conversation it describes.

**Considered and rejected:** A separate child URL scheme; the existing link primitive carries the optional child address. Main URLs and legacy readers retain their existing forms.

### 2026-09-01 — The addressed native hop has an old-client rejection boundary

**What changed:** The browser now opens
`rallywithai://workspace/<region>/<workspace>/workstreams/<workstream>` and all
native surfaces share one intent parser. Explicit targets always revalidate
membership before navigation.

**Why:** A query-addressed work-stream URL was accepted by the previous parser,
which ignored its target and navigated relative to the active workspace. A cached
matching credential could also conceal revoked membership.

**Considered and rejected:** Adding another query version field. The old parser
would ignore that field too; a distinct unknown host is the only fail-closed shape.

**Consequences:** Existing ID-only links still open relative to the active
workspace. New addressed links require a compatible desktop and connectivity.

Shipped in #464.

### 2026-09-01 — External links address a workspace before a resource

**What changed:** Every new canonical work-stream URL and desktop last hop carries
`(region, workspace_id)`. The desktop activates and verifies that target before
navigating; Slack unfurls refuse a current link addressed to another Rally
workspace. ID-only HTTPS, deep-link, and historical handoff forms remain readers
relative to the active workspace and are no longer writers.

**Why:** With several workspaces on one account, an ID-only link could open the
same route under whichever workspace happened to be active. That produced a
misleading not-found at best and made each writer invent its own answer to
workspace selection.

**Considered and rejected:** Making work-stream UUIDs globally discoverable, or
looking for the ID across every stored credential. Both turn an opaque routing
coordinate into a cross-workspace directory and make link opening itself an
authority decision. The target pair is cheaper to reverse and the regional API
remains the only membership authority.

**Consequences:** New writers need all three coordinates. A target grants no
access; failed activation leaves the current workspace and route unchanged.
Compatibility readers must never be reused to mint a current link.

Shipped in #464.

### 2026-08-25 — The deep link is minted as rallywithai://, and avalon:// is still read

**What changed:** `workstreamDeepLink` mints `rallywithai://workstreams/<id>`.
`parseWorkstreamLink` accepts either scheme. The scheme list moved to
`packages/contracts/src/desktop-deep-link.ts`, which the API, the site, and the
desktop main process all read. Canonical HTTPS links are minted on
`rallywith.ai`.

**Why:** The rebrand to Rally moves the scheme along with the domains, and a
scheme is the hardest part of it to move: it is claimed by an *installed* build,
so no server change can make an older client answer to one it never registered.
A desktop shipped before the rename knows `avalon:` alone, and the links it minted
are in inboxes and Slack history that cannot be reissued. Minting one scheme while
reading both is what lets the change ship without invalidating either.

The list was extracted because five surfaces have to agree on it and none can
check the others. A copy left behind would not fail loudly — it would classify a
real link as untrusted on one surface, which is the kind of bug that reaches a
user before it reaches a test.

**Considered and rejected:** Keeping `avalon:` as the minted scheme until every
old build is gone, and switching once. That defers the same break rather than
removing it, and it means the product keeps emitting the superseded brand in
links people paste to each other for the whole migration.

**Consequences:** Parsing accepts both schemes, which makes minting the wrong one
invisible to any round-trip test — `never mints the superseded scheme` asserts the
writing side alone and must survive. Removing `avalon:` is a decision about
shipped clients, not about this module. See
[`domain-migration.md`](domain-migration.md).

### 2026-08-22 — The unfurl sweep and App Home read only the object

**What changed:** `slack-unfurl-refresh.ts`'s stale-card selection,
`slack-agent-service.ts`'s App Home task list and its unfurl summary lookup no
longer branch on `authority.phase`; each keeps only its WorkspaceDO arm. The
`WORKSTREAM_UNFURL_COLUMNS` / `WORKSTREAM_UNFURL_JOINS` fragments existed so the
two D1 summary queries stayed in step, and go with them.

**Why:** Migration 0090 closed the phase permanently, so the D1 arms had been
unreachable since. The two fragments were the coupling between them; keeping
them would have invited a third caller back onto the regional tables.

**What a future change has to respect:** an unfurl summary comes from
`lookupWorkstreamDirectory`, and the archived filter is applied to its result
rather than in SQL. A work stream missing from that lookup falls through to the
anonymous card, which is the same failure mode the D1 query's
`archived_at IS NULL` produced.

### 2026-08-22 — A skipped link still advances

**What changed:** The Durable-Object-mode sweep advances `refreshed_at` for a
link whose work stream is archived or missing from the directory page, where it
used to skip the row untouched. The workspace alarm's due-time query for the
sweep counts only links on a connection that is not disabled.

**Why:** The sweep's due time is `MIN(refreshed_at)` over the table, and the
sweep loads rows through a non-disabled connection and skips archived work
streams. A row that is counted but never advanced holds the due time at a past
instant forever — the shape of the 2026-08-22 alarm hot loop — and, once the
alarm base gates such an entry, holds every other card in the workspace behind
a thirty-minute backoff and pages an operator for a link nobody will refresh.
Advancing the row costs one `UPDATE` a sweep; excluding the disabled
connection's rows from the count costs one `EXISTS`.

**Consequences:** An archived work stream's link is re-examined every five
minutes like any unchanged card, and deleted when its message or channel goes.
A reap or sweep whose due-time query counts rows it will not move is a defect;
see the invariant in `durable-object-alarms.md`.

### 2026-08-18 — Slack cards join work-stream summaries from WorkspaceDO

**What changed:** New unfurls and the refresh sweep resolve title, status,
recency, archive, and automation origin from authoritative WorkspaceDO directory
RPCs. The sweep retains D1 link/connection coordinates, batches distinct IDs per
workspace, and never falls back to the frozen D1 work-stream row.

**Why:** Slack delivery coordinates are a relational connector workload, but the
card summary is work-stream product state. Copying that summary into D1 solely
for the join would keep a second serving authority alive.

**Considered and rejected:** One RPC per card and retaining D1 directory
projections for Slack. Batching avoids the first; the second defeats the
authority cutover.

**Consequences:** A WorkspaceDO outage delays a card/refresh rather than serving
stale D1 metadata. The sweep loads at most 5,000 link candidates, looks up at
most 250 work streams per RPC, and still applies the existing 100-global and
20-per-connection rewrite bounds.

### 2026-08-13 — Browser handoffs are measurable without becoming link telemetry

**What changed:** Work-stream and generic deep-link pages now emit bounded
presented/automatic/manual handoff-attempt events after their existing local
parsers classify the target.

**Why:** Desktop activation can show that a deep link reached Rally but cannot
show which browser shell presented it or whether a malformed target stopped
before the application.

**Considered and rejected:** Sending the canonical URL, custom-protocol target,
work-stream ID, query, fragment, or treating an attempted navigation as a
successful desktop open. Those alternatives expose resource/token material or
overstate conversion.

**Consequences:** Site and desktop signals describe opposite sides of the
handoff and can be compared only in aggregate today; the public anonymous epoch
is not linked to the desktop account. This was the first recorded changelog
entry; the document predates the changelog rule and earlier reasoning remains
inline rather than being reconstructed.
