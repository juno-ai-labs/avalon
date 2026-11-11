# Linux desktop

Rally ships the same Electron application on macOS arm64 and Linux x64. Linux
uses AppImage and Debian packages, microphone dictation, and the existing
Stable/Faster update controls. The browser remains a separate deployment.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/desktop/electron-builder.base.yml`, `apps/desktop/electron-builder.linux.yml` | Linux artifacts and embedded update-feed origin. |
| `apps/desktop/scripts/package-linux.mjs` | Local/release builds, staged verification and publication to the local output directory. |
| `apps/desktop/scripts/verify-linux-release.mjs`, `smoke-linux.mjs` | Final AppImage/extracted Debian verification and packaged renderer startup and real Chromium microphone capture with a synthetic device. |
| `apps/desktop/scripts/linux-release.mjs` | Artifact validation and immutable release/channel publication. |
| `apps/desktop/scripts/publish-linux-release.mjs` | R2 lock, uploads, readback and public CDN hash verification. |
| `apps/desktop/src/main/update-policy.ts`, `updater.ts` | Supported-package detection, downloads, restart and installation failure recovery. |
| `apps/desktop/src/main/system-key-storage.ts` | Linux OS-keystore availability for Lockdown. |

## How it works

Common packaging metadata lives in a platform-neutral base config. Mac and Linux
configs inherit it separately so electron-builder cannot concatenate Mac and Linux
publish providers. The Linux packager checks the emitted `app-update.yml` origin.
Build caches (`*.tsbuildinfo`) are excluded from packages.

The desktop release workflow freezes one version and commit. Its Ubuntu job
builds Linux packages and proves renderer/microphone startup before the Mac job
can publish. After the Mac release succeeds, Linux publication downloads that
run's verified artifacts rather than rebuilding them. Both platforms use the
existing packaged session key. Local Linux directory builds use the development
key and must never be distributed as releases.

Linux publishes under `stable/linux/x64/`. The immutable AppImage, Debian package,
optional blockmaps, versioned SHA256SUMS, and versioned release receipt are
verified before mutable feeds move. The receipt binds the commit, manifest, and
artifact hashes. A retry can finish a partial publication only with the same
bytes; differing artifacts are refused even before a release is committed.

`latest-linux.yml` and `faster-linux.yml` follow each release. `stable-linux.yml`
uses the same rolling-day promotion policy as Mac. The scheduled promoter visits
each platform separately under its own R2 lock. `Rally.AppImage` and `Rally.deb`
are the latest manual recovery downloads. No Linux pointer is written into the
Mac-only site release record, which remains the version planner's authority.

electron-updater chooses AppImageUpdater for an AppImage and DebUpdater from
electron-builder's installed `resources/package-type` marker. Both check and
download automatically. AppImage updates can install on quit or explicit restart;
Debian updates install only on explicit restart because replacing the system
package may prompt for administrator authorization. Installation errors restore
Rally's prepared session state and leave the restart action available. Linux
unpacked directories and unsupported architectures do not contact an update feed.

Microphone dictation uses the existing `getUserMedia`/AudioWorklet/transcription
path. The trusted main renderer may capture audio; other windows, embedded sites,
video and display capture remain denied. No Linux native audio addon is required.

## Invariants

- Mac and Linux update origins are separate. A Linux client must never receive
  a DMG, ZIP or another architecture's package. The Linux artifact validator and
  update-policy tests guard package selection.
- No feed references an unverified artifact. Publication tests exercise CDN
  failure before feed publication, immutable retries, and rollback refusal.
- Microphone permission remains restricted to the trusted main renderer.
  `media-permission.test.ts` and the packaged microphone smoke guard this.
- Linux `basic_text` and unknown safeStorage backends are not OS keystores.
  `system-key-storage.test.ts` guards Lockdown availability and encryption.
- Shipped windows keep Chromium sandboxing enabled. The smoke's root-only
  `--no-sandbox` exception belongs to an isolated test launch, never the package.

## Boundary

Canvases, Sidekicks, Activity, artifacts and embedded browsing use the shared
application. System-audio capture, APNs notifications, Mac menu-bar/background
operation, launch at login, selectable Dock icons and Mac text services remain
unavailable on Linux. The existing availability flags suppress their settings.
Closing the last Linux window quits Rally; server-side Sidekicks continue.

Linux transport security is HTTPS plus electron-updater's manifest SHA-512
verification. It does not claim Apple's code-signing/notarization guarantees.
The release credentials and pinned origin are therefore part of the Linux update
trust boundary. Renderer IPC cannot supply a feed URL or package path.

## Failure modes and limits

Only Linux x64 is packaged initially. An AppImage must reside somewhere its user
can replace it; AppImage execution also requires the distribution's FUSE support
or its supported extraction mode. Debian update installation requires a working
desktop privilege agent and package manager. Permission refusal restores the
running application instead of leaving it prepared to quit.

The existing retention Worker lists only `stable/darwin/arm64/`; it cannot delete
Linux releases. Linux artifacts are retained until a Linux-aware archival policy
is implemented. Native-symbol publication is still Mac-specific; this change
does not claim Linux native crash symbolication. These do not block installs or
updates, but must be addressed before treating Linux operations as Mac parity.

## Testing

Run the desktop updater, update-policy, system-key-storage, media-permission and
realtime-dictation tests, plus `pnpm --filter @rally/desktop test:release`.
Repository lint and typecheck apply unchanged. `test:linux-updater`, run under
a Linux display, exercises the real AppImageUpdater against an isolated loopback
feed: corrupt bytes are rejected, then a valid executable payload is downloaded,
replaces the old fixture, and is launched. This is an updater lifecycle fixture,
not a claim that a FUSE mount or Debian privilege prompt was exercised.

On Linux with an X11 display:

```bash
pnpm --filter @rally/desktop package:linux:local
# CI or a headless machine with Xvfb:
xvfb-run -a pnpm --filter @rally/desktop package:linux:release
```

The release command requires `RALLY_DESKTOP_SESSION_KEY` from the existing release
environment and builds with `--mode packaged`. Outputs are `release/linux-local`
or `release/linux-release` under `apps/desktop`. The smoke accepts an optional
screenshot path when invoked directly. It proves capture through Electron's real
permission handlers and requires nonzero audio samples, not just a live process.
The release verifier also launches the final AppImage in extraction mode and the
binary extracted from the final Debian package, checking its updater marker and
embedded feed.
Real hardware, Wayland, OS privilege prompts and a full installed-version upgrade
remain platform acceptance checks; the synthetic microphone is not those checks.

## Changelog

### 2026-11-11 — Ship Linux through the shared desktop with separate update feeds

**What changed:** Linux x64 AppImage and Debian releases reuse the desktop and
microphone path, with platform-gated native integrations and automatic downloads.

**Why:** The existing Linux targets were unreachable through the Mac-only guarded
packager, and enabling the updater alone would have pointed Linux at Mac artifacts.

**Considered and rejected:** A separate application would duplicate the product.
Manual-only Linux updates would not meet the requested desktop behavior. Reusing
the Mac publisher unchanged would mix artifact validation and release pointers.

**Consequences:** Linux feeds, receipts and locks stay separate while sharing the
release version. Mac native integrations are unavailable until Linux equivalents
exist. Native symbol publishing and archival remain explicitly Mac-specific.
