# Easter eggs

Rally's hidden extras and the two triggers they are built
from. An egg is a **trigger** plus an **effect**: the trigger is a shared hook,
the effect is the egg's own component, and the component mounts only when the
trigger fires. A new egg picks a trigger and writes an effect; it does not write
its own key or click handling.

It also owns the screen the first egg lives on: the "can't connect" screen that
replaces the app when the organization or account cannot be loaded.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/renderer/lib/easter-eggs.ts` | The triggers: `keySequenceMatcher` and `useKeySequence`, `clickBurstCounter` and `useClickBurst`, and `KONAMI_CODE`. |
| `apps/desktop/src/renderer/components/easter-eggs/konami.tsx` | The Konami code effect, mounted once in `AppShell`. |
| `apps/desktop/src/renderer/components/easter-eggs/about-credits.tsx` | The About card in Settings and the credits behind its version number. `RALLY_CREDITS` is the list of names. |
| `apps/desktop/src/renderer/components/easter-eggs/rally-pong-physics.ts` | Pong's rules as state and one `stepRally` function, with no canvas. |
| `apps/desktop/src/renderer/components/easter-eggs/rally-pong.tsx` | Pong's canvas, input and frame loop. |
| `apps/desktop/src/renderer/App.tsx` (`ServiceSetupState`) | The "can't connect" screen, which opens Pong. |
| `packages/ui/src/styles/app.css` | `avatar-lap` under `[data-konami]`, `.about-credits`, `.rally-pong` and `.service-setup-*`. |

## How it works

### The triggers

- **Key sequence.** `useKeySequence(sequence, onMatch)` listens on `window` and
  feeds each key to a matcher that keeps the last *n* keys and compares them
  with the sequence, so a stray key before the code does not spoil it. Keys
  typed into an input, textarea, select or editable element are ignored, as are
  repeats, keys held with Command, Control or Option, and keys that are part of
  an IME composition. Letters compare case-blind.
- **Click burst.** `useClickBurst(count, windowMs, onBurst)` returns a click
  handler that fires on the `count`th click inside a sliding `windowMs`.

### The eggs

| Egg | Trigger | Effect |
| --- | --- | --- |
| Konami code | ↑ ↑ ↓ ↓ ← → ← → B A anywhere in the shell | Every avatar on screen (people, Rally, Sidekicks) runs a small lap: once round a 6 px circle, upright, then a hop, in 1.2 s. The egg sets `data-konami` on the root, so the stylesheet reaches every avatar without the lists knowing, and lowers it when the laps' animations finish. |
| Credits | Seven clicks on the version in Settings › Application › About within 3 s (it is a button styled as text, so Enter or Space works too) | A "Made by" card under the version. |
| Pong | Space on the "can't connect" screen when no control has focus, or a click on the screen's icon | Pong inside the card. Mouse, arrow keys or W/S move the left paddle; Escape or the icon closes it. The score is returns in the current rally and the best this visit. |

### The "can't connect" screen

`ServiceSetupState` is shown when the organization, the account's onboarding
state, or a workspace activation fails. It says two things:

- **A network failure** (`ApiError` with status 0): "Rally can't connect" and
  "Check your internet connection, then try again." The error's own message
  only restates that, so it sits behind a **Details** button rather than
  opening a dialog on arrival.
- **Any other failure**: "Rally isn't available right now", with the error's
  message as the body, because there the message is the reason (a refused
  sign-in, for example).

Both offer **Sign out** and **Try again**. The screen names no region, endpoint
or configuration file: the person who sees it cannot act on those. It fills the
pane it sits in, the browser's conversation row included
(`apps/browser/src/styles.css`), so its card is centred in the window.

## Invariants

- **An egg never fires while someone is typing.** The key-sequence trigger skips
  text fields; without that, typing "ba" after arrow keys in the composer would
  set off the Konami code. Guard: `easter-eggs.test.ts` ("ignores the same keys
  typed into a text field").
- **An egg is client-only and visual.** No egg calls the API, a tool, or the
  main process, and none stores anything. Hidden code that reaches a server is
  hidden attack surface; one that only draws is not. No automated guard.
- **Pong takes Escape from the window.** Settings closes
  on Escape from a bubble-phase `window` listener installed before Pong mounts
  (`lib/window-escape.ts`). Pong listens in the capture phase so it runs first,
  and calls `preventDefault()`, which that hook honours, so Escape ends the game
  rather than closing the window. Guard: `App.session-gate.test.tsx` ("ends a
  Pong game on Escape before closing the window").
- **Space starts Pong only from the page itself.** When a button has focus,
  Space is that button's; starting a game instead would swallow a Try again.
  No automated guard.
- **An egg costs nothing until found.** Triggers are one listener or one click
  handler; effects mount on demand. The repository forbids dynamic `import()`
  (`rally/no-dynamic-import`), so the effects are in the main bundle, and they
  are kept small for that reason.
- **The Konami lap respects reduced motion.** Under
  `prefers-reduced-motion: reduce` no avatar laps, so the code does nothing.
- **The flag comes down when the laps end.** Left up, an avatar that mounts
  later (a new message, a switched Canvas) would lap on arrival. The egg
  waits on the laps' own animations rather than a timer, so the duration lives
  in the stylesheet alone. Verified visually, no automated guard.

## Boundary

This module owns the triggers, the three effects, and the "can't connect"
screen's copy and layout. It does not own when that screen appears: that is the
session gate in `App.tsx`, described in [`architecture.md`](architecture.md).
The small card a conversation shows while its socket connects is
`connecting-card.tsx`, owned by
[`conversation-surfaces.md`](conversation-surfaces.md), not this screen.

The native macOS About panel (`role: 'about'` in `application-menu.ts`) is
Electron's own and has no egg; the credits live in Settings › Application ›
About instead. That section is desktop-only (Settings hides the Desktop app
group in a browser), so the credits are too. Pong and the Konami lap work on
desktop and web.

## Failure modes and limits

- Without a 2D canvas context, Pong draws nothing but still opens and closes.
- Pong's frame step is capped at 1/30 s, so a window hidden mid-rally resumes
  where it was rather than jumping. A paddle hit is the ball crossing the
  paddle's face during a step, not landing on it, so a fast ball cannot pass
  through a paddle in one step.
- The best Pong score lasts until the screen closes. It is not stored.
- The numbers that tune the eggs (seven clicks in 3 s, ball speed, 5 % speed-up
  per return, Rally's paddle speed) are taste, not limits; change them freely.

## Testing

`pnpm --filter @rally/desktop exec vitest run src/renderer/lib/easter-eggs.test.ts src/renderer/components/easter-eggs src/renderer/App.session-gate.test.tsx`

- `easter-eggs.test.ts` covers the matcher, the burst counter, and the
  text-field rule.
- `rally-pong-physics.test.ts` covers returns, misses, walls and the paddle
  clamp without a canvas.
- jsdom has no canvas and no CSS animations, so Pong's drawing and the lap
  itself are verified in a real window.

## Changelog

### 2026-11-08 — The browser centres the "can't connect" card

**What changed:** In the browser the screen takes the whole conversation row.

**Why:** It is a flex child of that row and shrank to its card, so centring it
centred the card in itself and left it at the window's left edge (v4-F0).

Shipped in juno-ai-labs/avalon#1490.

### 2026-10-23 — Document created, with three eggs and a smaller "can't connect" screen

**What changed:** Added the key-sequence and click-burst triggers, the Konami
code (every avatar runs a small lap), hidden credits in Settings › About, and Pong. Rewrote the "can't connect"
screen: it dropped the region and API endpoint table, the local-development
advice about `.env.local` and `VITE_` keys, and the dialog that opened on
arrival.

**Why:** The old screen showed developer setup advice to everyone, and its
dialog repeated the screen behind it, so reaching Try again took a dismissal
first. Eggs share two triggers rather than each writing its own handler so the
next egg is a component and a line.

**Consequences:** A new egg uses a trigger from `lib/easter-eggs.ts` and stays
client-only and visual. Local-development guidance for a missing API now lives
only in [`dev-environment.md`](dev-environment.md).
