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
landing-only CSP overrides in `apps/site/public/_headers`. The homepage needs
its override under both `/` and `/index.html`: with only `/`, production served
the homepage both policies, and the stricter one blocked Apollo.

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

Every link whose site action is `download` also sends X the "Rally | Mac
download intent" event (`tw-rg7j5-rg7j6`), from the browser. The X Conversion
API (server-side conversions) is not wired: nothing on the server confirms a
download, so there is no server-side event to send yet.

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
| `sign-in-header` | Header sign-in button, its label rolling between Sign in to Rally and Sign up for Rally, on every device | primary_cta · header |
| `web-app-hero` | Hero Sign up now (app.rallywith.ai), the left and primary button | secondary_cta · hero |
| `web-app-offer` | Sign up in the pilot offer card (app.rallywith.ai, with `pilotOfferFirstSeen`), which slides in two seconds after the page loads | primary_cta · offer |
| `download-hero` | Hero Download the macOS app, the right and secondary button, hidden on touch-only devices | download · hero |
| `download-pricing-start` / `-grow` | Start and Grow Start free trial buttons | download · pricing · plan |
| `contact-pricing-enterprise` | Grown up Contact us (emails Katherine) | founder_contact · pricing · enterprise |
| `demo-request` | Ask for a demo (emails Katherine and Alex) | demo_request · sidekicks |
| `founder-contact` | Founder photos and names | founder_contact · team |
| `support-contact-footer` | Footer help@ email | support_contact · footer |

`web-app-hero` still reports `secondary_cta · hero`, though it is now the primary
hero button on `/`: the value is kept so its history stays comparable, and
`/start-fast/` shares the id. Its clicks cannot be split by device.

Each activation of `web-app-hero`, `web-app-offer` or `sign-in-header` creates a fresh opaque
`flowId`, reports it on the action, and sends it to the browser as `signupFlowId`.
Copied links stay clean. Browser entry validates and retains it in tab-scoped
session storage before removing the URL field, so refreshing before sign-in
keeps the landing attribution. Authentication retires it. See
[`public-site-telemetry.md`](public-site-telemetry.md#browser-signup-attribution).

The pilot offer card is on `/` only, not `/start-fast/`. It gives each visitor
their own deadline: six days after the day this browser first showed the card,
stored as that local date in `rally.site.pilot-offer-first-seen.v1` and kept on
later visits. After that day the card stops showing; whoever signs up by their
date gets the offer. Its Sign up link carries the first-visit date as
`pilotOfferFirstSeen=YYYY-MM-DD`, which the web app does not read yet. Closing
the card or following its link keeps it away in that browser
(`rally.site.pilot-offer-dismissed.v1` in local storage). Neither its
appearance nor its close is reported.

Not reported as site events: scrolling, section views, header nav clicks, and
the founders' LinkedIn, GitHub and Hugging Face links.

The footer is rendered from `apps/site/src/site-chrome.ts`, so its help@ link and
its id live there, not in `index.html`. The `/compare/` pages share the header
(`sign-in-header`) and the footer, and count as page class `landing` with
their own `$pathname`; see [`landing-comparisons.md`](landing-comparisons.md).

`/start-fast/` is a variant of the home page with its own hero; everything below
the hero is shared with `/` through `apps/site/src/landing-sections.html`. It
uses the same link ids, so compare the two by `$pathname`, which every page view
and click now carries. It is `noindex`, so search engines never list it beside `/`.

## Don't lose on a redesign

Check these on every edit to the landing page:

1. **Keep `data-site-action` on every download and contact link.** A link
   without it is not counted. A new link needs its id added to
   `SITE_ACTION_LINKS` in `apps/site/src/telemetry.ts`; the site tests fail on
   an unknown id or a tracked id that is missing from the page.
2. **Give each download button its own id.** All of them point at the same DMG;
   the id is the only way to tell them apart.
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
