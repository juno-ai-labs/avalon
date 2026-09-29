# Landing page tracking

What the landing page at `rallywith.ai/` reports, and what a redesign or edit
must keep so the reporting keeps working. The mechanism behind it is in
[`public-site-telemetry.md`](public-site-telemetry.md).

## What we track

Three events, all anonymous, sent by the site to `api.rallywith.ai` and
forwarded to PostHog. The site loads no PostHog script and sets no cookie.

| PostHog event | Sent when | Carries |
| --- | --- | --- |
| `$pageview` | A page loads | Path, referring domain, utm_source / utm_medium / utm_campaign |
| `$pageleave` | The tab is hidden or closed | Path, time-on-page bucket (under 1s up to 10m+) |
| `site_action_selected` | A tagged link is clicked | Action, placement, plan (pricing buttons only) |

Tagged links on the landing page, by `data-site-action` id:

| Id | Link | Action · placement |
| --- | --- | --- |
| `download-header` | Header Download for Mac | download · header |
| `download-hero` | Hero Download the macOS beta | download · hero |
| `download-pricing-pro` / `-max` / `-ultra` | Pricing tier buttons | download · pricing · plan |
| `demo-request` | Ask for a demo | demo_request · sidekicks |
| `founder-contact` | Founder photos and names | founder_contact · team |
| `support-contact-footer` | Footer help@ email | support_contact · footer |

Clicks went untracked from Sep 9 to Sep 29, 2026, after a redesign removed the
reporting.

Not tracked: scrolling, section views, and header nav clicks.

## Don't lose on a redesign

The Sep 9 redesign dropped click tracking without anyone noticing for three
weeks. Check these on every edit:

1. **Keep `data-site-action` on every download and contact link.** A link
   without it is not counted. A new link needs its id added to
   `SITE_ACTION_LINKS` in `apps/site/src/telemetry.ts`; the site tests fail on
   an unknown id.
2. **Give each download button its own id.** All five point at the same DMG;
   the id is the only way to tell them apart.
3. **Keep the page at `/`.** Every landing chart filters on `$pathname = '/'`.
4. **Keep the telemetry script.** Vite injects `src/site-entry.ts` into every
   page; don't remove the plugin in `apps/site/vite.config.ts`.
5. **Put UTM tags on links that bring people to the page** (utm_source,
   utm_medium, utm_campaign), such as posts, emails and ads. The page reads them from its
   own URL; without them the campaign chart shows only "(none)".
6. **Deploy the API before the site** when adding a new action, placement or
   plan. The API refuses events with values it doesn't know.

## Where to look

- **Dashboard:** [Landing page & GTM](https://us.posthog.com/project/541600/dashboard/2150285)
  in PostHog. It shows visits, which download link was clicked, weekly download
  rate, and conversion by referrer and by campaign.
- **Code:** `apps/site/src/telemetry.ts` (reporting and the link table),
  `packages/contracts/src/telemetry.ts` (allowed values).
- **Mechanism:** [`public-site-telemetry.md`](public-site-telemetry.md).
