# Inline resource citations

> Created 2026-08-27.
>
> The model cites what it used and what it made, inline: a
> markdown-compatible citation protocol that the shared renderer turns
> into clickable chips for work-stream resources and numbered footnotes
> with popovers for grounding. No new message type — citations are
> content, carried in ordinary message text through the one markdown
> renderer, the way mention chips already are. Companion:
> [state](state.md), [research](research.md) — the syntax prior art.
> Supersedes the card-and-pane scope of the combined work-stream
> artifacts PRD, which was not merged; its folder and protocol research
> remain readable on
> [PR #334](https://github.com/juno-ai-labs/avalon/pull/334).
> Siblings:
> [terminal artifact generation](../2026-08-27_terminal-artifact-generation/prd.md)
> (whose published documents these citations make reachable from chat),
> [resource versioning](../2026-08-27_resource-versioning/prd.md).
> Subsystem references:
> [markdown rendering](../../markdown-rendering.md),
> [model-text normalization](../../model-text-normalization.md),
> [security](../../security.md). Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

When Rally's answer rests on something — a document it just published, an
attached PDF it read, a web page it fetched — the answer says so inline,
and the reference is a live affordance rather than prose. Two
presentation modes, one protocol:

1. **Chip and embed — two syntaxes, two renderings.** Link syntax
   (`[Title](resource://<id>)`) renders as an inline chip carrying the
   resource's title; image syntax (`![Title](resource://<id>)`) renders
   as an embedded block card. Guidance recommends the embed style for
   announcing generated artifacts — models place image syntax on its own
   line by training, the way they treat actual images, so the card never
   splits a sentence — and the chip for passing references inside prose.
   Clicking either opens the resource in the right rail, whose detail
   view gains a readable content preview (today it is metadata only).
2. **Footnote syntax, floater presentation.** Grounding and research
   answers cite sources in standard GFM footnote syntax, but Rally's
   renderer turns each reference into an inline floating pill — a
   numbered marker after the punctuation with a hover popover naming
   the source and offering to open it — and renders no source list at
   the bottom, so citations cost no vertical space. Internal sources
   open in the right rail; external sources open in the browser; outside
   Rally the same markdown degrades to classic footnotes.

The whole feature is a syntax convention plus a renderer hook: the model
emits ordinary markdown link, image, and footnote syntax with a
`resource://` scheme for internal targets, and the single shared
markdown renderer — which already hijacks link syntax to render mention
chips — dispatches on the scheme and the syntax form. No wire change, no schema change, no new tables. The prompt
guidance that steers emission ships server-side and retunes by deploy;
the renderer branch ships once in the desktop.

## Motivation

Two pains, one proven mechanism.

The first pain is the terminal-generation sibling's seam: it publishes
documents as resources, but the chat can only *talk about* them. The
announcement is prose, the affordance is off in the rail, and a
collaborator scanning the transcript has nothing to click at the moment
the document is mentioned. The superseded PRD solved this with a new
message type and a card — a wire change, schema branches on every client
surface, and version-skew machinery, all to render a reference. A
reference is content, not message structure.

The second pain is grounding. Rally's answers are routinely derived from
attached sources — the PDF, the meeting transcript, the fetched page —
and nothing in the answer shows which claim leans on which source. For a
multiplayer surface where collaborators act on the agent's answers, "go
check for yourself" currently means re-reading everything.

The proven mechanism is already in the codebase: mention chips. The
renderer's link override recognizes internal schemes (`person:`,
`connector:`) inside ordinary markdown links, and models emit that
syntax reliably in production today — evidence that a bracketed-link
protocol with a custom scheme is squarely inside what models do well.
Industry guidance agrees: OpenAI's citation-formatting guide recommends
"familiar citation patterns" because unfamiliar formats increase model
load ([research](research.md)); markdown links and GitHub-style
footnotes are among the most familiar reference syntaxes in training
data.

## Goals

1. One citation protocol, entirely markdown-compatible, that a model
   emits reliably from prompt guidance alone: link and image syntax with
   a `resource://` scheme for internal targets, ordinary URLs for
   external ones, GFM footnote syntax for the grounding mode.
2. Link form renders as an inline chip (title, resource-kind icon);
   image form renders as an embedded block card; clicking either opens
   that resource's detail in the right rail — and that detail gains a
   readable content preview of the resource, rendered through the shared
   renderer, since today it shows metadata only.
3. A grounding citation renders as a numbered superscript after the text
   it supports, with a hover/focus popover naming the source; open goes
   to the rail for internal sources and to the system browser for
   external ones.
4. Degradation is graceful everywhere: an unknown or malformed target
   renders as the citation's plain label text; a footnote whose
   definition is missing renders as ordinary text; and the two
   Rally-owned surfaces that render markdown outside the desktop —
   outbound email and Slack delivery — actively rewrite citations to
   readable text before sending, never leaking raw syntax.
5. Emission guidance is standing-prompt policy — which things to cite,
   where numbers go, never fabricating identifiers — tunable by API
   deploy with nothing for the desktop to know.
6. Citations work wherever the shared renderer runs, including inside
   published documents themselves when previewed.

## Non-goals

1. **A new message type or structured citation metadata on the wire.**
   Rejected. Citations are message content; the renderer is the whole
   delivery mechanism. Structured annotation channels (the
   OpenAI-Responses style) exist for platforms that post-process text
   they do not render; Rally owns its renderer.
2. **Invisible-delimiter citation encodings.** Rejected. Unicode
   private-use markers survive copy/paste into places that cannot render
   them, corrupt stored content with invisible bytes, and are
   out-of-distribution syntax — the opposite of the familiarity this
   protocol optimizes for ([research](research.md)).
3. **Span- or line-level locators.** Deferred. V1 cites a resource, not a
   range within it; locator syntax returns when a surface exists that can
   scroll to one.
4. **Verifying that a citation is *true*.** Deferred. The model can cite
   the wrong source; V1's defenses are prompt guidance and evals, not a
   verification pipeline.
5. **Remote content in popovers or chips.** Rejected for V1. No favicon
   fetches, no external previews, no unfurling — popovers render from
   what the message and the local resource record already carry.
6. **Changing mention chips.** Rejected. Mentions remain exactly as they
   are, including never being navigable; the deliberate asymmetry with
   navigable citations is argued in key design decision 4.
7. **Citation UI for choosing or inserting citations by humans.**
   Deferred. This PRD is about model-emitted citations; a composer
   affordance for people is its own later conversation.
8. **New defensive numbers.** Rejected — none are added.

## Product behavior

**Chips and embeds.** Two syntax forms, two renderings, one scheme:

- `[Mute windows PRD](resource://0192…)` — link form — renders as an
  inline chip: icon by resource kind, title as label, sitting inside the
  sentence the way a mention chip does.
- `![Mute windows PRD](resource://0192…)` — image form — renders as an
  embedded block card at larger presentation. This is the recommended
  form for announcing a generated artifact, and the reason is model
  behavior, not aesthetics: models place image syntax on its own line by
  training, the way they place actual images, so the card lands between
  sentences instead of cutting one into three pieces. The syntax choice
  does the placement work; no renderer heuristic guesses.

On click, both open the right rail on that resource's detail — the same
surface reached from the rail's own list. (Mechanically, a small exposed
action over the existing rail state: open the context rail, then select
the resource inspector — that selection is today reachable only from
inside the rail, and the rail-opening actions deliberately clear it, so
the ordering is part of the contract.)

**The detail view gains a content preview — named as new scope.** The
rail's resource detail today shows metadata only (type, direction,
version, remove); readable content appears nowhere in the sidebar, only
in the message-attachment lightbox. A citation that opens a metadata
card would be a dead end, so this PRD adds the missing half: the detail
view renders the resource's readable content through the shared renderer
via the authorized preview route, beneath the existing metadata —
reusing the lightbox's existing document-rendering path rather than
building a second one. This is the largest single piece of desktop work
in the PRD, and the earlier draft under-stated it.

**Citation metadata resolves across the workspace boundary.** A chip's
label is the model's text, but its icon, kind, and the popover's source
line come from the resource record — and a cited resource is not
guaranteed to be in the work stream's loaded resource set (it may be
cited from another work stream, or simply not yet loaded). The renderer
therefore resolves citation metadata against the workspace's resource
authority, under the viewer's existing authorization, with the
established degradation when resolution fails or is denied: label text,
no affordance. Whether that lookup rides the workspace socket or a REST
endpoint is genuinely open (open question 4);
[`choosing-sockets-or-rest.md`](../../choosing-sockets-or-rest.md)
governs the call.

That lookup dresses the chip; it does not widen the rail. The rail's
detail resolves from the loaded work stream's resource set and shows
nothing without one, so V1 scopes navigation accordingly: clicking a
citation whose resource is outside the loaded set — or on a surface
with no loaded work stream — lands on the rail's existing unavailable
state, carrying whatever title the metadata lookup returned. Full
fetch-by-id detail for an arbitrary cited resource is follow-up work
this PRD names but does not include.

During streaming, either form renders as plain text until its syntax
closes, then becomes the chip or card — the same progressive settling
every markdown construct already has.

**Footnotes as inline floaters.** The model emits standard GFM footnote
syntax — "Q3 revenue grew 40%.[^1]" with `[^1]: [Title](resource://…)`
definitions at the end — but Rally's renderer does not render the
bottom list. Instead it lifts each definition's content into its
reference and presents the reference as an inline floating pill: a
small numbered marker after the punctuation whose hover/focus popover
carries the source (title, and per open question 1 possibly an excerpt)
with an **Open** action. Adjacent references cluster as adjacent pills.

What counts as a citation definition is pinned, not guessed: a
definition qualifies when its content is a single paragraph containing
exactly one link — `[^1]: [Q3 board deck](resource://…)`, plain text
around the link permitted and carried into the popover. A definition
with no link, more than one, or additional block content is not a
citation: its reference stays a plain superscript and the definition
renders in a classic trailing footnote list, so a free-form or
malformed footnote degrades to standard GFM rendering rather than a
broken pill. For qualifying citations the message spends no vertical
space on a source footer — the vertical cost of long answers being the
original frustration this whole family of PRDs exists to fix — while
the *stored* markdown stays completely standard: any true markdown
renderer outside Rally (GitHub, a pasted gist) shows the same message
as classic numbered footnotes with the list at the bottom, exactly the
right degraded form, and Rally's own non-renderer surfaces (email,
Slack) get the rewrite rules below.

Clicking a pill or its popover's action opens the source — right rail
for `resource://` targets, the system browser for external URLs, routed
through the app's existing navigation-denial interception that already
sends every external link to the OS browser. During streaming, a
footnote whose definition has not yet arrived renders literally until
the message settles — the renderer's existing, documented behavior for
split footnotes — while chips settle progressively as their link syntax
closes.

**Failure and degradation states, exhaustively.** A `resource://` target
that is malformed, unknown, or not visible to the viewer renders as the
plain label text — never a broken chip, and never information the
message text did not already carry (the label is model-written text; the
chip adds affordance, not disclosure). If the rail cannot open the
resource (revoked since citation), the rail's existing unavailable state
shows. A footnote reference without a definition renders as text.
Outbound email and Slack get their own rewrite rules, next. Offline,
chips render (labels and titles are local); opening follows the rail's
and browser's ordinary offline behavior.

**Beyond the desktop: email and Slack rewrite, never leak.** Two
Rally-owned delivery paths render agent markdown with no shared
renderer, and each gets an explicit rewrite rather than a hope.

- *Outbound email.* The email markdown module today has no rule for any
  of this: its HTML path links only `http(s)` targets, so a
  `resource://` link would pass through as literal bracket syntax; its
  text path appends raw link targets whatever their scheme; and footnote
  syntax has no handling at all, in either part. The implementing change
  adds one rewrite ahead of both parts: link and image forms reduce to
  their label text, and footnote references and definitions reduce to a
  plain trailing source list — titles for internal sources, real links
  for external ones. The rule covers every email this module renders,
  not only digests.
- *Slack.* Agent replies delivered to Slack go out as ordinary markdown
  through Slack's `markdown` blocks, and Slack renders neither the
  `resource://` scheme nor footnote syntax — unrewritten citations
  would land verbatim in a channel. The Slack delivery path applies the
  same rewrite as email, before the text is chunked for posting: label
  text in place of chips and embeds, a plain trailing source list in
  place of footnotes, external URLs kept as links. The transcript copy
  of the same answer keeps its citations; only the Slack copy is
  rewritten.

No deep link into the desktop exists today for either rewrite to
target; if one arrives, both upgrade from title text to a real link
with no change to the protocol or the renderer.

**Where it applies.** Everywhere the shared renderer runs: the
transcript, the automation chat surface, and resource previews — so a
published document that cites its own sources has working citations when
opened. One surface shares the markup but not the stylesheet: the
message export card renders in a hidden window that loads none of the
application CSS, with element rules of its own written for a light
document ([message export](../../message-export.md)) — so chips, embed
cards, and footnote pills each need static rules there in the same
change (a chip as a labeled span, a pill as a plain superscript), or
the documented failure mode arrives: an unstyled element in the first
saved card someone looks at.

## Impact on the product contract

None — this refines behavior within the existing contract. Citations
add an affordance to content participants already see; opening one is
viewing and creates no participation; no channel, search, or global
surface appears. No clause moves.

## Decision log

None yet.

## Key design decisions

1. **Citations are renderer-recognized content, not message structure.**
   The mention-chip mechanism is the precedent: hijack markdown link
   syntax inside the single shared renderer, dispatch on scheme, keep
   the wire and the schemas untouched. The rejected alternative — the
   superseded PRD's dedicated message type — costs a wire enum, cache
   and dispatch branches, and version-skew handling on every client, to
   deliver what a link already carries.
2. **Both markdown forms, one `resource://` scheme: link renders a chip,
   image renders an embed card.** Revised in review from the draft's
   link-only recommendation. `[Title](resource://<id>)` is the inline
   reference; `![Title](resource://<id>)` is the embed, recommended for
   announcing generated artifacts because models treat image syntax as
   block-level by training — the card places itself between sentences
   with no renderer heuristic. The draft's objection that image syntax
   "burns the embed vocabulary" dissolves: the card *is* the first
   embed, and richer inline previews later deepen the same form rather
   than needing a new one. The `//` is the reviewed choice of true URL
   style (a divergence from bare `person:`, which stays as it is), and
   it buys a natural slot for future addressing (`?v=3` for version
   pinning). Bespoke citation blocks remain rejected as
   out-of-distribution. The identifier part stays an opaque token —
   bounded length, safe alphabet, never a strict-UUID pattern — because
   its shape belongs to the resource system, not the renderer; a future
   token-friendly slug or alias (key design decision 8) needs no renderer
   change. The known cost, accepted: the image form degrades worse than
   the link form outside Rally (a broken-image placeholder rather than
   label text), which makes the email and Slack rewrite rules
   load-bearing rather than nice-to-have.
3. **GFM footnote syntax; Rally renders floaters, not a footer.**
   Revised in review to be explicit about presentation: `[^1]` with a
   link-carrying definition is deeply in training data and parses under
   the renderer's existing GFM support — so the *stored* markdown stays
   standard and degrades to classic footnotes everywhere outside Rally —
   while Rally's renderer lifts each qualifying definition (the pinned
   grammar in Product behavior) into its reference's popover and renders
   no trailing entry for it; a definition that does not qualify keeps
   classic footnote rendering.
   Citations therefore cost no vertical space, which was the original
   frustration behind this work. The rejected alternatives: inline
   bracketed URLs after every claim (what long grounded answers look
   like today — unreadable), and rendering the bottom list as-is (spends
   the vertical space the feature exists to reclaim).
4. **Navigation is a property of the protocol.** `resource://` and
   `http(s)` navigate — rail in-app, the sanctioned external-open path
   for the browser — because they name openable content; `person:` and
   `connector:` never navigate, because they name identities, exactly as
   the renderer's existing security posture holds. The scheme dispatch
   is an allowlist; unknown schemes render as text, and nothing in
   message content can reach any other protocol handler.
5. **Degradation-first syntax.** Every choice above biases toward "if
   nothing special happens, the text still reads correctly": labels are
   real text, footnotes are real footnotes, and the non-desktop
   markdown surfaces Rally owns (outbound email, Slack delivery) get
   explicit rewrite rules rather than a hope.
6. **Renderer and prompt land together.** Revised in review from the
   draft's two-phase sequencing: with no production users, the skew
   window the phasing protected against costs nothing, and an older
   build degrades to label text anyway — so the desktop branch and the
   prompt module ship as one coordinated push. Rollback remains a prompt
   revert that leaves already-sent citations rendering forever.
7. **A citation opens the current version; `?v=` is reserved, unparsed
   syntax.** Resolved from open questions in review. A citation in a
   live conversation means "the document", not "the bytes as of 2:14
   PM": collaborators clicking a chip mid-discussion want what the
   group is working on now, and a pin-at-write default would routinely
   show already-fixed content as though it were current. Provenance is
   the versioning sibling's job — open current, and history is one
   click away in its version list. The V1 renderer does not parse a
   `?v=` parameter; the URL-style scheme reserves it for a future
   explicitly-pinned citation ("compare v3 against v5") once the
   version list exists to give it meaning. The rejected alternative,
   pinning by default, optimizes for the archival reading at the cost
   of the collaborative one, and the transcript's own record already
   serves the archival reading.
8. **Citations carry the resource slug once it exists; the alias itself
   is the versioning sibling's schema work.** Resolved from open
   questions in review, adopting the proposed alias: resources gain a
   short slug from the existing slug generator, allocated by the
   authority under a unique index (a collision at the quoted
   one-in-a-billion odds costs a regenerate-and-retry, never
   correctness), with the UUID remaining the internal primary key. The
   schema lands in the resource-versioning PRD — the change already
   touching the resource application, which was the condition attached
   to the proposal. This PRD consumes whichever identifier the resource
   system serves: the opaque-token pattern (decision 2) accepts UUID
   and slug alike, so there is no ordering dependency — citations ship
   on UUIDs and get cheaper and more copy-reliable for free when slugs
   arrive in model-facing outputs. Rejected: switching the primary key
   outright (a cross-cutting identity migration for a benefit the alias
   delivers), and owning the column here (identity belongs to the
   resource system's PRD, not the renderer's).
9. **A typed renderer registry covers every scheme × citation position,
   with exhaustiveness enforced by types.** Per review: rather than an
   if-chain that leaves cells implicit, the implementation is a registry
   keyed by (scheme, position) whose type requires a renderer — or an
   explicit degradation — for every cell, so adding a scheme is adding
   components the compiler demands, never silent gaps. The full matrix:

   | Scheme | link `[..](..)` | image `![..](..)` | footnote definition |
   | --- | --- | --- | --- |
   | `resource://` | inline chip | embed card | pill popover → rail |
   | `https` / `http` | external link (unchanged) | **a real image** (unchanged) | pill popover → browser |
   | `person:` / `connector:` | mention chip, non-navigable (unchanged) | identity card, non-navigable | pill popover with the identity, no open action |
   | anything else | plain text | plain text | plain text |

   The image + `https` cell is deliberately *not* a citation: the
   renderer's CSP permits external images and markdown images render
   today, so that syntax is live and means what it means everywhere —
   hijacking it as a web-citation card would collide with the model
   legitimately embedding an image. An external-site embed card, if
   ever wanted, is its own future decision with its own privacy story.
   Identity embeds and identity footnotes are defined and non-navigable,
   consistent with decision 4's navigation-by-protocol rule. The
   renderer additionally accepts the legacy bare `resource:` spelling
   alongside `resource://` — parsing is lenient across both formats so
   nothing already emitted breaks — while emission guidance teaches
   `resource://` only.

## Data model

None. No tables, no columns, no wire changes, no migrations. The feature
is server work in three pieces — the prompt module and the two delivery
rewrites (outbound email, Slack) — and desktop work in four: the
renderer branch (chip, embed card, footnote hooks), click routing, the
rail detail's content preview, and the export card's stylesheet rules.

## Security and trust model

- All parsing and rendering stays inside the single shared markdown
  renderer and inherits its posture: model text is untrusted, the scheme
  dispatch is a strict allowlist (`person:` and `connector:` as today,
  `resource://` added, `http`/`https` as today), and anything else is
  text.
- Internal navigation goes only to the rail's existing resource detail,
  under the viewer's existing authorization; a citation grants no
  access, and an unauthorized target renders as label text and opens
  nothing.
- External opens go exclusively through the app's existing sanctioned
  external-open path with its existing URL validation; citations add no
  new IPC and no new navigation capability to the renderer.
- No remote fetches occur at render or hover time (non-goal 5).

## Agent behavior

No tool or plugin is added or changed; this section records the guidance
contract.

A standing-policy module (or an extension of the response-formatting
policy — implementation's call within the byte budget) instructs, in its
own wording: when announcing a document or artifact the answer produced,
use the embed form (`![Title](resource://<id>)`) on its own line; when
referring to a resource in passing inside prose, use the link form
(`[Title](resource://<id>)`); use the resource's real identifier from
context — publish results and resource listings carry them — and its
human title as the label; for grounded and research answers, cite with
GFM footnotes placed after punctuation; never fabricate an identifier —
cite by plain name when no identifier is in context; cite the
load-bearing sources, not everything touched. The guidance renders for
every participant-triggered work-stream run, with no per-origin
carve-outs: the delivery rewrites own surface safety, so an answer that
goes out by email or Slack still carries citations in its transcript
copy and arrives readable in the delivery. The rejected alternative —
excluding email- or Slack-origin runs from the guidance — would need a
run-origin field the prompt context does not carry today, and would
strip citations from the transcript copy, which renders them fully.

Verification: formal prompt evaluations are deferred until Rally has an
evaluation suite; until then the Acceptance flows are walked manually in
dogfooding. What still lands as automated tests now: the renderer's
guard tests (the single-mount rule, the stylesheet rules) and the
normalization pipeline's tests extend to cover both citation forms
passing through unmangled.

## Rollout

1. One coordinated push (key design decision 6): the desktop branch —
   scheme dispatch, chip and embed card, footnote presentation, click
   routing, the rail detail's content preview, the export card's rules —
   and the server side — the prompt module, the email and Slack
   rewrites — land together. With no production users, any skew between
   the two is acceptable and degrades to label text.
2. Rollback is reverting the prompt module; everything already sent
   keeps rendering.

**Migration and compatibility risks, stated plainly:**

- Old desktop builds render a link-form citation as a dead anchor
  carrying its label (the default URL transform empties unknown schemes
  — the retired legacy mention scheme has a test pinning exactly this),
  and an image-form citation as a broken image. Acceptable with no
  production users; the reason the coordinated push should still be
  genuinely coordinated.
- The email and Slack rewrites must ship with the push, or those
  deliveries show raw `resource://` syntax, literal `[^1]` markers, and
  broken images — the image form makes these rules load-bearing, not
  cosmetic.
- The model-text normalization pass sits between the model and the
  renderer; a test proves it passes citation syntax through unchanged.
- Footnote parsing already works: the GFM plugin — requested as
  `latest` in the manifest, resolving to 4.0.1 today; the implementing
  change pins it, since parse behavior now load-bears — renders
  footnotes today as an unstyled superscript link plus a trailing list
  whose heading is visually hidden, and whose fragment anchors are dead
  under the desktop's navigation denial. This change is a renderer hook,
  not a parser: the reference anchors (they carry a stable data
  attribute) become the floating pills, each qualifying definition's
  content is lifted into its reference's popover, and the trailing
  footnote section renders only what the grammar did not lift — nothing,
  in the common all-citations case.
- Footnote DOM ids collide today: every message is its own renderer
  mount and GFM writes identical ids into each (`user-content-fn-1`, …)
  — nothing sets a per-mount prefix. The hook namespaces ids per
  message (the renderer's clobber-prefix option) so anchors and ARIA
  references cannot cross-wire between messages or streaming segments.

## Acceptance

1. A published document's announcement in embed form renders as the
   block card, and a link-form reference renders as an inline chip;
   clicking either opens that resource's detail in the right rail, and
   the detail shows the resource's readable content beneath its
   metadata.
2. A grounded answer renders inline numbered pills after punctuation
   with popovers carrying the source, and no footnote list renders at
   the message's end; internal sources open in the rail, external
   sources in the system browser; a definition that does not qualify as
   a citation renders as a classic footnote.
3. Malformed and unauthorized targets render as plain label text; the
   same cited answer delivered by email and by Slack shows readable
   text and a plain source list — no raw scheme URLs, no literal
   footnote markers, no broken images, in any outbound email, not only
   digests.
4. Citations inside a previewed document render, and navigate when a
   work stream is loaded; without one, the click lands on the rail's
   unavailable state rather than doing nothing silently.
5. Streaming shows plain text settling into chips with no flicker
   regressions in the streaming-cost tests.
6. `pnpm lint` (zero warnings), `pnpm typecheck`, and `pnpm test` pass;
   chips, cards, footnotes, and popovers captured from a real window in
   both themes, and a saved export card containing each citation form
   captured and read; every new test shown to fail when its protected
   behavior is broken.

## Open questions

1. **Popover depth** — title-and-open only, or an excerpt line? Settle
   against real screenshots; excerpts require deciding what text is safe
   and local to show.
2. **Embed card contents** — icon, title, and kind now; later an inline
   excerpt or live preview of the resource inside the card itself?
   Presentation call to revisit once the rail preview exists.
3. **Popover and card interaction details on touch/keyboard** — hover
   has no touch equivalent and focus order matters for the pills; settle
   against the real window during implementation.
4. **Transport for cross-workspace citation-metadata resolution** —
   workspace socket or a REST endpoint? Flagged genuinely open in
   review. [`choosing-sockets-or-rest.md`](../../choosing-sockets-or-rest.md)
   governs: its default pushes data down the socket proactively, but a
   viewer-triggered lookup for an arbitrary cited id is close to its
   "when a GET is still right" territory. Decide at implementation
   against that document; changes the lookup's plumbing, not any
   rendering or degradation behavior.
