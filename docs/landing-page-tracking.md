# Landing page tracking

What the landing page at `rallywith.ai/` reports, and what a redesign or edit
must keep so the reporting keeps working. The mechanism behind it is in
[`public-site-telemetry.md`](public-site-telemetry.md).

## What we track

Three events, all anonymous, sent by the site to `api.rallywith.ai` and
forwarded to PostHog. The site loads no PostHog script and sets no cookie.

| PostHog event | Sent when | Carries |
| --- | --- | --- |
| `$pageview` | A page loads | Page class, path, referring domain, `$utm_source` / `$utm_medium` / `$utm_campaign` |
| `$pageleave` | The visitor leaves the page (`pagehide`) | Page class, path, time-on-page bucket (under 1s up to 10m+) |
| `site_action_selected` | A tagged link is clicked | Action, placement, plan (pricing buttons only) |

Tagged links on the landing page, by `data-site-action` id:

| Id | Link | Action · placement |
| --- | --- | --- |
| `download-header` | Header Download for Mac | download · header |
| `download-hero` | Hero Download the macOS beta | download · hero |
| `download-pricing-start` / `-grow` | Start and Grow Start free trial buttons | download · pricing · plan |
| `contact-pricing-enterprise` | Grown up Contact us (emails Katherine and Alex) | founder_contact · pricing · enterprise |
| `demo-request` | Ask for a demo (emails Katherine and Alex) | demo_request · sidekicks |
| `founder-contact` | Founder photos and names | founder_contact · team |
| `support-contact-footer` | Footer help@ email | support_contact · footer |

Not tracked: scrolling, section views, and header nav clicks.

## Don't lose on a redesign

Check these on every edit to the landing page:

1. **Keep `data-site-action` on every download and contact link.** A link
   without it is not counted. A new link needs its id added to
   `SITE_ACTION_LINKS` in `apps/site/src/telemetry.ts`; the site tests fail on
   an unknown id or a tracked id that is missing from the page.
2. **Give each download button its own id.** All four point at the same DMG;
   the id is the only way to tell them apart.
3. **Keep the page at `/`.** The page-view charts filter on `$pathname = '/'`; clicks carry `page: landing` instead.
4. **Keep the telemetry script.** Vite injects `src/site-entry.ts` into every
   page; don't remove the plugin in `apps/site/vite.config.ts`.
5. **Put UTM tags on links that bring people to the page** (utm_source,
   utm_medium, utm_campaign), such as posts, emails and ads. The page reads them from its
   own URL; without them the campaign chart shows only "(none)".
6. **Deploy the API before the site** when adding a new action, placement or
   plan. A merge touching both starts both deploys at once, so run the API
   deploy first. Until the API knows a value it refuses the whole batch that
   carries it, including any page view in that batch.

## Where to look

- **Dashboard:** [Landing page & GTM](https://us.posthog.com/project/541600/dashboard/2150285)
  in PostHog. It shows visits, which download link was clicked, weekly download
  rate, and conversion by referrer and by campaign.
- **Code:** `apps/site/src/telemetry.ts` (reporting and the link table),
  `packages/contracts/src/telemetry.ts` (allowed values).
- **Mechanism:** [`public-site-telemetry.md`](public-site-telemetry.md).
