# Windows desktop client

> Created 2026-08-21.
>
> Avalon ships a signed, auto-updating Windows x64 desktop client alongside the
> existing macOS client, from the same codebase, version train, and release
> pipeline. Meeting recording, the tray icon, and launch-at-login are
> deliberately not part of it. Companion: [research](research.md),
> [state](state.md). Standing contract:
> [the Avalon implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

A person on a Windows PC can download Avalon from `with-avalon.com`, install
it, sign in with Google through the system browser, and use their workspace —
work streams, automations, dictation, settings, invitations — the same way a
Mac user does today. The build is Authenticode-signed, updates itself from
`downloads.with-avalon.com`, and follows the same minor-version release cadence
as the macOS client.

The client is a port, not a re-implementation: the renderer, preload, and
almost all of the main process are already platform-neutral TypeScript, and the
Electron builder configuration has carried an unused `win` (NSIS) target since
the beginning. What actually changes is the seam around them — the release
scripts, which today refuse to run anywhere but arm64 macOS; the update feed
and the site's release config, which today assume exactly one platform exists;
and a handful of main-process capability gates that need a decided Windows
answer rather than an accidental one. Three macOS capabilities are explicitly
not ported: meeting recording (the Core Audio tap), the menu bar status item,
and launch-at-login.

## Motivation

This is a product-directed distribution decision, not a response to a
quantified demand signal: no customer commitment, seat count, or support-thread
baseline was supplied when the work was requested, and this PRD does not invent
one. The case is structural:

- Avalon is desktop-only by design — [the implementation
  brief](../2026-08-05_avalon-implementation-brief/prd.md) defines the product
  around the Electron client, and `with-avalon.com/app/workstreams/<uuid>`
  links resolve into it. A workspace teammate on Windows today cannot
  participate at all; there is no degraded path, because there is no web app to
  fall back to. Every mixed-OS team Avalon sells into hits this as a hard wall,
  and workspaces are collaborative by nature — one Windows machine on a team
  blocks the team, not the person.
- The cost of leaving it alone compounds through the release tooling. Every
  release script hardens the single-platform assumption further —
  `verify-macos-app.mjs` fails unless `lipo` reports exactly `arm64` (and
  shells out to macOS-only tooling — `codesign`, `spctl`, `plutil` —
  throughout, so its Windows sibling is new code, not a port),
  `release-lib.mjs` exports one `DEFAULT_RELEASE_PREFIX`, and
  `apps/site/release.config.json` is a single-platform object. Each new
  invariant added to that suite is one more thing to unwind later; doing the
  singular-to-plural refactor now is cheaper than doing it after another year
  of accretion.
- The client itself is already most of the way there. Windows deep-link
  delivery (`second-instance` argv scanning), `setAppUserModelId`, non-darwin
  window-icon and title-bar fallbacks, and `safeStorage` session encryption
  (DPAPI on Windows) are all in the codebase and merely unexercised. The
  marginal cost of Windows is concentrated in the release pipeline, not the
  product.

## Goals

1. A Windows 11 or Windows 10 x64 user can install Avalon from the public
   download page, complete Google sign-in via the `avalon://` browser handoff,
   and reach their workspace — the full flow, on a machine that has never seen
   a development environment. Windows 10 (1809+, Electron's support floor)
   passed its October 2025 end of support; its inclusion is deliberate — the
   installed base is still large — with verification on Windows 11 (CI and
   the physical machine) and Windows 10 best-effort.
2. The installed client performs every workspace surface the macOS client
   offers except the three excluded capabilities: work streams, automations,
   settings, invitations, connectors, dictation, message export, theming.
3. Windows builds are Authenticode-signed via Azure Artifact Signing from CI,
   with no hardware token and no human in the signing path.
4. An installed Windows client updates itself from
   `downloads.with-avalon.com` when a new version is published, through the
   same electron-updater mechanism the macOS client uses.
5. One version number and one release process cover both platforms: a release
   tag produces macOS and Windows artifacts at the same version, under the
   existing advance-the-minor version policy, with the release-invariant test
   suite (`test:release`) extended to cover the Windows artifacts.
6. The macOS release path is provably undisturbed: every existing macOS release
   invariant still holds, and the site can publish the two platforms
   independently, so a Windows verification problem never blocks a macOS
   release (or vice versa).
7. Every Windows-visible screen has been looked at in a real window before
   release — per the repository's standing rule — with per-PR screenshot
   evidence from CI and a pre-release pass on a physical Windows machine.

## Non-goals

1. **Meeting recording and Control Tower on Windows.** Rejected for this PRD.
   Computer-audio capture is hand-written Core Audio
   (`apps/desktop/native/system-audio-tap/SystemAudioTap.mm`); Windows would require a
   from-scratch WASAPI loopback implementation, a second native toolchain in
   CI, and a permission/disclosure story of its own — plausibly the cost of
   everything else in this PRD combined. The product owner has explicitly
   declined it. Nothing in this PRD keeps a partial path open; a future PRD
   must make the whole case. Windows hides the meeting-notes surfaces entirely
   (see Product behavior).
2. **Tray icon (the Windows counterpart of the macOS menu bar item) and
   launch-at-login.** Deferred. The menu bar item's purpose is an app that
   stays reachable with no window open, which on Windows requires close-to-tray
   semantics, new tray artwork, and a background-process story. Windows v1 is
   an ordinary windowed application: closing the last window quits. The two
   settings rows (`Show Avalon in the menu bar`, `Open Avalon at login`) do not
   appear on Windows. Revisit when Windows users ask for it.
3. **Windows arm64.** Deferred. Windows-on-ARM runs x64 binaries through
   built-in emulation, so a single x64 build covers the whole installed base at
   some battery/performance cost on ARM laptops. The plural release-config
   schema this PRD introduces is designed so adding a `win32/arm64` target
   later is a new list entry, not a second refactor.
4. **Microsoft Store distribution.** Rejected for this PRD. Avalon distributes
   from its own site on macOS and does the same on Windows; the Store brings a
   separate packaging format (MSIX), review pipeline, and account for no
   distribution problem we currently have.
5. **A Linux client.** Rejected as a product. The existing `linux` stanza in
   `electron-builder.yml` may be exercised as an unshipped development aid
   (the sandbox is Linux and can run the non-darwin code paths under Xvfb),
   but no Linux artifact is signed, published, or offered for download.
6. **Feature parity work beyond the port.** Rejected. No Windows-specific
   features (jump lists, taskbar progress, toast notifications) in v1; the
   scope is the existing product on a second platform, minus the exclusions
   above.

## Product behavior

### Download and install

The `with-avalon.com` download surface offers two platforms: macOS
(Apple silicon) and Windows (x64). The Windows artifact is an NSIS installer
(`Avalon-<version>-win-x64.exe`) built from the existing `win` target
(`oneClick: false`, user-choosable install directory). It installs per-user
with the standard NSIS uninstaller, matching the configuration already checked
in; a per-machine install option is deferred until an IT-managed deployment
asks for it. The installer and the application binaries inside it are
Authenticode-signed.

**SmartScreen is expected early, disclosed, and investigated late.** Since
Microsoft's March 2024 change, no certificate class buys instant trust:
SmartScreen builds reputation on both the file hash and the signing identity.
Early releases are therefore likely to show "Windows protected your PC" while
both accumulate download history — but a consistently used publisher identity
carries reputation across versions, so the warning should fade as releases
accumulate rather than resetting on each one. The download page copy is
conditional ("Windows may warn…"), stated next to the Windows download so the
first-run experience is explained rather than alarming. Once publisher
reputation is established, an unexpected warning on a new release is a signal
to investigate the signing path, not a platform property to normalize.

### Sign-in

Identical contract to macOS: Google authentication opens in the system
browser, passes through `https://with-avalon.com/auth/desktop/`, and returns a
single-use ticket to `avalon://auth/complete`. On Windows the protocol
registration is written to the registry by `setAsDefaultProtocolClient` (and
by the installer), and the callback arrives as a `second-instance` launch
whose argv the main process already scans for the `avalon://` prefix — the
`open-url` event is macOS-only and is not part of the Windows path. The
existing single-instance lock makes the second launch forward its URL to the
running process. This path exists in the code today and has never been
exercised end to end; goal 1 is its acceptance test.

### Windows and chrome

- All three windows (main, Settings, meeting-notes — the last never opens on
  Windows) use the standard Windows title bar (`titleBarStyle: 'default'`).
  Only the main window changes: it currently passes `'hidden'` on non-darwin —
  on Windows that produces a window with **no minimize/maximize/close buttons
  at all** — while the Settings and meeting-notes windows already pass
  `'default'` off macOS, so the fix is one line in the main window's
  constructor. Custom chrome with `titleBarOverlay` caption buttons is
  deferred polish (key design decision 4).
- Windows and taskbar use the existing `resources/icon.png` path already wired
  for non-darwin windows. The macOS selectable app icon set does not appear in
  Settings on Windows (it is Dock-specific and already capability-gated).
- Closing the last window quits the application — the existing
  `window-all-closed` behavior for non-darwin, kept deliberately (non-goal 2).
- The application menu renders through the existing `applicationMenuTemplate`
  platform branch; Settings opens from it (Ctrl+, rather than Command-,).

### What is absent on Windows, and how

- **Meeting notes:** every entry point is hidden — not disabled — on Windows:
  the renderer's meeting-notes surfaces, the meeting-notes window, and the
  meeting-audio permission prompts never appear. (The other macOS entry
  point, the menu bar item's meeting rows, never arises on Windows because
  the tray is not ported — non-goal 2; the application menu has no meeting
  row on any platform.) The capability flag the main
  process already exposes (`NativeSystemAudioController` throws off-darwin;
  `meetingAudioSettingsUrl` returns `undefined`) becomes an explicit
  `supported: false` the renderer consumes, rather than a latent throw.
- **Menu bar / tray and launch-at-login:** the `supported: false` path that
  already exists in `MenuBarController` and `LaunchAtLoginController` — their
  Settings rows render only when the controller reports availability.

### What works unchanged

- **Dictation** uses `getUserMedia` (the standard microphone API) and the
  realtime socket; it is platform-neutral and ships on Windows. The Windows
  microphone-permission flow is verified as part of goal 7.
- **Message export** (Image/PDF) renders through a hidden Chromium window and
  the `avalon-export` scheme, ending in a native save dialog — expected
  platform-neutral, verified before release.
- **Session storage**: `safeStorage` resolves to DPAPI on Windows; the
  Lockdown-mode envelope format is unchanged (see Security and trust model).
- **Theming, drafts, markdown rendering, sockets, REST** — no platform surface.

### Update

The Windows client updates from
`downloads.with-avalon.com/stable/win32/x64` (electron-updater's NSIS path,
`latest.yml` + installer + blockmap), mirroring the macOS
`stable/darwin/arm64` feed. Three single-platform constants become
per-target values: `AVALON_UPDATE_URL` (in
`apps/desktop/scripts/mac-signature-policy.mjs`), `release-lib.mjs`'s
`DEFAULT_RELEASE_PREFIX`, and `MANUAL_UPDATE_URL` (`updater.ts`), the
hard-coded `.dmg` link the update-failure dialog opens — unchanged, the first
failed Windows update would hand the user a DMG. Differential download stays
enabled as on macOS.

**Updates apply silently on Windows.** The updater currently calls
`quitAndInstall(false, true)`; `isSilent: false` is inert on macOS
(Squirrel.Mac always applies silently) but, against this repo's assisted NSIS
target, would put the full installer wizard — welcome page, directory page —
in front of a Windows user on every update. Windows passes `isSilent: true`
instead, matching the macOS feel; the assisted installer with its directory
choice remains the *first-install* experience only. The per-user install
keeps updates free of UAC prompts, and `autoInstallOnAppQuit` stays enabled
(NSIS applies silently on quit).

### Publication

`apps/site/release.config.json` moves from a single-platform object to two
distinct pieces of state, because today's record is doing two jobs at once:

- **One train watermark** — the `{version, commit}` pair `plan-release.mjs`
  reads to decide whether unreleased desktop work exists and what the next
  version is, and that the publisher's advance-the-minor validation checks
  against. This stays **single and global**, advanced by the release that
  builds both platforms, exactly as today. It never rewinds for a trailing
  target, so the planner cannot re-release work already shipped for macOS and
  the publisher's next-version rule is unambiguous.
- **Per-target publication entries** — one per `{platform, arch}` (prefix,
  artifact names, hashes, published flag, published version), which may trail
  the train. The download page and update feeds read these; a delayed Windows
  publication of version N touches only its own entry. The entry schema is
  built on artifact *roles* (a canonical download artifact, an update
  manifest, blockmaps), not on the DMG-named fields the current
  `apps/site/src/release-config.ts` requires and suffix-validates — a Windows
  target's canonical artifact is an `.exe`, and that reshaping, not the list
  itself, is most of rollout phase 2's real cost.

macOS can therefore advance the train to a version whose Windows build is
still in verification, and completing that Windows publication later is an
entry update, not a release. The implementing change migrates every consumer
of the old flat record — the planner, the publisher's validation, and the
site-config check — against the split, with tests for the macOS-at-N /
Windows-at-N-1 state followed by both the next train release and the delayed
Windows publication. The R2 bucket (`avalon-desktop-releases`) gains the
`stable/win32/x64/` prefix; nothing about the macOS object layout moves.

## Impact on the product contract

None of the contract's substance moves: what a work stream is, participation,
agent authority, and the shape of the product are untouched. Two coverage
clauses are affected and should be read against the brief:

- The brief's assumption that the desktop client is macOS-only is retired:
  the client contract now spans two platforms.
- The meeting-notes workflow — recording, Control Tower, and the surfaces
  that drive them — becomes the one product surface with platform-dependent
  availability: absent on Windows, as an explicit product decision (non-goal
  1), not an engineering accident. What meeting notes *are* is unchanged, and
  notes already produced by macOS teammates remain readable wherever
  work-stream content shows them; what Windows lacks is producing them. A
  future PRD that ships any reduced notes experience on Windows (for example
  microphone-only) must argue for it against this decision. If the brief
  enumerates client capabilities, its edit says "macOS only" beside meeting
  notes and cites this PRD.

## Decision log

None yet.

## Key design decisions

1. **Windows x64 only, no arm64 build.** Windows-on-ARM's x64 emulation makes
   a single build cover every Windows machine; arm64 is an optimization for a
   small slice, not coverage. *Rejected alternative:* shipping both from day
   one — doubles the artifact matrix, signing operations, and verification
   surface for no additional reachable user. The plural release-config schema
   is the hedge: adding arm64 later is a list entry.
2. **Azure Artifact Signing (Trusted Signing), not an OV/EV certificate.**
   ~$10/month, no hardware token, native `win.azureSignOptions` support in the
   electron-builder 26 line the repo already pins, and CI authentication via
   environment credentials — the same shape as the existing macOS `CSC_LINK`
   flow. *Rejected alternatives:* an OV certificate ($150–300/yr) is required
   by CA/Browser Forum rules since June 2023 to live on physical HSM hardware,
   which cannot sit in a GitHub secret and would put a human and a USB token
   in every release; an EV certificate ($400+/yr) lost its instant-SmartScreen
   privilege in March 2024 and now buys nothing over OV. **Known risk:**
   Microsoft's identity validation has rejected young companies (its preview
   required three years of business history; the requirement was dropped from
   the docs but rejections still occur — see [research](research.md)).
   Validation is therefore the first task in the build, before any pipeline
   work depends on it; the fallback is an OV certificate with a manual signing
   step, and it would be decided in the decision log, not silently.
3. **One version train, independent per-target publication.** A release tag
   builds both platforms at the same version under the existing
   advance-the-minor policy — no separate Windows versioning scheme, no skew
   in what a version means. But *publication* is per-target, so a Windows
   verification failure never holds a macOS release hostage. *Rejected
   alternative:* atomic two-platform releases — couples the mature pipeline to
   the new one exactly when the new one is least reliable.
4. **Standard Windows title bar in v1.** The main window's current non-darwin
   `titleBarStyle: 'hidden'` would ship a window without caption buttons;
   `'default'` is correct-by-construction on day one. *Rejected alternative:*
   custom chrome via `titleBarOverlay` — closer to the macOS look, but it
   drags in drag-region layout, snap-layout integration, and per-theme caption
   colors; it is reversible polish once the port is stable, and this is the
   cheapest-to-reverse choice.
5. **Meeting-notes surfaces hidden, not disabled-with-explanation.** A dead
   control that every Windows user meets is a standing apology; an absent one
   is a smaller product. The download page and docs state the platform
   difference once, where the decision to install is made. *Rejected
   alternative:* showing the surface disabled with "macOS only" copy —
   permanent UI noise for a capability there is no plan to ship (non-goal 1).
6. **Verification: CI screenshots per PR, a physical Windows machine per
   release, Linux as an unshipped local proxy.** The repository rule that
   every visible change is looked at in a real window gets three Windows
   answers: a `windows-latest` CI job that launches the packaged app and
   screenshots the touched screens (per-PR, one DPI); a founder-owned Windows
   PC for the pre-release pass (fonts, fractional DPI scaling, installer,
   SmartScreen, real sign-in); and the Linux build under the existing Xvfb
   setup as a same-session proxy for the shared non-darwin code paths (title
   bar, window icons, quit-on-close). *Rejected alternative:* relaxing the
   real-window rule for Windows — the platform differences (a real title bar
   where macOS reserves traffic-light space, Segoe UI metrics, 125%/150%
   scaling) land precisely on the code this PRD touches.

## Security and trust model

- **Renderer isolation is untouched.** No IPC surface, CSP, or preload change
  is part of this PRD; the [security model](../../security.md) applies as-is
  on Windows.
- **Session encryption weakens in degree, not in kind.** `safeStorage` on
  Windows is DPAPI with user scope: any process running as the signed-in OS
  user can decrypt, where macOS Keychain gates access per-application. This is
  the platform's standard posture (and the same trust level as the browser
  profiles the session ticket already transits). The Lockdown-mode envelope
  and session-file format are unchanged — the one `safeStorage` call site is
  `apps/desktop/src/main/session-encryption.ts`. `security.md` records the
  per-platform difference in the same change that ships it.
- **Signing-key custody moves to a service.** There is no Windows signing key
  to hold: Azure Artifact Signing keeps keys in its HSM and CI authenticates
  with an Entra service principal whose secrets live as GitHub Actions
  secrets, scoped to the release workflow — the same custody pattern as the
  existing Apple notarization credentials, with less material at rest (a
  revocable credential rather than an exportable key).
- **The update feed's integrity model is unchanged:** HTTPS to
  `downloads.with-avalon.com` plus electron-updater's checksum verification
  against `latest.yml`, now per-target.

## Provider configuration

All in the deployment environment, none in a Worker:

- **Azure:** a subscription, an Artifact Signing account, completed
  organization identity validation for Juno AI Labs Inc. (documents issued
  within 12 months, matching legal details; budget days-to-weeks of calendar
  time — start first, see key design decision 2), a certificate profile, and a
  service principal with signing rights. Its credentials become GitHub Actions
  secrets for the Windows release workflow. **Breaks without it:** unsigned
  builds; SmartScreen hard-blocks and enterprise policy may refuse outright.
- **Cloudflare R2:** no new bucket — `avalon-desktop-releases` gains the
  `stable/win32/x64/` prefix; the `downloads.with-avalon.com` custom domain
  already fronts it.
- **GitHub:** a Windows release workflow (windows runner). No new app or OAuth
  configuration.

## Rollout

Sequenced so each phase is independently useful and the macOS pipeline is
never the experiment:

1. **Azure identity validation** — submitted first, in parallel with
   everything else, because it is the long pole and its failure changes key
   design decision 2.
2. **Plural release schema** — release config, feed prefixes, and the site's
   download surface become per-target lists while still publishing only macOS.
   Ships alone; proves goal 6 before any Windows artifact exists.
3. **Unsigned Windows build in CI** — the NSIS target builds, installs, and
   launches in a `windows-latest` job with screenshot capture; the port issues
   (capability gates, title bar, hidden surfaces) land here behind it.
4. **Signing + update loop** — CI signs via `azureSignOptions`; an installed
   build observably updates itself from a staging prefix to the next version.
5. **Publication** — first signed Windows release verified on the physical
   Windows PC (install, SmartScreen path, sign-in, update from the previous
   build), then published to `stable/win32/x64` and offered on the site.

Rollback at every phase is the site config: a Windows target with
`published: false` (or pinned to the last good version) removes or reverts the
offer without touching macOS. No feature flag — the client itself has no
Windows-conditional behavior to toggle, and the platform's own failure surface
(a build that will not verify, an update that will not apply) is the
monitoring this stage of the company can support.
