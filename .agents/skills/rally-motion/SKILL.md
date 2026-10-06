---
name: rally-motion
description: Make Rally launch films and X (Twitter) video ads in the house motion style: dark frames, big tight type, volt accent, real Channel UI with Maya, Theo, Priya and Rally, a generated score, rendered to MP4. Use when someone asks for a Rally promo, ad, launch or feature video, a new draft of one, or a variant of an existing cut.
user-invocable: true
---

# Rally motion films

Every film is one HTML page that draws any instant `t` onto a canvas, plus a
score script. `kit/render.mjs` steps through time in headless Chromium, pipes
frames to ffmpeg and muxes the score. Nothing is hand-animated in a timeline
tool, so a change is an edit and a re-render.

Read `STYLE.md` and look at `reference/*.jpg` before you design anything. The
style rules there came from review; breaking one is how a draft gets sent back.

## Files

| Path | What it is |
|---|---|
| `STYLE.md` | Look, timing, chat-UI conventions, product-truth rules, formats |
| `reference/*.jpg` | Stills from approved cuts: hook cards, strike-swap, breakout, imported history, reactions, end card, bento |
| `kit/engine.js` | `stage()`, `start()`, easing (`eoX`, `eio5`, `spring`), `kf` keyframes, text helpers, motion blur, grain |
| `kit/brand.js` | Colours `C`/`UI`, fonts `F`, cast `P`, `drawMark`, `cursor`, `avatar`, icons, `brandBug` |
| `kit/components.js` | `hookCard`, `strike`, `captions`, `channelWindow`, `chatStack`, `actionPill`, `pillBeside`, `reactionChip`, `endCard` |
| `kit/bento.js` | `bentoLayout`, `bentoTour` camera, `drawBento`, `BENTO_TILES` (a painter for each of 11 features) |
| `kit/audio-lib.mjs` | `createMix(seconds)`: kick, clap, hat, impact, whoosh, riser, blip, bell, pad, stab, `groove`, `endCard` |
| `kit/render.mjs` | `--preview t1,t2,...` contact sheet, or `--video --score score.mjs --out film.mp4` |
| `kit/new.mjs` | Copies an example to a new folder with its kit paths fixed |
| `examples/import-ad-square/` | 17.5s 1:1 ad: three statement cards with a strike-swap and a real menu item, imported history, live chat, end card |
| `examples/bento-tour-16x9/` | 30s 16:9 feature tour of a bento grid, ending on the whole grid |

## Workflow

1. **Get the brief straight.** Format (1:1 or 16:9), length, the lines of copy,
   which features. If copy has a typo, fix it and say so; if it uses
   "multi-player" with a hyphen, keep what they wrote.
2. **Check every product claim.** Grep the app for the feature and its wording
   (`grep -rn "New breakout" apps/desktop/src/renderer`). Use the app's words.
   If something is not in the product, do not show it; if the person insists on
   wording the app lacks, use it and flag it.
3. **Write a timing table first**: one row per beat with start time, what is on
   screen, the words, and how long they hold. Check reads against `STYLE.md`
   ("Reading time"). Lengthen the film before you shorten a read.
4. **Start from the closest example**, in your scratchpad (never the repo):
   `node kit/new.mjs import-ad-square <scratchpad>/my-ad` copies it and points
   its kit paths here. Edit the `T` timeline, copy, `MSGS`, `CAPS` or `TOUR`.
5. **Preview before rendering.** Pick 8 to 16 instants across every beat:
   `node kit/render.mjs my-ad/scene.html --preview 0,1.5,3,4.5,... --out sheet.png`
   then read the sheet image. Fix overlaps, clipping and text near edges. Also
   check one instant mid-transition: that is where leaks and overlaps show.
6. **Score it.** Copy the example's `score.mjs`, move every cue to your
   timeline. Put a whoosh under each move, a blip per message, a bell when
   Rally speaks, an impact on drops.
7. **Render**: `node kit/render.mjs my-ad/scene.html --video --score my-ad/score.mjs --out my-ad/film.mp4`.
   A 15s 1:1 film takes about 2.5 minutes; 30s at 16:9 about 6. Run long
   renders in the background. Then read `film-check.png` (one frame per second)
   before you hand it over. You cannot hear the score, so say so.
8. **Deliver** the MP4 from the scratchpad, with a short table of what plays
   when, and list any wording you chose or claims you are unsure of.

## Building blocks

```js
stage({ w: 1080, h: 1080, outW: 1200, duration: 15 });   // 1:1 for X; 16:9: w 1920, h 1080, outW 1920
start((ctx, t) => {                                        // draw instant t (seconds); keep it pure
  const r = hookCard(ctx, t, { tin: 0, tout: 1.7, lines: [['Work isn’t', C.paper], ['single-player.', C.paper]] });
  if (r) r.done();                                          // always close the card's clip
  captions(ctx, t, [{ t0: 3.7, lines: [[['Anyone can ask.', C.paper]], [['Everyone sees it.', C.volt]]] }], { end: 11 });
  channelWindow(ctx, APP, { title: 'launch-day', people: [P.maya, P.theo, P.priya, P.rally] });
  chatStack(ctx, APP, MSGS, t);                             // bottom-anchored, scrolls by itself
  if (t >= 11.3) endCard(ctx, t - 11.3);                     // needs about 3.5s
  brandBug(ctx);                                            // logo from frame 0
});
```

Chat messages (`chatStack`): `{ t, who: 'maya'|'theo'|'priya', s, mention? }`,
`{ t, who: 'rally', s, stream?, big?, segments?, react?, highlight? }`,
`{ t, who: 'history', person, agent, items }`, `{ t, who: 'divider', label }`.

A breakout (see `reference/03` and `04`): highlight Rally's message with
`highlight: t => ...`, place `actionPill(ctx, pillBeside(ctx, APP, msg), 'New breakout', { branch: true, pressedAt, t })`,
then slide a second `channelWindow(..., { lock: true, sub: 'Private breakout · Priya, Rally' })`
in from the right over the dimmed Channel, with its own `chatStack`.

Bento: `bentoLayout({ cols, rows, tiles: { id: [col, row, w, h] } })`, then
`bentoTour(layout, [[id, t0], ...], { dive, pull, end })` returns `camAt(t)`;
draw with `drawBento(ctx, t, camAt(t), layout)`. Tile ids with painters:
`multi, breakouts, spaces, claude, chatgpt, sidekicks, triggered, computer,
artifacts, live, connectors`. New features get a painter `(ctx, tile, lt)` in
the same shape, ending with `tileLabel(ctx, tile, ['Name'], 56, lt)`.

## Gotchas

- **Every `ctx.save()` needs its `restore()`.** A leak moves everything drawn
  after it; it once dragged the logo 80 px down during a slide-in. The engine
  logs `canvas state leaked out of frame()`, and render.mjs prints it. Treat
  that line as a failure.
- Hold a component's early `return` until after its `restore()`.
- A scene must be a pure function of `t`: no `Date.now()`, no state carried
  between frames. Random values come from `rng(seed)`.
- Fonts load before `window.ready`; text measured before `start()` is wrong.
- Keep important things 72 px or more from the edges.
- Large tiles shrink under the camera: if a tile's text reads small in the
  preview, enlarge it in the painter rather than zooming the camera.
- Do not install Playwright or add browser drivers to the repo; it is on the
  sandbox image. render.mjs finds the global install.
- Renders and previews belong in the scratchpad, never committed.
