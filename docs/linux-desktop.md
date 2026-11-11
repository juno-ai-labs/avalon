# Linux desktop

Rally ships the same Electron application on macOS arm64 and Linux x64. Linux
uses AppImage and Debian packages, microphone dictation, and the existing
Stable/Faster update controls. The browser remains a separate deployment. The landing page and `/start-fast/`
link directly to `Rally.deb` below the macOS download, labeled Linux (.deb).

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
builds Linux packages and proves renderer/microphone startup independently of
the Mac release. Linux publication waits for both jobs, then downloads that
run's verified artifacts rather than rebuilding them. A Linux failure does not
block Mac shipping. Both platforms use the
existing packaged session key. Local Linux directory builds use the development
key and must never be distributed as releases.

Before launching Electron, the Ubuntu 24.04 build job sets
`kernel.apparmor_restrict_unprivileged_userns=0` on its disposable runner. This
allows Chromium's user-namespace sandbox for the non-root updater fixture and
both packaged smoke tests. Without it, Electron can fall back to an unconfigured
setuid helper and abort with the `chrome-sandbox` ownership/mode error. The
setting lasts for that runner; these checks establish startup with permitted user
namespaces, not compatibility with stock Ubuntu's AppArmor policy.

Linux publishes under `stable/linux/x64/`. The immutable AppImage, Debian package,
optional blockmaps, versioned SHA256SUMS, and versioned release receipt are
verified before mutable feeds move. The receipt binds the commit, manifest, and
artifact hashes. A retry can finish a partial publication only with the same
bytes; differing artifacts are refused even before a release is committed.
Packaging generates SHA256SUMS; verification and publication only read it and
reject missing or changed checksums.

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
Rally's prepared session state and leave the restart action available. Only errors
raised inside the synchronous installer call are installer failures: background
network failures during preparation retain session protection and their normal
retry behavior. Preparation also rechecks the selected version and channel before
installing. Linux
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
  Sandbox acceptance requires a non-root launch.

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

The initial build/CI target is Ubuntu 24.04 x64 with X11. Other distributions and
Wayland are not yet acceptance-tested. Debian dependencies accept either the
standalone `pkexec` package or the older `policykit-1` package; this does not claim
support for Debian 11 or Ubuntu 20.04 without testing their runtime libraries.
AppImages need a user-writable location and FUSE support or extraction mode.
Debian installation needs a desktop privilege agent and package manager.

The AppImage requires permission to create user namespaces. Stock
Ubuntu 24.04 restricts them through AppArmor, so the AppImage can abort with the
`chrome-sandbox` ownership/mode error unless a host AppArmor profile grants
`userns` for the executable or the host otherwise permits those namespaces.
The CI sysctl does not fix that user-facing limitation, so the public landing
pages offer the Debian package. Debian installation runs
electron-builder's AppArmor-profile setup; the extracted-deb smoke does not run
that installation hook. Stock Ubuntu AppImage startup and installed-deb sandbox
setup remain unverified platform acceptance checks.

If Linux publication fails after Mac succeeds, rerun the failed publish job using
the same Actions artifact within its seven-day retention window. Preserve that
bundle before expiry if recovery will take longer. Once any immutable bytes have
been published, rebuilding that version is not a valid recovery: exact bytes must
be restored. Alerting for an uncompleted Linux publication is deferred.

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
feed: corrupt bytes are rejected, then a valid executable is downloaded, replaces
the old fixture, and is launched. Updater regression tests defer preparation to
exercise background failures and channel invalidation before installation.

On Linux with an X11 display:

```bash
pnpm --filter @rally/desktop package:linux:local
# CI or a headless machine with Xvfb:
xvfb-run -a pnpm --filter @rally/desktop package:linux:release
```

The release command requires `RALLY_DESKTOP_SESSION_KEY` from the existing release
environment and builds with `--mode packaged`. Outputs are `release/linux-local`
or `release/linux-release` under `apps/desktop`. Local mode smokes the unpacked
app; release mode smokes only the final AppImage in extraction mode and the
extracted Debian binary. Checks cover the updater marker/origin and real microphone
permission handlers producing nonzero synthetic audio. The smoke accepts an
optional screenshot path when invoked directly.
Real hardware, Wayland, OS privilege prompts and a full installed-version upgrade
remain platform acceptance checks; the synthetic microphone is not those checks.

## Changelog

### 2026-11-11 — Ship Linux through the shared desktop with separate update feeds

**What changed:** Linux x64 AppImage and Debian releases reuse the desktop and
microphone path, with platform-gated native integrations, automatic downloads,
and a Linux download below macOS on the public landing pages.

**Why:** The existing Linux targets were unreachable through the Mac-only guarded
packager, and enabling the updater alone would have pointed Linux at Mac artifacts.

**Considered and rejected:** A separate application would duplicate the product.
Manual-only Linux updates would not meet the requested desktop behavior. Reusing
the Mac publisher unchanged would mix artifact validation and release pointers.
Blocking Mac publication on Linux verification would couple the existing release
to a new build environment; only Linux publication waits for both jobs instead.

**Consequences:** Linux feeds, receipts and locks stay separate while sharing the
release version. Mac native integrations are unavailable until Linux equivalents
exist. Native symbol publishing and archival remain explicitly Mac-specific.
