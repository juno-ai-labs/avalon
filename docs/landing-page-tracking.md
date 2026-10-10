# Landing page tracking

What the landing page at `rallywith.ai/` reports, and what a redesign or edit
must keep so the reporting keeps working. The mechanism behind it is in
[`public-site-telemetry.md`](public-site-telemetry.md).

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
| `download-header` | Header Download for Mac | download · header |
| `sign-in-header` | Header sign-in button, its label rolling between Sign in to Rally and Sign up for Rally (shown instead of Download for Mac on touch-only devices) | primary_cta · header |
| `download-hero` | Hero Download the macOS beta | download · hero |
| `web-app-hero` | Hero Use the web app (app.rallywith.ai) | secondary_cta · hero |
| `download-pricing-start` / `-grow` | Start and Grow Start free trial buttons | download · pricing · plan |
| `contact-pricing-enterprise` | Grown up Contact us (emails Katherine) | founder_contact · pricing · enterprise |
| `demo-request` | Ask for a demo (emails Katherine and Alex) | demo_request · sidekicks |
| `founder-contact` | Founder photos and names | founder_contact · team |
| `support-contact-footer` | Footer help@ email | support_contact · footer |

`web-app-hero` reports `secondary_cta · hero` on every device, including
phones where it is the only hero button, so its clicks cannot be split by device.

Each activation of `web-app-hero` or `sign-in-header` creates a fresh opaque
`flowId`, reports it on the action, and sends it to the browser as `signupFlowId`.
Copied links stay clean. Browser entry validates and retains it in tab-scoped
session storage before removing the URL field, so refreshing before sign-in
keeps the landing attribution. Authentication retires it. See
[`public-site-telemetry.md`](public-site-telemetry.md#browser-signup-attribution).

Not reported as site events: scrolling, section views, header nav clicks, and
the founders' LinkedIn, GitHub and Hugging Face links.

The footer is rendered from `apps/site/src/site-chrome.ts`, so its help@ link and
its id live there, not in `index.html`. The `/compare/` pages share the header
(`download-header` / `sign-in-header`) and the footer, and count as page class `landing` with
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
   records unless its path is in `RECORDING_DENIED_PATHS` in
   `apps/site/src/posthog-loader.ts`. A new page that receives a token, ticket,
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
