# https work-stream links open the app

> Created 2026-09-11.
>
> A canonical `https://rallywith.ai/app/workspaces/…` work-stream link clicked
> on a Mac with Rally installed opens Rally directly, as an Apple universal
> link, and a future iOS client does the same with no server change. Companion
> to [Apple push notifications](../2026-09-11_apple-push-notifications/prd.md),
> which creates the App ID capability and provisioning profile this depends on;
> sequenced after its desktop phase. Read alongside
> [`links.md`](../../links.md), which owns the link, and
> [`domain-migration.md`](../../domain-migration.md), which owns the hostnames
> and the deep-link scheme. Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

Today every work-stream link Rally emits to the outside — a Slack unfurl, a
mention email, a digest, a pasted URL — is an https link to the site. Clicking
it lands on a handoff page at `/app/workspaces/…`, which mints a
`rallywithai://` link and offers an **Open Rally** button; the browser then asks
whether to open the app. After this change, on a Mac with Rally installed, the
operating system opens Rally at that work stream without the page or the
prompt. Without Rally installed, the page still serves, unchanged. On iOS the
same link opens the phone client once one exists, because Apple resolves the
association per app id and the site already declares it.

## Motivation

- **The handoff page is a detour every external click pays.** A person clicking
  a mention email or a Slack card sees a web page, a button, and a browser
  confirmation dialog before the work stream. The page exists because a browser
  cannot open a custom scheme silently; a universal link is the platform's
  answer to exactly that.
- **iOS will need it before it ships.** A phone client whose links open Safari
  is a client whose links do not work. The site half — the association file
  and its paths — is identical for macOS and iOS, and the App ID capability is
  being enabled for push now; doing the site half beside push means the iOS
  client inherits working links on day one.
- **Push already puts the https link in every payload.** The push PRD carries
  the canonical link as `rally.url` so a phone can treat it as a universal
  link later. This PRD is what makes that true.

## Goals

1. A canonical work-stream link clicked in Mail, Slack, or a browser on a Mac
   with Rally installed opens Rally at that work stream, or private child, with
   no page and no prompt.
2. The same link on a Mac without Rally, or on any other platform, behaves
   exactly as today: the handoff page, the button, the download.
3. Only work-stream and handoff paths are claimed. The rest of `rallywith.ai`
   keeps opening in the browser on every Mac.
4. Adding the iOS app is one entry in the association file and one entitlement
   in that client; nothing on the site or the API changes.
5. The release verifier proves the entitlement, the profile capability, and the
   association file agree before a build is promoted.

## Non-goals

1. **Associating the legacy origins.** `with-avalon.com` and its `www` are
   served for links already circulating and are on a path to retirement per
   [`domain-migration.md`](../../domain-migration.md); an association there
   would have to be unwound later. Those links keep landing on the handoff
   page. Deferred, with a bias to never.
2. **Retiring the `rallywithai://` scheme or the handoff page.** Both remain:
   the scheme for the auth callback and for older builds, the page for every
   Mac without Rally and for every other platform. Rejected.
3. **Universal links for anything other than work-stream links.** Settings,
   automation, and connector-completion deep links have no canonical https
   form ([`links.md`](../../links.md#deep-links-that-have-no-canonical-form)).
   Deferred until one exists.
4. **Handoff on Windows or Linux.** Neither has an equivalent Rally supports
   today. Deferred.
5. **Changing what a link contains.** The path grammar, the workspace and
   resource ids, and the hash are untouched; this PRD changes who opens the
   link, not what it says. Rejected.

## Product behavior

**On a Mac with Rally installed.** Clicking a canonical work-stream link in
another app opens Rally — launching it if needed — at that work stream, through
the same in-app path a `rallywithai://` link takes, attributed as the
`deep_link` entrypoint. A signed-out client shows sign-in and keeps the link for
after. Clicking a link inside Rally itself is unchanged: it is already an
in-app link. Typing the URL into Safari, or navigating to it from another
`rallywith.ai` page, opens the web page, which is macOS's own rule for
universal links and is why the handoff page must keep working.

**Cold launch.** A universal link that starts Rally arrives as a
`continue-activity` before the window exists; the main process queues it
through `pendingDeepLinks`, exactly as an early `open-url` is, and delivers it
once the renderer is ready. A signed-out client keeps it for after sign-in.

**On a Mac without Rally, or elsewhere.** The handoff page, exactly as today.

**When the app declines the link.** A link Rally cannot route — an unknown
workspace, a malformed id — is refused the way a refused `rallywithai://` link
is, in the always-on-top window
[`deep-link-failures.md`](../../deep-link-failures.md) owns. It does not fall
back to the browser: the operating system has already handed it over.

**Rollout order matters more than usual.** The association file must be live
on `rallywith.ai` and `www.rallywith.ai` before a build that declares the
domain is released, because macOS fetches it (through Apple's CDN) when the
app is installed and caches the answer. A build released first learns that
there is nothing to associate and retries on its own schedule, which is a
silently broken feature for however long that takes.

## Impact on the product contract

None — this refines behavior within the existing contract. The link is the
same link, addressed to the same work stream; the operating system now opens it
in the client instead of asking.

## Decision log

None yet.

## Key design decisions

1. **Claim `/app/workspaces/*` and `/app/workstreams/*` only.** The association
   file's `components` restrict the app to the two path families the site
   rewrites to the handoff page. Rejected: `/*`, which would make every
   marketing, download, and support link on a Mac with Rally open the app.
2. **Serve the file from the site's static assets.** `apps/site/public/.well-known/apple-app-site-association`,
   with a `Content-Type: application/json` and a short cache header added in
   `_headers` under a new `/.well-known/*` block. The file is extensionless, so
   the served type depends entirely on that override; whether Workers Assets
   honours a `Content-Type` set in `_headers` is confirmed in the first build
   step, and if it does not, the fallback is a small Worker route in front of
   the assets rather than a renamed file, because Apple fetches the exact path.
   The existing Workers Assets deployment serves it on every route the site
   owns; the legacy origins are excluded by the entitlement listing only the
   two Rally hosts, not by hiding the file. Rejected as the first choice: a
   Worker route that generates the file, which is more machinery for a static
   document unless the header override turns out not to work.
3. **An adapter feeds the https form into the intent path; the scheme
   grammar is untouched.** The main process's accepted-link gate
   (`acceptedDeepLink` in `deep-links.ts`) delegates to
   `parseDesktopDeepLinkIntent`, a scheme-plus-hostname grammar shared by main,
   the public site, and the renderer, whose branches key on hostnames such as
   `workstreams` and `settings`; it cannot read a `rallywith.ai` path, it
   rejects any URL with a hash, and its protocol list is mid-migration. So the
   universal-link handler runs `parseWorkstreamLinkTarget` (which already reads
   the canonical https link and the handoff hash form) on `webpageURL`, builds
   a `DesktopDeepLinkIntent` of `kind: "workstream"` from the result, and hands
   that to the same dispatch a scheme link reaches. The https URL never enters
   the scheme grammar, nothing else that calls it changes, and by construction
   the https reader can only ever produce a work-stream intent, never a
   `slack-link` or `auth/complete` one. Rejected: adding `https:` to the
   protocol list, which would parse nonsense like `https://workstreams/<id>`,
   widen the site's and renderer's allowlist, and still not read the real link.
4. **The entitlement lands after the file, in its own release.** Two releases:
   the site's, then the desktop's. Rejected: one merge that does both, because
   the site and the desktop deploy independently on the same push and the
   order between them is not guaranteed.
5. **Reuse the push PRD's profile.** The Associated Domains capability is
   enabled beside Push Notifications when that profile is generated, so this
   PRD adds an entitlement and nothing in the portal. Rejected: a second
   profile, secret, and release.

## Regional impact

None. The link already carries the region in its path; the association is
between a hostname and an app, and the API is not involved.

## Security and trust model

- The association file names only the team-prefixed app id and the two path
  families. It contains no secrets and is public by design.
- The main process validates a universal link with the same parser and the
  same refusal path as a scheme link; an https origin is not trusted more
  because the operating system delivered it.
- `com.apple.developer.associated-domains` is a restricted entitlement and
  goes on the main bundle only; helpers keep their exact three
  ([`security.md`](../../security.md#macos-distribution-and-updates)).
- The verifier's entitlement set for the main app becomes exact once this
  lands: the original three, `aps-environment`, and `associated-domains` with
  exactly `applinks:rallywith.ai` and `applinks:www.rallywith.ai`.

## Provider configuration

Apple: nothing beyond what the push PRD's deployment checklist already enables
on the App ID and bakes into the provisioning profile. If that profile was
generated without Associated Domains, it is regenerated, the repository secret
replaced, and a release cut, before this PRD's desktop change.

## Rollout

No flag. The feature is a property of an installed build and a served file, and
neither can be turned on per person; the operator control is the association
file itself, whose removal (or an empty `details` array) makes every Mac fall
back to the handoff page at its next refresh.

1. **Site.** Add the association file and its headers; extend the site's
   deployment check (`scripts/check-workspace-handoff-site.mjs` is the
   precedent) to fetch `/.well-known/apple-app-site-association` on both Rally
   hosts and require the app id, the two path families, JSON content type, and
   no redirect. Update [`domain-migration.md`](../../domain-migration.md) with
   the association as a fourth thing that moves with a hostname, and
   [`links.md`](../../links.md) with the universal-link
   reader.
2. **Desktop.** `continue-activity` handler for `NSUserActivityTypeBrowsingWeb`
   reading `details.webpageURL`, the adapter from `parseWorkstreamLinkTarget`
   to a work-stream intent (key design decision 3), queuing through
   `pendingDeepLinks` before the window exists, the entitlement, the verifier's exact main-app entitlement set,
   and `test:release` fixtures. The handoff telemetry in
   [`public-site-telemetry.md`](../../public-site-telemetry.md) gains nothing:
   a universal link never reaches the page, so fewer handoffs are the signal.
3. **Verify** on a Mac with the release installed: a link from Mail opens the
   work stream; the same link typed into Safari shows the page; a link on
   `with-avalon.com` shows the page.

Backing out: remove the file (macOS falls back at its next refresh) or ship a
build without the entitlement. Neither strands a link.

## Acceptance

1. A canonical work-stream link clicked in Mail on a Mac with Rally installed
   opens that work stream with no page and no prompt; a private-child link
   opens the child.
2. The same link on a Mac without Rally shows the handoff page.
3. A `with-avalon.com` link shows the handoff page on every Mac.
4. A support or download link on `rallywith.ai` opens in the browser on a Mac
   with Rally installed.
5. The site deployment check refuses a deploy whose association file is
   missing, redirected, or mistyped.

## Open questions

1. **Whether to associate `www.rallywith.ai` at all, or redirect it to the apex
   first.** Both hosts serve the site today. Recommendation: associate both;
   an association on a host that redirects is ignored, and a redirect added
   later costs nothing. Blocks nothing.
