# Work-stream links

How Avalon links to a work stream from outside the desktop app, and why the
shareable form is an HTTPS URL rather than the `avalon://` deep link.

## The two forms

| Form | Shape | Who mints it |
| --- | --- | --- |
| **Canonical link** | `https://with-avalon.com/app/workstreams/<uuid>` | Every surface that emits a work-stream link |
| **Deep link** | `avalon://workstreams/<uuid>` | The canonical page, in the browser, as the last hop |

`avalon://workstreams/<uuid>` is still the protocol the desktop client
registers, and it is still what actually opens a work stream. It stopped being
what Avalon *hands out*, for three reasons:

- **Slack cannot unfurl it.** Slack emits `link_shared` only for URLs whose
  domain matches one of the app's registered `unfurl_domains`
  (`config/provider-apps/slack.json`). A custom scheme has no registrable
  domain, so no event is ever delivered and no preview can be attached — Slack
  renders the text as a link and nothing more.
- **Mail clients do not linkify it.** A recipient reading a mention email on a
  phone got an unclickable string and no way to reach the work stream.
- **It is dead for anyone without the app.** The canonical page can at least
  say what happened and point at the download.

## Why the id is in the path

The canonical link puts the work-stream id in its **path**, not in a
`#fragment`. This is the difference between the canonical link and the older
`/open#target=avalon://workstreams/<uuid>` handoff it replaces: a fragment is
never sent to a server, which is exactly right for the OAuth ticket handoffs in
[`SECURITY.md`](SECURITY.md), and exactly wrong for a link that a server has to
recognize. Slack's unfurl handler has to read the id off the shared URL, so the
id has to be somewhere a reader can see it.

A work-stream id is not a secret and is not a capability: opening the canonical
link grants nothing on its own. The desktop app applies the viewer's own
workspace permissions after the handoff.

## What the Slack unfurl shows

The card carries the work stream's **title, `harness_status`, last activity, and
automation origin** — enough to know whether the link is worth opening and
whether the agent is blocked. It carries no work-stream *contents*: no objective,
no messages, no resources, no artifacts. Those still need the reader to open
Avalon and pass its own authorization.

A Slack unfurl is one card per link per message, identical for everyone who can
read the channel — `user_auth_required` gates the *sharer*, not the audience, so
there is no per-viewer rendering to hide behind. The audience rule is therefore
deliberately permissive, because the alternative blocks nearly every real link:

| Condition | Card |
| --- | --- |
| Work stream is not in the workspace bound to this Slack team | Anonymous |
| Slack Connect: externally shared channel or external DM | Anonymous |
| Audience lookup (`conversations.info`) failed | Anonymous |
| Anything else — public, private, DM, group DM | Summary |

The workspace check is the one that is not a matter of taste: naming another
Avalon workspace's work stream inside this Slack team is a cross-tenant leak.
The Slack Connect check is about people from other companies. Everything else
inside the workspace sees the summary, on the same reasoning that lets any
internal tool unfurl a title into an internal channel. **A failed check degrades
the card; it never drops the unfurl.**

Last activity is a Slack `<!date^…>` token rather than a baked "24m ago", so it
renders in each reader's timezone and cannot rot between refreshes.

## Keeping a posted card current

A card would otherwise be frozen at the moment the link was pasted: a work
stream shared while `running` would still read `running` after it completed.
`chat.unfurl` accepts the same `channel` + `ts` + `url` again and "will modify
the same attachments," so the fix is to rewrite the card when the work stream
moves on.

Doing that needs the exact `(channel, message_ts, url)` of every message a link
was pasted into, and **Slack only ever reports that once**, in `link_shared` —
it permits `chat.unfurl` only for a URL whose event the app acknowledged, and
offers no way to re-enumerate past events. `slack_unfurled_links` records those
triples as each card is posted. Rows exist only from the moment recording
shipped; anything shared earlier is permanently frozen and cannot be backfilled.

Only cards that showed a summary are recorded. An anonymous card has nothing to
keep current, and a work stream that resolved outside the connection's workspace
must never give the sweep a row it would act on.

The rewrite runs from the five-minute maintenance sweep
(`refreshSlackWorkstreamUnfurls`, wired into `scheduled` in `apps/api/src/index.ts`)
rather than from the status writes. `harness_status` is written from seven
places across the runtime, the scheduler, and the tool layer; hooking each would
be seven chances to miss a transition and no cheaper. A sweep is one place, it
coalesces a burst of transitions into a single rewrite, and a failed refresh is
retried next pass instead of lost. The cost is up to five minutes of staleness.

Its bounds, all deliberate:

| Bound | Value | Why |
| --- | --- | --- |
| Trigger | `harness_status` differs from `rendered_status`, **or** the audience has not been revalidated in 24 hours | Comparing last activity would mark nearly every row stale every pass, since any message bumps it. The audience clock is separate because a channel can become externally shared while the work stream sits still |
| Age | Links shared in the last 30 days | Nobody is rereading an older message |
| Per sweep | 100 rows | Bounds the work; the overflow is logged, never silently dropped |
| Per workspace | 20 rows | `chat.unfurl` is Tier 3 (50+/min per method per workspace) and live `link_shared` unfurls, which someone is waiting on, spend the same budget |

The audience is re-checked once per channel per sweep, which is also the
redaction path: a channel that became externally shared after its card was
posted is rewritten back to the anonymous form. That check runs on its own
24-hour clock rather than only when the status moves, because otherwise a
channel could go externally shared and the card would keep naming the work
stream until some unrelated status change happened to fire. A row selected only
by the audience clock whose verdict has not changed records the check and posts
nothing — `rendered_anonymous` tracks which form is currently on the message, so
an identical card is never rewritten.

Redaction is still bounded by the same 30-day window as the status refresh: a
card older than that is never revisited. That is a deliberate limit rather than
an oversight — an external party added to a channel can read its message history
anyway, so the marginal exposure of an old card's title is small next to what
Slack already showed them.

A refresh that fails with a terminal Slack reason — the message or channel is
gone — deletes the row rather than retrying forever; anything else leaves
`rendered_status` untouched so the next sweep tries again.

## Where it is implemented

| Concern | Location |
| --- | --- |
| Mint, parse, and validate both forms | `packages/contracts/src/workstream-links.ts` |
| Serve `/app/workstreams/<uuid>` | `apps/site/app/workstreams/index.html`, `apps/site/src/workstream-link.ts` |
| Make the dynamic path resolve | `apps/site/public/_redirects` |
| Slack unfurl | `unfurlAvalonLinks` in `apps/api/src/services/slack-agent-service.ts` |
| Slack blocks, DMs, and mention email | `slack-agent-service.ts`, `slack-mention-service.ts`, `mention-email-service.ts` |
| Copy work-stream link | `apps/desktop/src/renderer/screens/workstream.tsx` |
| Open the deep link | `emitDeepLink` in `apps/desktop/src/main/index.ts`, `apps/desktop/src/renderer/lib/app-session.tsx` |

No asset can exist per work-stream id, so the site — a pure static-assets
Worker — serves every id under the prefix from one page through a 200 rewrite in
`_redirects`. The URL is preserved, and the page reads the id back out of
`window.location.pathname`. **Deleting that rewrite turns every shared link into
a 404**, which no test of the page's markup alone would catch; `apps/site/test/site.test.ts`
asserts the rule is present.

## Adding a new surface that links to a work stream

1. Call `workstreamCanonicalUrl(webBaseUrl, workstreamId)`. Do not build either
   URL by hand, and do not emit `avalon://` into anything a human can copy.
2. If the surface *reads* links rather than writing them, use
   `parseWorkstreamLink`. It accepts the canonical link, the raw deep link, and
   the legacy `/open#target=` handoff still sitting in Slack and mail history,
   and it rejects look-alike origins.
3. `workstreamCanonicalUrl` throws on anything that is not a work-stream UUID.
   That is deliberate — a link surface should fail loudly rather than emit a URL
   that 404s for the recipient.

## Deep links that have no canonical form

`avalon://settings/workspace`, `avalon://settings/connections`, and
`avalon://automations/new` still go through the `/open#target=` handoff, whose
allowlist lives in `apps/site/src/desktop-open.ts`. They address no shareable
object, so they need neither a stable URL nor an unfurl. Give a new deep link a
canonical HTTPS form only when someone would reasonably paste it somewhere else.
