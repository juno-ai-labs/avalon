# Inline resource citations — syntax prior art

> Created 2026-08-27. Companion to [`prd.md`](prd.md): the investigation
> behind the syntax recommendation. Findings dated where they come from
> outside the repository.

## The in-house precedent: mention chips

The strongest evidence is already shipping. Rally's markdown renderer
recognizes internal schemes inside ordinary link syntax and turns them
into chips:

- The canonical person mention is `[@Display Name](person:<uuid>)` —
  minted server-side, validated against a strict pattern, and taught to
  the model in the standing response-formatting policy.
- The renderer's single `react-markdown` mount passes `person:` and
  `connector:` hrefs through `urlTransform` untouched and dispatches on
  scheme in its `a` override; recognized schemes become chips, anything
  unrecognized degrades (an unknown scheme is emptied by the default
  transform and renders as a dead anchor carrying the label text — the
  retired legacy mention scheme has a test pinning exactly this).
- Mention chips are deliberately never navigable; that is a recorded
  renderer invariant about identity tokens, not a property of the
  mechanism. Ordinary `https` links are real anchors whose clicks the
  main process intercepts and routes to the system browser through an
  allowlist.

Everything the citations PRD needs — scheme pass-through, override
dispatch, graceful degradation, model-taught emission — has a working
instance. Citations add one scheme and two presentations.

## GitHub-flavored footnotes

`[^1]` references with `[^1]: definition` blocks are GFM syntax,
documented in GitHub's own writing guide, and heavily present in
training data. The repository's pinned `remark-gfm` (4.0.1 at the time
of writing) parses them by default with no option needed: today they
render as an unstyled superscript link plus a trailing list section with
a visually hidden heading, and their fragment anchors are dead under the
desktop's navigation denial. So the grounding mode is a styling-and-hook
change over parsing that already works — not a parser.

## OpenAI's citation-formatting guidance

Read 2026-08-27 from the OpenAI developer guide on citation formatting.
Their recommended mechanism is structured markers with private-use
Unicode delimiters (U+E200 / U+E202 / U+E201) around source
identifiers like `turn0url1`, with optional line-range locators, and a
post-processing pipeline that resolves markers against tool results. Two
takeaways transfer; the mechanism does not:

- **"Familiar citation patterns"** are recommended explicitly because
  "custom or unfamiliar formats increase cognitive load on the model" —
  the principle behind choosing markdown links and GFM footnotes here.
- **Placement guidance** (citations after punctuation, never inside
  markdown formatting) transfers directly into the prompt policy.
- The invisible-delimiter mechanism itself exists for platforms that
  post-process text they do not render. Rally owns its renderer, and
  invisible bytes in stored content survive copy/paste into places that
  cannot interpret them — rejected in the PRD (non-goal 2).

## Link syntax versus image syntax for the internal scheme

The discussion that commissioned this PRD proposed two candidates:
`![label](resource://<uuid>)` (image syntax, special protocol) and a
more sophisticated citation block. The PRD recommends plain link syntax
`[Title](resource:<uuid>)` instead, for reasons recorded here:

- **Semantics.** A link references; an image embeds. Screen readers,
  markdown tooling, and models all treat them that way. A citation is a
  reference. Image syntax is worth *reserving* for a future true embed
  ("render this resource inline"), which keeps the vocabulary coherent
  rather than spending it on chips now.
- **Degradation.** An unrenderable link shows its label text; an
  unrenderable image shows a broken-image placeholder or nothing. Every
  surface outside the desktop renderer favors the link.
- **Consistency.** The house scheme style is bare (`person:`, no `//`);
  models already emit that shape in Rally.

A bespoke citation block was rejected on the familiarity principle: it
is out-of-distribution syntax with no degradation story.

**Superseded in review (2026-08-27):** the PRD now adopts *both* forms
with distinct renderings — link → inline chip, image → embedded block
card — with guidance recommending the embed form for announcing
generated artifacts, on the argument that models place image syntax
block-level by training, so the card never splits a sentence. The
semantics objection dissolved (the card is the first true embed); the
degradation objection stands and is carried as an accepted cost in the
PRD's key design decision 2. The scheme also moved to true URL style
(`resource://`). This file records the original analysis as prior art;
`prd.md` is authoritative.

## Also consulted

- A reverse-engineering write-up of ChatGPT's and Claude's inline
  citation implementations (Lukas Flaig, Medium) was part of the
  commissioning discussion; it could not be fetched for this file
  (access restricted) and no claims here rest on it.
