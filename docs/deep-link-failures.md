# Deep-link failures

What a person sees when Rally is handed a link it will not follow. A deep link is
the operating system asking the application to go somewhere — a sign-in callback,
a connector completion, a note, an invitation — and every one of those can be
refused. This document covers where that refusal is shown and why it is shown in
a window of its own rather than inside the application. Read it before changing
how a refused link is surfaced, before adding a message to the deep-link handler,
or before adding another window to the desktop client.

It does **not** cover deep-link parsing, the URL scheme, or what a *successful*
link does; [`domain-migration.md`](domain-migration.md) owns the scheme.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/renderer/lib/app-session.tsx` | Decides that a link is refused and writes the message. `reportDeepLinkFailure` is the single place that chooses where a message goes. |
| `apps/desktop/src/main/index.ts` | Owns the window: `createDeepLinkErrorWindow`, the `deepLinkErrorMessage` it holds, the three `deep-link-error:*` IPC handlers, and `assertDeepLinkErrorIpcSender`. |
| `apps/desktop/src/renderer/screens/deep-link-error.tsx` | The whole contents of that window. |
| `apps/desktop/src/renderer/App.tsx` | Routes `?surface=deep-link-error`, above the session gate. |
| `apps/desktop/src/preload/index.ts` | The four bridge methods and the `deep-link-error:changed` channel. |
| `apps/desktop/src/common/desktop.ts` | The bridge contract those four methods satisfy. |

## How it works

### Why the message leaves the renderer

Deep links are delivered to a renderer, and which renderer depends on the link.
A connector completion goes to **both** the main window and the settings window,
and `sendDeepLink` then raises and focuses *settings* — it is the window that
started the OAuth run, so it is the one that should be in front when the provider
redirect lands.

That makes any in-renderer treatment of a failure wrong in two different ways at
once. The settings window renders `WorkspaceSettingsScreen` and no application
shell, so a message drawn there has nowhere to go. The main window has a shell,
but it is behind the settings window nobody has looked away from. Both halves of
a connector failure therefore land somewhere invisible.

So once there is a workspace, the message leaves the renderer entirely:
`reportDeepLinkFailure` calls `bridge.showDeepLinkError`, and main opens a small
always-on-top window in front of whichever window is focused.

### Signed out is different, and stays inline

With no session at all there is exactly one window, and the sign-in screen is
already showing the message under the buttons that answer it — "Sign in before
opening this note." is next to the sign-in button. A second window over the top
of the remedy helps nobody, so `reportDeepLinkFailure` falls through to
`setDeepLinkError`, which `SignInScreen` renders as an `InlineError`.

The test is `session === null`, and not "has no workspace", because `SignInScreen`
is the only surface that reads that state and `SessionGate` reaches it only when
there is no session. A person who has signed in but not joined a workspace is on
`WorkspaceOnboardingGate`, which renders `RegionOnboarding` or
`InvitationOnboarding` — neither of which reads `deepLinkError`. Routing those
failures inline would file them where nothing draws them, so they take the window
like every other signed-in failure.

The session-refresh failure in `app-session.tsx` ("Your session expired.") calls
`setDeepLinkError` directly rather than going through the reporter. It is not a
deep link, and it clears the session in the same breath, so the sign-in screen it
lands on is the correct surface by the same argument.

### The window

`createDeepLinkErrorWindow` is a singleton. Main holds the current message in
`deepLinkErrorMessage`; the window reads it once on mount through
`deep-link-error:get` and subscribes to `deep-link-error:changed` for any that
arrive after. That split exists because the window is created *with* a message —
the renderer does not exist yet to be told about the first one — and can then
outlive it.

`App.tsx` routes this surface **above** the session gate, unlike `settings` and
`meeting`, which sit below the workspace query. The failure window needs no
session, no workspace and no socket, and the cases where it matters most are
exactly the ones where none of the three is available: a link that arrives while
the application is still booting, or one refused because the session has expired.

Subscribing happens before the read, and a pushed message wins over one still in
flight: the read is a snapshot taken when main served the invoke, so a failure
arriving before it settles is newer than what it will return.

If that first `loadRenderer` rejects, the window is disposed and the singleton
cleared before the error propagates. A window that never loaded is worse left in
place than absent — see **Invariants**.

Closing the window — the Continue button, or the title bar — is the
acknowledgement, and `closed` clears `deepLinkErrorMessage`.

## Invariants

- **Only the failure window may read or dismiss the message.**
  `assertDeepLinkErrorIpcSender` is narrower than `assertTrustedIpcSender` for a
  reason: `deep-link-error:dismiss` closes a window, and any other renderer
  calling it would discard a message the person had not read yet.
- **The message is cleared when the window closes.** A message that outlives its
  window is handed to the next failure's window as though it had just happened,
  attributing the window to a link the person already dealt with.
- **The window is a singleton and re-showing it replaces the text.** Both
  renderers report the same connector completion, so a second report is the
  normal case, not an error. Opening a second window per report would stack two
  dialogs for one failure.
- **`reportDeepLinkFailure` is the only route from the deep-link handler to a
  message.** A new `setDeepLinkError('…')` added inside `handleDeepLink` compiles
  and does nothing visible for a signed-in person, because no surface renders
  that state any more.
- **A window whose renderer never loaded is disposed, not kept.** Left in the
  singleton it is worse than no window at all: the next failure takes the
  re-show branch, raises a blank window with no Continue button, and *resolves*
  — so the reporter reads the notice as delivered and its own fallback does not
  run either. One failed load would otherwise disable every later notice for the
  lifetime of the process.
- **A pushed message outranks the mount-time read.** The read returns whatever
  main held when the invoke was served; letting a late one land would restore an
  older link's message and leave it there, blaming the window on a link the
  person has already dealt with.
- **The `closed` handler clears only if the window is still the current one.** A
  disposed window's `closed` arrives after the singleton has moved on, and
  clearing then would take the live window's message with it.
- **The window must stay dismissible whatever the message says.** It cannot be
  resized and does not scroll as a page, so the message scrolls inside it and the
  Continue row is anchored. A message long enough to push the button past the
  bottom edge leaves no way to acknowledge it at all — see the changelog.

## Boundary

This module owns *where a refused deep link is shown* and nothing else. It does
not decide what is refused or what the message says: `handleDeepLink` in
`app-session.tsx` does, and every message is authored there.

It exposes four bridge methods. `showDeepLinkError` is for any trusted renderer;
the other three are for the failure window alone. Main is the only owner of the
window and of the message while it is displayed.

It deliberately does not touch the onboarding inline error, the settings window's
own error surfaces, or the application shell — the shell renders nothing for deep
links at all. The desktop trust boundary that admits these IPC calls is owned by
[`security.md`](security.md#electron).

## Failure modes and limits

- **Main refuses or cannot open the window.** `showDeepLinkError` rejects — the
  message failed validation, or the window could not be built — and the reporter
  falls back to `setDeepLinkError` *and* reports the rejection through
  `reportJavascriptError`. For a signed-in person that state is not rendered
  anywhere, so the notice is still lost to them; the report is what stops it
  being lost to us as well, because the symptom is a surface that never appears
  and nothing else would record it. This is the accepted cost of taking the
  message out of the shell.
- **A message arrives while the window is already open.** It replaces the text in
  place and re-focuses. The person may never see the first message. That is
  deliberate — both are the same failure reported twice in the normal case.
- **A long message.** `DEEP_LINK_ERROR_MESSAGE_LIMIT` in `main/index.ts` bounds
  it, and is currently **open** (`Number.POSITIVE_INFINITY`, enforcing nothing)
  pending a number from the team — see
  [`adding-security-defensive-and-other-limits.md`](adding-security-defensive-and-other-limits.md).
  Until it is set, an arbitrarily long message is accepted and scrolls.
- **Link-derived text reaches the window.** The sign-in branch interpolates the
  link's own `error` parameter with no length or charset check at its source, so
  text chosen by whoever crafted the `rally://` URL can be displayed in an
  always-on-top window under Rally's name. The limit above is the backstop; the
  fix is bounding it where it is built.

## Testing

- `apps/desktop/src/renderer/screens/deep-link-error.test.tsx` covers the window's
  contents: the mount-time read, replacement while open, Continue, and the
  self-close fallback. The bridge is mocked at `../lib/platform`; the mock keeps
  the `onDeepLinkErrorChanged` listener in `state.changed` so a test can push a
  later message.
- `apps/desktop/src/renderer/lib/app-session.test.tsx` covers the routing.
  `lastDeepLinkFailure()` reads what was handed to the window; signed-in failures
  are asserted there and signed-out ones on the `deep-link-error` output. Getting
  those two the wrong way round is the trap — a signed-in assertion against the
  inline output passes only while the routing is broken.
- Run both with `pnpm --filter @rally/desktop test`.
- **The window's own lifecycle is not unit-covered.** `main/index.ts` has no test
  harness — the extracted main-process modules beside it do, but the entry point
  does not — so disposal-on-failed-load is verified by driving the real
  application, per the procedure below.
- **Layout is not covered by either.** jsdom does not lay out, so the anchored
  Continue row can only be checked in a real window — run the client per
  [`dev-environment.md`](dev-environment.md#driving-and-screenshotting-it), call
  `window.rally.showDeepLinkError('…')` from the main window with a long message,
  and confirm the button is still on screen.

## Changelog

### 2026-08-29 — A refused deep link opens its own window instead of a banner in the shell

**What changed:** The warning banner at the top of the application shell is gone.
Once there is a workspace, a refused deep link opens a small always-on-top window
containing the message and a single Continue button. Signed out, the message
still renders inline on the sign-in screen.

**Why:** The banner could not work for the failure it most needed to report. A
connector completion link is delivered to the settings window, which raises and
focuses itself — and settings renders no application shell, so the banner was not
there to draw. The main window did have one, but it was behind the settings
window the person was looking at. So an invalid connector completion produced no
visible message anywhere. Its legibility was the presenting complaint — pale
warning wash, 11px, at the top of a window — but relocating it inside the shell
would have fixed only the case that was already visible.

**Considered and rejected:** Rendering the same dialog inside whichever renderer
received the link, so settings would show its own. That is a smaller change and
it does fix the connector case, but it leaves every surface needing to mount the
dialog to be correct, and it still cannot show anything for a link refused while
the application is booting or after the session has expired — neither has a
renderer far enough along to draw one. A window above the session gate has no
such dependency. Also rejected: Electron's native `showMessageBox`, because the
copy is Rally's own and a native box on Linux is drawn by whichever toolkit
happens to be installed.

**Consequences:** There is now a fourth desktop window, and it is in
`rallyWindows()` and the trusted-IPC set. Anything that enumerates windows must
tolerate one that can appear without a session. The message travels over IPC as a
string, and one of the messages interpolates the link's own `error` parameter, so
untrusted text can reach an always-on-top window — `DEEP_LINK_ERROR_MESSAGE_LIMIT`
is the backstop and is open pending a number. The window cannot be resized, so
any future message that is longer than the ones here today must keep the Continue
row anchored; an early revision of this change did not, and a long message pushed
the only way to dismiss the window off the bottom edge of a window that can
neither scroll nor resize. Finally, `setDeepLinkError` inside `handleDeepLink` no
longer reaches a signed-in person — new failures there must go through
`reportDeepLinkFailure`. Three defects review found before this landed are worth
keeping in mind when changing it: a window whose renderer failed to load must be
disposed rather than left in the singleton, the mount-time read must not be
allowed to overwrite a newer pushed message, and "signed out" here means no
session rather than no workspace. Each is stated as an invariant above because
each is invisible until the rare path runs.
