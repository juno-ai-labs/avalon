# Landing page tracking

What the landing page at `rallywith.ai/` reports, and what a redesign or edit
must keep so the reporting keeps working. The mechanism behind it is in
[`public-site-telemetry.md`](public-site-telemetry.md).

## Apollo visitor tracking

The production homepage, `/start-fast/`, and the `/concepts/` landing variants
also load Apollo’s website tracker with app ID `6ad67a1c7cdf770018b4f9bc`.
`apps/site/src/apollo-loader.ts` loads it asynchronously through the shared site
entry. Local development, previews, other marketing pages and handoff pages do
not load it. New landing variants must be included in `runsApollo` and in the
landing-only CSP overrides in `apps/site/public/_headers`. The homepage's copy is
set by the site Worker (`apps/site/worker/landing-csp.ts`), not `_headers`:
an exact `/` rule there was served alongside the global policy in production,
which blocked Apollo. Keep the three copies identical.

Apollo sends visits to `aplo-evnt.com` and can load LiveIntent’s identity
resolution script. Those providers have a separate data path from the bounded
first-party events below. The Cookie & Tracking Notice discloses this use.

## X conversion pixel

Every production page except the handoff pages and the not-found page loads
X's conversion pixel (pixel ID `rg7j5`) through `apps/site/src/x-pixel-loader.ts`.
It uses the same page rule as PostHog's SDK (`allowsThirdPartyScripts` in
`credential-paths.ts`), because the pixel sends the full page URL to X. A browser
sending Global Privacy Control never loads it, which the Cookie & Tracking
Notice promises. X's domains are in the global CSP in `apps/site/public/_headers`.

`takeAdClickId` strips `twclid` from the address bar before the pixel's script
has loaded, so the site entry reads it first and writes it into X's own
`_twclid` cookie, which the pixel falls back to when the URL has none. That
cookie format is X's, not ours: if X changes it, X-ad visits stop being
attributed while the pixel keeps firing.

Two kinds of tracked click also send X a custom event, from the browser
(`reportXIntent`): Mac installer links with action `download` send "Rally | Mac
download intent" (`tw-rg7j5-rg7j6`), and every web-app entry link
(`web-app-hero`, `web-app-offer`, `web-app-template`, `sign-in-header`) sends "Rally | Sign up
intent" (`tw-rg7j5-ri4zl`). The header button's label alternates between Sign in
and Sign up, so that event also counts returning users signing in. The X Conversion
API (server-side conversions) is not wired: nothing on the server confirms a
download, so there is no server-side event to send yet. Linux downloads do not
fire the Mac-specific X conversion.

## What we track

Three events, all anonymous, sent by the site to `api.rallywith.ai` and
forwarded to PostHog. These are the source of record for the dashboard.

For a few weeks the page also runs PostHog's session replay and heatmaps; see
[`public-site-telemetry.md`](public-site-telemetry.md#posthog-browser-sdk-temporary).

| PostHog event | Sent when | Carries |
| --- | --- | --- |
| `$pageview` | A page loads | Page class, path, referring domain, `$utm_source` / `$utm_medium` / `$utm_campaign` |
| `$pageleave` | The visitor leaves the page (`pagehide`) | Page class, path, time-on-page bucket (under 1s up to 10m+) |
| `site_action_selected` | A tagged link is clicked | Action, placement, plan (pricing buttons only), flowId (web entry only) |

Tagged links on the landing page, by `data-site-action` id:

| Id | Link | Action · placement |
| --- | --- | --- |
| `sign-in-header` | Open Rally link in the pencil pages' header (homepage, audience pages, marketplace); rolling sign-in button on the supporting pages | primary_cta · header |
| `web-app-hero` | Homepage Connect your Gmail and closing invitation (app.rallywith.ai); every sign-up button on an audience page (`/for/<slug>/`) and on `/off-the-beaten-path/`; primary web entry in `/start-fast/` | secondary_cta · hero |
| `web-app-offer` | Homepage inline browser-entry link under pricing; retains the historical offer action | primary_cta · offer |
| `web-app-template` | Each `/marketplace/` card's Start from this, the template's link on the web app (`/app/templates/<slug>`) | primary_cta · body |
| `download-hero` | Homepage macOS text link; desktop download button on `/start-fast/` | download · hero |
| `download-linux-hero` | Homepage Linux (.deb) text link; desktop download button on `/start-fast/` | download · hero |
| `download-pricing-start` / `-grow` / `-max` / `-ultra` | Start for free and paid-plan Start free trial buttons | download · pricing · plan |
| `contact-pricing-enterprise` | Pricing contact link (emails Adam) | founder_contact · pricing · enterprise |
| `demo-request` | Ask for a demo (emails Adam), under the home page's closing invitation and in the `/sidekicks/` hero | demo_request · sidekicks |
| `support-contact-footer` | Footer help@ email | support_contact · footer |

`demo-request` still reports the `sidekicks` placement after the home page's Sidekicks band was removed, for the same reason.

`web-app-hero` still reports `secondary_cta · hero`, though it is now the primary
hero button on `/`: the value is kept so its history stays comparable, and
`/start-fast/` shares the id. Its clicks cannot be split by device.

Each activation of `web-app-hero`, `web-app-offer`, `web-app-template` or `sign-in-header` creates a fresh opaque
`flowId`, reports it on the action, and sends it to the browser as `signupFlowId`.
Copied links stay clean. Browser entry validates and retains it in tab-scoped
session storage before removing the URL field, so refreshing before sign-in
keeps the landing attribution. Authentication retires it. See
[`public-site-telemetry.md`](public-site-telemetry.md#browser-signup-attribution).

The homepage has no offer card; `web-app-offer` identifies its inline browser-entry link under pricing.

Each audience page at `/for/<slug>/` counts as page class `landing` with its own
`$pathname`, so which audience a visit or a sign-up click came from is read from
the path, and the signup that follows is joined to it by `flowId`. The pages add
no action ids of their own, and the web app is not told the audience: it drops a
query on its root at sign-in ([`links.md`](links.md#template-links)). The
audience pages do not run Apollo; adding them means `runsApollo` and the
landing-only CSP, as for any new landing variant.

Not reported as site events: scrolling, section views, header nav clicks, the
"See pricing" and product-page links. The `/canvases/` and `/sidekicks/` pages count as page
class `landing` with their own `$pathname`; they send people to sign up
through the header button rather than a hero button of their own.

The footer is rendered from `apps/site/src/site-chrome.ts`, so its help@ link and
its id live there, not in `index.html`; see [`site-chrome.md`](site-chrome.md).

`/start-fast/` retains the earlier landing design and its sections in
`apps/site/src/landing-sections.html`; the illustrated homepage has independent
markup in `index.html`. The variant
uses the same link ids, so compare the two by `$pathname`, which every page view
and click now carries. It is `noindex`, so search engines never list it beside `/`.

## Don't lose on a redesign

Check these on every edit to the landing page:

1. **Keep `data-site-action` on every download and contact link.** A link
   without it is not counted. A new link needs its id added to
   `SITE_ACTION_LINKS` in `apps/site/src/telemetry.ts`; the site tests fail on
   an unknown id or a tracked id that is missing from the page.
2. **Give each download button its own id.** Mac buttons link to the DMG and
   Linux links to the AppImage. Both hero downloads currently map to the same
   first-party action/placement; that event does not split downloads by platform.
3. **Keep the page at `/`.** The page-view charts filter on `$pathname = '/'`; clicks carry `page: landing` instead.
4. **Keep the telemetry script.** Vite injects `src/site-entry.ts` into every
   page; don't remove the plugin in `apps/site/vite.config.ts`.
5. **Put UTM tags on links that bring people to the page** (utm_source,
   utm_medium, utm_campaign), such as posts, emails and ads. The page reads them from its
   own URL; without them the campaign chart shows only "(none)".
6. **Deploy the API before the site** when adding a new action, placement, plan or event property. A merge touching both starts both deploys at once, so run the API
   deploy first. Until the API knows a value it refuses the whole batch that
   carries it, including any page view in that batch.

7. **Keep a fresh flow per web entry activation.** Its event and destination
   must carry the same ID; never prepare a shared ID at page load or remove
   browser reload persistence. Signup reports join separate subjects by flow.

8. **Keep the SDK off pages with credentials in their URL.** Every page
   records unless its path is in `CREDENTIAL_PATHS` in
   `apps/site/src/credential-paths.ts`, which also gates the X pixel. A new page that receives a token, ticket,
   grant or resource id in its URL must be added there before it ships.

## Where to look

- **Replays and heatmaps:** PostHog's Session replay and Heatmaps pages,
  filtered to `$current_url` on `rallywith.ai`. A recording opens from any of
  its server `$pageview`s.
- **Dashboard:** [Landing page & GTM](https://us.posthog.com/project/541600/dashboard/2150285)
  in PostHog. It shows visits, which download link was clicked, weekly download
  rate, conversion by referrer and by campaign, and two complete signup flows:
  browser from the web CTA and desktop from opening a fresh install.
- **Code:** `apps/site/src/telemetry.ts` (reporting and the link table),
  `packages/contracts/src/telemetry.ts` (allowed values).
- **Mechanism:** [`public-site-telemetry.md`](public-site-telemetry.md).
