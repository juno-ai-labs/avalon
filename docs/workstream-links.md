# Work-stream links

Every surface that points at a Space, Channel, or Breakout from outside the desktop app uses
`https://rallywith.ai/app/<region>/<organization-base58>/s/<space-base58>/`,
with `/c/<channel-base58>` and optional `/b/<breakout-base58>` appended.
A Sidekick uses `https://rallywith.ai/app/<region>/<organization-base58>/sk/<sidekick-base58>/`.
Each Base58 segment encodes the corresponding 16-byte UUID; the Organization ID
immediately follows the environment/region segment.
The `rallywithai://` deep link
is still what actually opens a work stream, but it is now the last hop of that
HTTPS page rather than the thing Rally hands out — because a custom scheme cannot
be unfurled by Slack, is not linkified by mail clients, and is dead for anyone
without the app installed.

Read this before emitting or parsing a work-stream link anywhere, and before
changing the Slack unfurl card or the sweep that keeps it current.

## Where the code lives

| Concern | Location |
| --- | --- |
| Mint, parse, and validate both forms | `packages/contracts/src/workstream-links.ts` |
| Encode and decode UUID segments | `packages/contracts/src/uuid-base58.ts` |
| Choose a Channel's current Space placement for server-generated links | `WorkspaceDO.canonicalChannelSpace`, `apps/api/src/services/workstream-link-service.ts` |
| Serve current and legacy work-stream paths | `apps/site/app/workstreams/index.html`, `apps/site/src/workstream-link.ts` |
| Make the dynamic path resolve | `apps/site/public/_redirects` |
| The signed-out name lookup the page's heading shows | `apps/api/src/routes/links.ts`, `WorkspaceDO.linkTitle` |
| Style every desktop-handoff page like the desktop sign-in screen | `apps/site/src/desktop-handoff.css` |
| Slack unfurl | `unfurlRallyLinks` in `apps/api/src/services/slack-agent-service.ts` |
| The card's blocks and its one status table | `slack-workstream-card.ts` |
| The refresh sweep | `refreshSlackWorkstreamUnfurls`, wired into `scheduled` in `apps/api/src/index.ts` |
| Authoritative title/status/recency lookup | `WorkspaceDO.lookupWorkstreamDirectory`, batched per workspace by the posting and refresh paths |
| Slack blocks, DMs, and person-notification email (a mention, and being added) | `slack-agent-service.ts`, `slack-notification-service.ts`, `mention-email-service.ts`, `participant-email-service.ts` |
| Shared desktop clipboard and telemetry primitive | `apps/desktop/src/renderer/lib/copy-workstream-link.ts` |
| Copy thread link | `apps/desktop/src/renderer/screens/workstream.tsx` (the title menu's **Copy link** tile) |
| Open the deep link | `emitDeepLink` in `apps/desktop/src/main/index.ts`, `apps/desktop/src/renderer/lib/app-session.tsx` |
| The registered unfurl domains | `config/provider-apps/slack.json` |

## How it works

Breakout links append `/b/<breakout-base58>` to the canonical HTTPS path. Writers omit the suffix for Main (`0`). Both parsers preserve the child ID; desktop workspace activation navigates to the existing internal conversation route. The header's Copy link and child notifications use the same contract. Email reply routing is unchanged.

Since the navigation redesign a stored Space is the product's **Channel** and a
stored Channel is a **thread** ([PRD](PRDs/2026-10-10_channels-threads-navigation/prd.md)).
The link shapes below did not change: `/s/<space>/c/<channel>/b/<breakout>`
already reads Channel, thread, breakout, so every link already shared still
opens what it named. Inside the app, a Space route (`/spaces/:id/*`) redirects
to `/channels/:id`, and a lone thread route (`/workstreams/:id`) redirects to
`/channels/:channel/threads/:id` when the device knows a Channel the thread
sits in (the pane stack, retired 2026-11).

## The two forms

| Form | Shape | Who mints it |
| --- | --- | --- |
| **Space** | `https://rallywith.ai/app/<region>/<organization-base58>/s/<space-base58>/` | Space sharing and handoff |
| **Channel** | Space URL plus `c/<channel-base58>` | Current Channel link writers |
| **Breakout** | Channel URL plus `/b/<breakout-base58>` | Current Breakout link writers |
| **Artifact** | Channel URL plus `/a/<artifact-base58>`: the thread, opened onto that artifact expanded. Never with `/b/` | A pinned artifact's push (`artifact_updated`) |
| **Sidekick** | `https://rallywith.ai/app/<region>/<organization-base58>/sk/<sidekick-base58>/` | The Sidekick screen's menu; hands off to `rallywithai://workspace/<region>/<organization-base58>/sidekicks/<sidekick-base58>` |
| **Deep link** | `rallywithai://workspace/<region>/<organization-base58>/spaces/<space-base58>/channels/<channel-base58>` | The canonical page's last hop; Breakout adds `/breakouts/<breakout-base58>`, Artifact `/artifacts/<artifact-base58>` |
| **Legacy reader** | `/app/workspaces/.../workstreams/...`, `/app/workstreams/...`, or older deep links | Compatibility for already-shared links |

An attachment panel's **Copy URL** tile uses the same `/a/` destination for the
active gallery file, including uploaded files available in the thread's Main.
It is available when the thread has a Channel placement and the file is in Main;
local previews and files available only in a Breakout have no such destination.
The link opens the current resource, including when copied from an older version.
The attachment and resource panels share the same link eligibility and action;
an uploaded file keeps its **Copy link** action when opened in the resource panel.

The desktop still registers `rallywithai://` and reads the older
`rallywithai://workstreams/<uuid>` form. The public HTTPS page hands off through
the addressed Space/Channel deep link; the custom scheme stopped being what
Rally *hands out*, for three reasons:

- **Slack cannot unfurl it.** Slack emits `link_shared` only for URLs whose domain
  matches one of the app's registered `unfurl_domains`. A custom scheme has no
  registrable domain, so no event is ever delivered and no preview can be attached
  — Slack renders the text as a link and nothing more.
- **Mail clients do not linkify it.** A recipient reading a mention email on a
  phone got an unclickable string and no way to reach the work stream.
- **It is dead for anyone without the app.** The canonical page can at least say
  what happened and point at the download.

### The handoff page

The heading reads `Opening “<name>” in Rally`, with the name cut at 40
characters. Holding a link is the permission to see the name of what it
points at, private or not, so the page asks `GET /links/title?path=<its own
path>` on the Global API with no sign-in. The route parses the path with the
same readers the page uses and asks the Organization's object for that one
title: a Channel, Breakout, Space, or a Sidekick that is not deleted. It reads
no viewer, no contents and no other field. An unknown Organization is refused
from D1 before any object opens.

This is looser than the Slack unfurl's audience table above, on purpose: the
product call (2026-10-07) is that whoever holds a link may see the name, color
and icon of what it points at, archived or private included. The unfurl differs
because Rally itself posts the card into a Slack channel, where people who never
opened the link read it; the handoff page shows the name only to the person who
opened the link. Aligning the unfurl with the looser rule would be a separate
decision. Until the answer lands, or when it misses,
the heading is plain `Opening in Rally`, and the buttons work the same either
way. A link minted in a second region needs the page to ask that region's API.

The page offers the desktop app first and the web app beside it. On a Mac it
tries the deep link once on load, shows **Open in Rally for Mac**, then
**Continue in browser**, which opens the same path on `app.rallywith.ai`; the
browser client reads every addressed path this page does
([`browser-client.md`](browser-client.md#the-shell)). Under them sits the Mac
download. On an iPhone or iPad a Channel or Breakout still tries the deleted iOS
app's link, with the browser as the second choice. Where no Rally app can open the link (Windows,
Linux, Android, or a Space or Sidekick on iOS) the page skips the launch and the
browser is the one button. An ID-only link from before workspace addressing
names no Organization, so it gets no browser button.

The page remembers in `localStorage` which button this browser last chose. After
**Continue in browser** it stops launching the app on load, because for someone
without the app that launch is an error prompt every time, but the app stays the
first button. Clicking it switches back. Without storage the page launches the
app every time, as it did before the browser option.

### Why the id is in the path

The canonical link puts the work-stream id in its **path**, not in a `#fragment`.
This is the difference between the canonical link and the older
`/open#target=avalon://workstreams/<uuid>` handoff it replaces: a fragment is never
sent to a server, which is exactly right for the OAuth ticket handoffs in
[`security.md`](security.md), and exactly wrong for a link that a server has to
recognize. Slack's unfurl handler has to read the id off the shared URL, so the id
has to be somewhere a reader can see it.

A work-stream id, region, and workspace id are not secrets and are not a
capability: opening the canonical link grants nothing on its own. The pair is
routing context. The distinct `workspace` host is a version boundary: desktop
builds that predate addressed links reject it instead of silently discarding a
query target and opening the resource in the active workspace. When the link
names the active workspace, the desktop opens it with the session already in
use and navigates at once. Otherwise it asks its native session layer to
revalidate and activate that exact workspace through the platform service,
verifies the returned session matches, and only then navigates; if activation is
refused, the active workspace stays unchanged and no resource route opens. The
regional API applies membership and work-stream authorization on the read under
either path. `multiple-workspaces.md` owns the entry behavior.

No asset can exist per work-stream id, so the site — a pure static-assets Worker —
serves every id under the prefix from one page through a 200 rewrite in
`_redirects`. The URL is preserved, and the page reads the id back out of
`window.location.pathname`.

### What the Slack unfurl shows

The card carries the work stream's **title, last activity, and automation
origin**, plus a **status badge only while it is `running`, `needs_input`, or
`failed`** — enough to know whether the link is worth opening and whether the agent
is blocked.

After the work-stream authority cutover these fields come from the owning
WorkspaceDO directory, not a D1 work-stream projection. The Slack installation,
credentials, link occurrence, and channel/message coordinates remain relational
D1 state; only the work-stream summary is joined in application code through a
bounded typed RPC.

`completed`, `scheduled`, and `idle` render no badge. "Completed" is not something
a reader can act on, and a settled work stream stops producing the changes that
rewrite its card, so that label would sit there indefinitely. The badge is an emoji
leading the title, with the word repeated in the detail line so the emoji is never
the only carrier of meaning; both come from one table in `slack-workstream-card.ts`
so they cannot drift apart, and the running and needs-input marks match App Home's
task rows.

The card carries no work-stream *contents*: no objective, no messages, no
resources. Those still need the reader to open Rally and pass its own
authorization.

A Slack unfurl is one card per link per message, identical for everyone who can
read the channel — `user_auth_required` gates the *sharer*, not the audience, so
there is no per-viewer rendering to hide behind. The audience rule is therefore
deliberately permissive, because the alternative blocks nearly every real link:

| Condition | Card |
| --- | --- |
| Work stream is not in the workspace bound to this Slack team | Anonymous |
| Work stream is archived | Anonymous |
| Slack Connect: externally shared channel or external DM | Anonymous |
| Audience lookup (`conversations.info`) failed | Anonymous when posting; **no rewrite at all** when refreshing |
| Anything else — public, private, DM, group DM | Summary |

The two paths treat an unconfirmed audience differently on purpose. Posting a new
card fails closed, because nothing is lost by withholding detail. Rewriting an
existing one must not, because a five-second timeout would otherwise redact a
correct card and persist that as the truth — so a failed lookup leaves the row
completely untouched and the next sweep retries.

The workspace check is the one that is not a matter of taste: naming another Rally
workspace's work stream inside this Slack team is a cross-tenant leak. The Slack
Connect check is about people from other companies. Everything else inside the
workspace sees the summary, on the same reasoning that lets any internal tool
unfurl a title into an internal channel.

Last activity is a Slack `<!date^…>` token rather than a baked "24m ago", so it
renders in each reader's timezone and cannot rot between refreshes.

### Keeping a posted card current

A card would otherwise be frozen at the moment the link was pasted: a work stream
shared while `running` would still read `running` after it completed. `chat.unfurl`
accepts the same `channel` + `ts` + `url` again and "will modify the same
attachments," so the fix is to rewrite the card when the work stream moves on.

Doing that needs the exact `(channel, message_ts, url)` of every message a link was
pasted into, and **Slack only ever reports that once**, in `link_shared` — it
permits `chat.unfurl` only for a URL whose event the app acknowledged, and offers no
way to re-enumerate past events. `slack_unfurled_links` records those triples as
each card is posted.

Only cards that showed a summary are recorded. An anonymous card has nothing to keep
current, and a work stream that resolved outside the connection's workspace must
never give the sweep a row it would act on.

The rewrite runs from the five-minute maintenance sweep rather than from the status
writes. Workstream status is aggregated inside many independently active object
paths; hooking external Slack writes to each would create many chances to miss a
transition and no cheaper. A sweep is one place, it coalesces a burst of transitions
into a single rewrite, and a failed refresh is retried next pass instead of lost.
The cost is up to five minutes of staleness.

The audience is re-checked once per channel per sweep, which is also the redaction
path: a channel that became externally shared after its card was posted is rewritten
back to the anonymous form. That check runs on its own 24-hour clock rather than
only when the status moves, because otherwise a channel could go externally shared
and the card would keep naming the work stream until some unrelated status change
happened to fire. A row selected only by the audience clock whose verdict has not
changed records the check and posts nothing — `rendered_anonymous` tracks which form
is currently on the message, so an identical card is never rewritten.

### What the hash does and does not promise

`rendered_hash` decides whether a **selected** row is rewritten; the selection query
decides which rows are looked at. Those are different, and the gap is worth stating
plainly.

After cutover the sweep first loads at most 5,000 recent D1 link occurrences,
groups their distinct work-stream IDs by workspace, and calls WorkspaceDO in
pages of 250. It then selects cards on status drift, an edit to the work stream
itself, the 24-hour audience clock, or a missing hash. The edit arm is what covers a rename: the title
renders but no status moves, so `updated_at > refreshed_at` is the only thing that
would notice. **A card therefore catches up with an edit on the next five-minute
sweep, not a day later.**

Selecting a row is not the same as rewriting it. An edit that never reaches the card
— changing the objective, which `updated_at` bumps but the card never shows —
selects the row, matches on hash, and posts nothing. That is why every field the
selection query reads is advanced when a card is marked current: leave `refreshed_at`
behind and that row is re-selected on every sweep for 30 days, comparing hashes
forever.

What is still bounded by the daily clock is a change that neither moves the status
nor touches the work stream row — the channel becoming externally shared is the real
case, and redaction there is worth the 24-hour worst case rather than a
`conversations.info` call per card per sweep.

A row with no hash is one recorded before hashing shipped. Null never matches a
freshly computed hash, so each such card is rewritten exactly once and then settles —
which is what carries an existing card across a change to the card's own layout,
with no version constant for a future change to remember to bump.

## Invariants

- **The Organization-addressed hierarchical HTTPS link is the only form Rally hands out.** Never emit
  `rallywithai://` into anything a human can copy; it cannot be unfurled, linkified, or
  opened without the app.
- **The work-stream id lives in the path, never in a fragment.** A server has to be
  able to read it, which is the exact opposite of what the OAuth handoffs need.
- **Every Channel or Breakout link is minted by `workstreamCanonicalUrl` and read by
  `parseWorkstreamLinkTarget`.** A URL built by hand is a URL that drifts from the site's
  rewrite rule.
- **A Channel's Space segment comes from current WorkspaceDO placement.** The
  URL is a navigation hint, not an authorization grant; a stale placement must
  not bypass the regional API's Channel and Space checks.
- **`workstreamCanonicalUrl` throws on anything that is not a work-stream UUID.**
  Deliberate — a link surface should fail loudly rather than emit a URL that 404s
  for the recipient.
- **The `_redirects` rewrite is load-bearing.** Deleting it turns every shared link
  into a 404, which no test of the page's markup alone would catch. No automated
  test covers the rule; it is deploy configuration, which the deploy itself is
  the test of ([`testing.md`](testing.md#do-not-test-ci-or-deployment-configuration)).
- **A `slack_unfurled_links` row is written as the card is posted, or never.** Slack
  reports a shared link exactly once and offers no way to re-enumerate past events,
  so a missed write is permanent.
- **Only summary cards are recorded.** Recording an anonymous card, or one that
  resolved outside the connection's workspace, hands the sweep a row it must not act
  on.
- **A failed check degrades the card; it never drops the unfurl.**
- **A failed audience lookup never redacts an existing card.** Posting fails closed;
  refreshing fails untouched, or a five-second timeout persists a redaction as the
  truth.
- **Every field the selection query reads is advanced when a card is marked
  current**, including when nothing was posted — otherwise the row is re-selected on
  every sweep for 30 days.

## Boundary

This module owns the two link forms, the page that serves them, and the Slack
unfurl card and its refresh. It does not own the Slack connector's ingress, its
scopes, or its other surfaces — [`slack-integration.md`](slack-integration.md) and
[`slack-permissions.md`](slack-permissions.md) do — and it does not own the OAuth
handoff the fragment form is reserved for, which is [`security.md`](security.md).
The row it stores is described in [`data-model.md`](data-model.md).

### Adding a surface that links to a work stream

1. Call `workstreamCanonicalUrl(webBaseUrl, { region, workspaceId, workstreamId })`.
   Do not build either URL by hand.
2. If the surface *reads* links rather than writing them, use `parseWorkstreamLinkTarget`.
   It accepts the canonical link, the raw deep link, and the legacy `/open#target=`
   handoff still sitting in Slack and mail history, and it rejects look-alike
   origins.

### Deep links that have no canonical form

Settings and automation deep links still go through the `/open#target=` handoff, whose
allowlist lives in the shared `desktop-deep-link-intent` contract. They address no shareable
object, so they need neither a stable URL nor an unfurl, but every newly emitted
one uses the same `workspace/<region>/<workspace-uuid>/<destination>` wrapper so a notification cannot
open the same section in whichever workspace happens to be active. Give a new deep link a
canonical HTTPS form only when someone would reasonably paste it somewhere else.

Every browser handoff reports only its closed type, `presented`/`automatic`/
`manual`/`browser` method, and local validity through the public-site telemetry boundary.
The canonical work-stream UUID, custom-protocol target, query, fragment, and any
single-use material are deliberately excluded. The desktop separately observes a
successful deep-link activation; the site event is an attempt, not proof that the
app opened.

## Failure modes and limits

The refresh sweep's bounds, all deliberate:

| Bound | Value | Why |
| --- | --- | --- |
| Candidate link scan | 5,000 recent D1 occurrences, then WorkspaceDO lookups in 250-ID pages | Bounds relational coordinates loaded before authoritative work-stream filtering without issuing one object RPC per link |
| Trigger | `harness_status` differs from `rendered_status`, the work stream was edited since the card was last written (`updated_at > refreshed_at`), the audience has not been revalidated in 24 hours, **or** the row has no `rendered_hash` | Comparing last activity would mark nearly every row stale every pass, since any message bumps it. The audience clock is separate because a channel can become externally shared while the work stream sits still |
| Rewrite | Only when the card's **rendered blocks** hash differently from what is posted | The real question is "would this render differently?", and no stored field answers it: the drawing code can change, the title and activity stamp both render, and an anonymous card is identical whatever the status does. A selected row whose hash matches records its new status and posts nothing |
| Age | Links shared in the last 30 days | Nobody is rereading an older message |
| Per sweep | 100 rows | Bounds the work; the overflow is logged, never silently dropped |
| Per workspace | 20 rows | `chat.unfurl` is Tier 3 (50+/min per method per workspace) and live `link_shared` unfurls, which someone is waiting on, spend the same budget |

- **Cards shared before recording shipped are permanently frozen** and cannot be
  backfilled, because Slack will not re-report the `link_shared` events behind them.
- **Redaction is bounded by the same 30-day window** as the status refresh: a card
  older than that is never revisited. That is a deliberate limit rather than an
  oversight — an external party added to a channel can read its message history
  anyway, so the marginal exposure of an old card's title is small next to what
  Slack already showed them.
- **A refresh that fails with a terminal Slack reason** — the message or channel is
  gone — deletes the row rather than retrying forever. Anything else leaves
  `rendered_status` untouched so the next sweep tries again.
- **A WorkspaceDO lookup failure leaves every affected link untouched.** D1 is
  not a summary fallback; the next five-minute sweep retries the authoritative
  object.
- **A link whose work stream is archived, or absent from the directory page,
  has `refreshed_at` advanced like an unchanged card.** There is no card to
  refresh, but the sweep's due time is the oldest `refreshed_at` in the table
  ([`durable-object-alarms.md`](durable-object-alarms.md)), and a row left
  behind pinned the whole workspace's sweep: it came straight back for the row
  it had just skipped, and since the stall gate would be held and reported for
  a link nobody will ever refresh. The due-time query also counts only links
  on a connection that is not disabled, because the sweep loads only those.
- **Up to five minutes of staleness** is the accepted cost of sweeping rather than
  hooking the seven `harness_status` writers.

## Testing

| Suite | Covers |
| --- | --- |
| `packages/contracts/src/workstream-links.test.ts` | Minting, parsing all three accepted forms, look-alike origin rejection, and the throw on a non-UUID. |
| `apps/api/test/slack-unfurl-refresh.test.ts` | WorkspaceDO directory lookup, selection, the hash gate, the audience clock, redaction, the per-sweep/per-connection bounds, and terminal-reason deletion. |
| `apps/api/test/slack-agent-ingress.test.ts` | `link_shared` handling and the card posted in response. |

The trap is that the sweep's rules are all relative-time comparisons
(`updated_at > refreshed_at`, the 24-hour clock, the 30-day window). Stub the clock;
a test that leans on real time either passes by accident or fails on a slow machine.

## Data model

`slack_unfurled_links` records which Slack message carries which work-stream link,
plus `rendered_status`, `rendered_anonymous`, `rendered_hash`, and `refreshed_at` —
the four D1 fields the selection/rewrite gate reads. Current title, automation
origin, work-stream update time, recency, archive, and harness status are not
copied into this table; they come from `WorkspaceDO.channels`.
[`data-model.md`](data-model.md) is authoritative for the columns.

## Apple universal links

Both Rally hosts serve `/.well-known/apple-app-site-association`. Desktop claims
`/app/*`; the file still lists the deleted iOS client on the earlier
`/app/workspaces/*` and `/app/workstreams/*` paths. A canonical Channel or
Breakout link opens the site handoff, which uses the old addressed iPhone
reader. Space-only and Sidekick URLs open in the web app on an iPhone.
The desktop main process adapts these HTTPS links with `workstreamHttpsDeepLink`, then
uses existing scheme navigation. Legacy origins and other path families remain
in the browser. The site must deploy before a desktop release that relies on a
new path. Push clicks
use the same adapter with notification attribution. See [push](push-notifications.md).

## Changelog

### 2026-11-06 — The iOS client is deleted

The iPhone entry in the Apple association file and the site handoff's iPhone
branch existed only for `apps/ios`, which is deleted; both stay in site code
until a later phase of the [Canvases and Sidekicks pivot](PRDs/2026-11-06_canvases-and-sidekicks/prd.md) removes them.

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
