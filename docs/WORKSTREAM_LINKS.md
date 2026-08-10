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
workspace permissions after the handoff, and the Slack unfurl deliberately
reveals no work-stream content — see the privacy-safe unfurl rule in
[`SLACK_INTEGRATION.md`](SLACK_INTEGRATION.md).

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
