# Rally motion: look, feel and rules

The house style for Rally's launch films and X ads. Everything here was set by
review on the shipped drafts; each rule says what to do and, where it was a
correction, why. Look at `reference/*.jpg` before reading further: the stills
are the fastest way to get the vibe.

## The vibe in one paragraph

Confident, calm, product-true. Near-black frames, warm off-white type set big
and tight, one volt accent doing the pointing. The product is the hero: real
Channel UI, real wording from the app, people and Rally working side by side.
Motion is quick to start and soft to land (expo-out and springs), never
bouncy-cute. Multiplayer is shown, not claimed: named cursors, several bubbles,
reactions from more than one person.

## Colour

| Token | Value | Use |
|---|---|---|
| `C.bg` | `#111210` | Behind statement text |
| `UI.bg` | `#070707` | App windows, bento background |
| `C.paper` | `#f0efe8` | Type |
| `C.volt` | `#ccff00` | The one accent: the key word, the click, the live thing |
| `C.blue` | `#47c7fc` | Maya's colour |
| `C.orange` | `#ff6337` | Theo's colour |
| `UI.humanBubble` | `#5a5a5a` | Priya's bubble (the app's default human bubble) |

- One volt idea per frame. If two things are volt, one of them is wrong.
- Volt text sits on dark; on volt fills, ink is `#0b0c0a`.
- Glows are faint (`glow(..., .06 to .14)`). The frame should never look neon.

## Type

- **Display**: Inter Tight 800, tracking about -0.04em (`hookCard` does this).
  Headlines 104 to 168 px in a 1080-tall frame. Two or three lines, left aligned
  at x = 72 (square) or 140 (16:9).
- **Captions over UI**: Inter Tight 800, 74 px, two lines, second line volt.
- **UI text**: Inter, about 2.3x the app's sizes so a phone can read it (33 px
  chat text, 23 px bylines). Never smaller than 21 px in a 1080 frame.
- **Labels**: Inter Tight 750, 52 to 64 px on bento tiles.

## Motion

- Ease in with `eoX`/`eo5` (fast start, soft land), move with `eio5`, pop with
  `spring`. Avoid linear except for the slow camera push.
- Statement cards push up out and the next pushes up in (`hookCard`), about
  0.32s. Words strike through with a volt bar (`strike`).
- Motion blur is on by default (5 sub-frames); fast moves look filmic, so let
  the camera whip between beats.
- Anything that should feel alive keeps moving slowly: cursors drift a few
  pixels, the camera pushes 3 to 4 percent while holding.

## Reading time (the rule that matters most for ads)

Most people watch muted on a phone, so the words carry the story.

These floors are the timings of the approved cuts (the examples), not targets:
aim above them.

- Statement card: about 0.25s per word, never under 1.3s on screen.
- Caption over UI: 2.3s or more from its first frame to the next caption's.
- A chat message that matters: 1.8s or more before the next caption arrives.
- The first frame must already be readable: it is the thumbnail when autoplay
  is off. `hookCard({ tin: 0 })` draws the first card fully at t = 0.
- Logo on screen from frame 0 (`brandBug`), then the end card or the final hold.
  Placed top right, the logo carries `rallywith.ai` under it; `brandBug` adds
  it there on its own.
- If the cut runs long, make the film longer rather than squeezing reads. The
  team prefers a 16 to 18s ad that reads to a 15s one that does not.

## Busyness

- One focal point at a time. No HUDs, timecodes or corner marks in ads (that
  was showreel styling, removed in review).
- At most four chat messages visible; let older ones scroll away.
- No typing indicators: they "muddy the story". Messages simply arrive.
- No crowds of cursors in UI scenes. Use one cursor for the person acting.

## Channel UI conventions (match the desktop app)

- Humans on the **right**, in bubbles, in their personal colour, with name and
  a coloured dot above the bubble.
- Rally on the **left**, **no bubble**, with "Rally" above.
- Mention Rally as **@Rally** (never @Sidekick). Mentions render as chips with
  the person's avatar or Rally's mark.
- Rally has a smart classifier: people do **not** need to tag it. Only tag
  @Rally where the story needs it; a follow-up like "Shorter and punchier?" is
  answered without a tag.
- Breakouts start from a message via the hover action **"↳ New breakout"**
  (the app's wording). Show the source message highlighted, then the breakout
  pane with "Started from Rally's message" (or whoever's).
- The private breakout header: lock icon, "Private breakout · Priya, Rally".
- Imported history (Claude or ChatGPT) shows as **grey placeholders**: the
  importer's grey bubbles on the right, the assistant's grey lines on the left
  under its name, fading in top to bottom, then a divider, then live messages.

## Product truth

- Never show a feature Rally does not have. Docs editing was cut for this
  reason. Before writing a claim, grep the app (for example
  `apps/desktop/src/renderer`) for its wording and use that wording.
- "Merge into Main" for bringing a breakout back is our phrasing; the app has
  no merge wording ("Attach to channel" exists for files). Flag it when used.
- The 60-day offer needs two invited teammates (14-day trial otherwise); say so
  in the post text if the film says "60 days".
- No third-party logos. Claude and ChatGPT appear as words only; connectors
  use generic glyphs (`glyph()`).

## The cast

Maya (blue), Theo (orange), Priya (grey bubble, light cursor) and Rally (volt,
mark avatar). Keep them; recurring faces make a series of ads feel like one.

## Sound

Every film has a generated score (`kit/audio-lib.mjs`) locked to the cuts:

- A groove under product scenes (`m.groove`), 120 BPM for chat stories. Pick the
  tempo so scene changes land on downbeats (the bento tour runs 133 BPM so each
  1.8s tile is exactly 4 beats).
- A whoosh under every camera move, a blip when a person posts, a bell when
  Rally speaks, an impact on the drop and on the final landing.
- End on `m.endCard(t)` or a held chord if the film ends on a held frame.
- The sound is a bonus: the film must work muted.

## Formats (X)

| Ratio | Output | Design space | Use |
|---|---|---|---|
| 1:1 | 1200 x 1200 | 1080 x 1080 | Feed ads, most reach on mobile |
| 16:9 | 1920 x 1080 | 1920 x 1080 | Wider showcases (bento tours), expanded views |

60 fps, H.264 high, AAC 320k. `render.mjs` encodes with these settings.
