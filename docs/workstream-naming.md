# Naming a work stream (retired)

**Thread naming is deleted.** A Thread was created with a placeholder title and
named a moment later by a model pass over its opening and transcript, with an
icon chosen beside the name. The Canvases and Sidekicks pivot
([PRD](PRDs/2026-11-06_canvases-and-sidekicks/prd.md)) has the person title a
Canvas and the Sidekick name its own conversations, so nothing is named by a
model any more. Plan step C-2 deleted `workstream-naming-service.ts`, the
harness's `prompts/workstream-name.ts` and the naming pass after a run.

This document is kept for its changelog: the grace window, the provisional
title and the injection boundary were each learned here. The `title_status`
column and the `workstream_naming` model role remain (the role still serves
the pasted-text title, `pasted-text-service.ts`). Do not build on anything else
it describes; the code is gone.

[`workstream-descriptions.md`](workstream-descriptions.md), which owned the
matching description loop (`workstream-description-service.ts`,
`prompts/workstream-description.ts`, the pass after each run and a Breakout's
empty-description summary), was retired in the same step: Canvases and
Sidekicks carry no model-written description. It is kept, cut to its
changelog, as its own retired record. The `workstream_description` model role
and its Flagship key were retired on 2026-11-07
([`feature-flags.md`](feature-flags.md)).

## Changelog

### 2026-11-07 — Naming and the description loop are retired

**What changed:** Plan step C-2 deleted the naming pass, the description loop
and both prompts, and cut this document to its changelog.
[`workstream-descriptions.md`](workstream-descriptions.md) was deleted in the
same step on the reading that it kept no changelog, and then restored as a
retired record of its own: its six dated entries sat after `## Operations`
with no `## Changelog` heading, which is how the reading missed them.

**Why:** A Canvas is titled by the person and a Sidekick names its own
conversations, so nothing calls a model to name or describe a conversation
after a run. The description document's entries hold reasoning that
[`workstream-creation.md`](workstream-creation.md),
[`data-model.md`](data-model.md), [`feature-flags.md`](feature-flags.md) and
[`potential-bugs.md`](potential-bugs.md) cite — the provisional description's
bound above all — and with the file deleted those links pointed here, at a
record that does not hold it.

**Considered and rejected:** Folding the six description entries into this
changelog. They record a separate module's decisions, and a reader following
a link about the description's bound would land in a record about titles.
Also rejected: keeping either document's body. The code it described is gone,
and a body that reads as present tense invites building on it.

**Consequences:** The `title_status` column, the `description_refresh_state`
table and both model roles outlive the passes; `workstream_naming` still serves
`pasted-text-service.ts`, and `workstream_description` has no caller and stays
only until `agent-model-workstream-description` is retired. Whichever change
drops one of them notes it in the document that owned it.

### 2026-10-05 — The icon is a plain string, and fallbacks may reason

**What changed:** The naming request sends `icon` as a required plain string
instead of an enum of the catalog. A model the harness registry marks
`reasoningRequired` (Grok 4.6, Gemini 3.7 Flash, Gemini 3.8 Flash) is sent its
default effort when naming asks for `none`; Terra and every other model still
get `none`.

**Why:** Every Gemini model tested refused the request: 2.5 Flash Lite and 3.8
Flash with "too much branching for serving" (the enum), and 3.7 Flash, 3.8
Flash and Grok 4.6 with "Reasoning is mandatory for this endpoint". One effort
covers the whole fallback route, so the fallbacks production routes to could
never serve a naming call.

**Considered and rejected:** An enum only for models that accept it, which
needs a per-model capability for one call. Dropping `none` for every model,
which would turn thinking on for Terra on a call the creator watches.

**Consequences:** The catalog is held by the prompt alone, so an off-catalog
answer, which the enum used to make impossible on a strict provider, now lands
as no icon. A model added to a fallback route that refuses `none` needs
`reasoningRequired` in `model-inference-defaults.ts`.

Pull request: [#1099](https://github.com/juno-ai-labs/avalon/pull/1099).

### 2026-10-02 — Imports get an icon from their history

**What changed:** A Channel created by a conversation import runs an icon-only
pass after it opens, through `rename` with `settled` as the fence and no title.

**Why:** Imports carry the name the importer typed, so the first pass never
ran and every imported Channel kept one of the twelve id-derived abstract
marks, whatever it was about. Reusing the naming call, prompt and `rename`
keeps one policy for generated icons; a separate import prompt would drift.

**Considered and rejected:** Letting the model pick the colour too; the id hash
spreads Channels across the ring with no model opinion to maintain. Creating
imports untitled so the first pass names them, which would replace the name the
importer chose. Publishing `workstream_renamed` with the icon, which carries a
title and could undo a rename that lands between the write and the event.

**Consequences:** The icon reaches clients only through the directory
projection, a few seconds after the Channel opens. A change that lets this pass
write anything else must keep it off the title.

Pull request: [#1067](https://github.com/juno-ai-labs/avalon/pull/1067).

### 2026-09-18 — Keep guest Main renaming inside conversation authority

Both desktop entry points use the conversation rename for guest Main access.
Using the member's parent rename endpoint would reject an otherwise permitted
conversation edit. Existing member routing remains unchanged; a guest grant
must not be treated as parent metadata authority.

### 2026-09-15 — Name prepared conversations from canonical history

**What changed:** The first background naming pass can read committed conversation
context, using the existing transcript reader, prompt and title transition.

**Why:** Imported conversations have no new opening prompt, and should receive an
automatic name without asking the importer to choose one. A separate import naming
pipeline would duplicate the naming policy and publication behavior.

**Consequences:** Source titles remain provisional fallbacks. Explicitly titled
prepared scenarios stay settled, and history installation never launches a run.

### 2026-09-10 — Substreams are named, and every address carries the substream

**What changed:** Both inputs take an optional `substreamId`, threaded into the
identity port, the message port and the rename publication, and
`publishWorkstreamEvent` takes one too. The first pass is called for a private
substream by its creation service; `settleAgentRun` now passes the substream its
run belongs to instead of dropping it. A child stores the icon its pass chose
like any other conversation; no surface draws it, and the sidebar keeps the
branch line.

**Why the pass is shared rather than copied:** a substream is named from an
opening message exactly as a work stream is, so a second implementation would be
a second answer to what a good name is, what happens when the model is
unreachable, and when a skeleton comes down — and the two would drift on the
first change to any of them. What differs between the two is one field, and one
line says so.

**Why:** A substream is created with an instruction now, which is exactly what a
name is chosen from, and it had no name of its own — children were written
`settled` with a placeholder title somebody had typed into a dialog. Threading
the address was most of the work: every port here defaults to the main
conversation, and `settleAgentRun` was already calling the refresh pass with the
parent's id for a run that happened in a child. That did nothing visible only
because children were settled and the parent's own title usually was too, so the
pass looked at the wrong conversation and correctly decided not to touch it.

**What a future change has to respect:** a naming call that does not carry the
substream is a call addressed at the work stream. Where a caller has one, it
passes it; where a pass grows a third port, that port takes it too.

### 2026-09-09 — The naming pass chooses an icon as well as a name (#619)

**What changed:** Both passes ask the model for a name *and* an icon in one
call, out of the catalog the header picker already offers. Every key in it
carries a description of the mark it draws, which the prompt renders. `rename`
writes the chosen icon in the same transaction as the title, only where no icon
is stored, and `workstream_renamed` carries what was written.

**Why:** A work stream's glyph was an FNV hash of its id, so a sidebar was a
column of arbitrary marks. The one thing in the product that already reads the
request closely enough to choose better was running a second after creation;
adding an enum to that request costs a field and the catalog.

**Considered and rejected:** Pairing each description with the work it fits — a
lookup table built by whoever last edited the file, so an icon only ever gets
chosen for the subjects that person listed; the section above has the replay
that settled it, including why pure geometry was worse still. `sparkles` as the
fallback — it is already Rally's own glyph in this product, so it would badge
the work streams Rally could not characterize as ones the agent acted on;
`circle-dot` says nothing, which is the job. A second model call for the icon — a
second reading of the same request, agreeing with the first only by luck. Writing through the
picker's appearance command — a second commit and projection beside the rename,
and one that could land for a pass whose rename had just been superseded.
Letting the second pass replace the first pass's icon — `appearance_json` records
no provenance, so a person's icon and Rally's are the same value, and a person
who picks one settles no title; overwriting would silently undo them. Provenance
on the appearance (an icon source beside the key, what `title_status` already is
for the title) is the change to make if the second pass's icon ever matters more
than the column.

**Consequences:** A naming pass now writes a second column, so anything added to
`rename` has to keep the rule that only the title may fail it. The catalog is
model-visible: adding an icon means adding a description of its drawing in the
same edit, and moves the golden prompt hashes. It costs about 5,500 bytes of
system prompt on every naming call, uncached. Nothing may assume a work stream
Rally named has an icon.

The reasoning behind describing rather than prescribing, and the replay that
settled it, is in the section above rather than repeated here.

### 2026-09-05 — Sentence case, two to four words, thirty characters

**What changed:** The channel styling is gone. A generated name is two to four
words in sentence case, thirty characters or less; `normalizeGeneratedTitle` is
back to repairing an answer rather than reshaping it — no lowercasing, no
hyphenating, and the apostrophe rule the hyphenating needed is gone with it. It
keeps the whole-word cut, which now also strips a comma the cut exposes, and
`sentenceCased` is back.

**Why:** Chosen by replaying 89 named work streams from the Global directory
through the prompt at 40, 30 and 20 characters against the model production
uses. Twenty was tried first and rejected on that evidence: the model answered
past it 37 times in 89, so two names in five were a truncation rather than a
name. Thirty costs 4 in 89. The table in the section above is that measurement.

Two lines of the prompt are the replay's findings rather than the author's
judgement. The model title-cases at these lengths unless told *never capitalize
every word* in as many words — "capitalized as a sentence" alone produced *Logo
For Oslo Coffee*. And it answers over the cap unless told to count the
characters, which at twenty took the overshoot from 56 in 89 to 37.

**Considered and rejected:** Enforcing sentence case in the normalizer, by
lowercasing every word after the first. It cannot tell a proper noun from an
ordinary one, so it would spell *Rally*, *Slack*, *IBM* and *INV-2291* wrong;
casing has to come from the prompt. Also considered and not built: asking the
model again when its answer is too long, rather than cutting. At twenty that
would have mattered — it would have rewritten two names in five — but at thirty
it would buy four names in 89 at the price of a second model call on each, and a
rewrite is not obviously better than a truncation while nobody has compared them.

**Consequences:** Changing the length is one constant in the naming service and
two sentences in the prompt, and they have to move together — the constant feeds
the cut. **The replay that chose the number is not in the repository** — it was a
scratch script, so the table above is a record of a measurement rather than
something a reader can re-run, and nobody should go looking for it under
`scripts/`. What it did, if it is ever worth rebuilding as a fixture-driven
eval: read the objective of each named work stream out of the Global workspace
directory, render the prompt by lifting `SYSTEM_PROMPT` out of the tree rather
than copying it, send the request `runStructuredInference` would send, and count
how many answers came back over the cap. It held its port of this module's
normalizer against the test vectors below before calling anything, which is what
caught those vectors going stale when the cap moved.

### 2026-09-05 — An apostrophe is elided rather than separating a word

**Superseded on the same branch by the entry above, and never on `main`.** It
describes the channel-style normalizer, which hyphenated a name and therefore
had to decide what an apostrophe did; nothing in the current file elides one.
Kept because [`module-documents.md`](module-documents.md) counts an approach
abandoned after it was tried as worth recording, and because the commit it
describes is in this branch's history, which merges rather than squashes.

**What changed:** `normalizeGeneratedTitle` removes `'` and `’` before turning
everything else a channel name cannot hold into the separator, so `what's rally`
becomes `whats-rally`. The prompt also now says which half of a name to drop when
it will not fit: the words that frame the work, never the detail that identifies
it.

**Why:** 89 model-named work streams from the Global directory were replayed
through this prompt and the one it replaced, against the same model production
uses. The apostrophe was the only defect the normalizer itself introduced —
`what-s-rally` reads as a typo, and a possessive is among the commonest things a
name leads with. The prompt change answers the one regression the replay showed
against the old prompt: asked to search two places for one subject, the model
kept the two places and dropped the subject, which is the opposite of the rule
about the distinguishing detail. Forty characters is not what squeezes it — one
name in 89 was long enough for the cut to fire at all.

**Consequences:** An apostrophe is the single exception to "everything else
becomes the separator", and it is in the normalizer rather than the prompt
because it is a repair, not a rule a model has to follow. The replay behind this
entry is the scratch script described in the entry above, and is not in the
repository either.

### 2026-09-05 — Generated names are channel-style, and forty characters

**Superseded on the same branch by the two entries above, and never on `main`.**
Read it as the first of three candidates rather than as a state the product was
ever in: its claim that `sentenceCased` is gone was true only of the intermediate
commit it describes, and that function is alive today. What it records is why
channel styling was tried — a column of hyphenated labels scans better than a
column of sentence fragments — and the shape of the argument that replaced it,
which is that the team preferred sentence case once both were on screen.

**What changed:** The naming prompt asks for a name written the way a Slack
channel is — two to four lowercase words joined by hyphens, forty characters or
less — and `normalizeGeneratedTitle` enforces that shape rather than
sentence-casing the answer. The generated cap dropped from 80 characters to 40,
and a name past it is cut back to its last whole word instead of mid-word.

**Why:** A product decision about how a list of work streams should read: a
column of hyphenated labels is scannable in a way a column of sentence
fragments is not, and it is the shape people already read lists of rooms in.
Forty characters is the team's number for it.

**Considered and rejected:** Changing the prompt alone. The model does this
correctly most of the time and not all of the time, and the surface that would
show the difference is the sidebar, where one prose title among hyphenated ones
is the thing a person notices. The normalizer was already where an unusable
answer is repaired, so the shape is guaranteed there and the prompt keeps one
rule rather than a list of prohibitions. Also rejected: rejecting an over-long
name at `WorkstreamNameResultSchema`, whose ceiling stays at 80 — a name a few
characters over the cap is still a name, and failing the parse would leave the
work stream with its provisional title instead.

**Consequences:** `sentenceCased` is gone; anything that wants a generated title
capitalized has to do it at the surface. Nothing downstream may assume a title
is hyphenated: the provisional title and a title a person typed are still prose,
and both sit in the same list. Changing the length again is one constant in the
naming service and one sentence in the prompt, and they have to move together.

### 2026-08-24 — The grace is derived per render rather than held in state

**What changed:** `useNamingSkeleton` no longer keeps an `expired` flag. It
computes the answer from the row's deadline and the current clock on every
render, and the timer only forces the render at the moment the grace lapses.

**Why:** Review on #271. The flag was initialised at mount and reconciled by an
effect, and the work-stream header stays mounted across work streams by design —
so moving from a settled work stream to a freshly created one rendered the new
one's provisional request text for a frame before the effect replaced it with the
skeleton, and moving the other way flashed a skeleton. Sidebar rows are keyed by
work-stream id and remount, which is why the surface that reported the original
bug never showed this one.

**Consequences:** The hook reads `Date.now()` during render, which is honest for
a value that is a function of the clock and is what makes the answer correct on
the first paint. Its own suite records what the hook returned on *every* render
rather than asserting on the DOM after effects have flushed, because Testing
Library flushes them before an assertion can see the frame that was painted.

### 2026-08-24 — The sidebar row honours the naming grace it renders a skeleton for

**What changed:** `useNamingSkeleton` moved out of `screens/workstream.tsx` into
`lib/naming-skeleton.ts`, and the sidebar's work-stream row now decides its
skeleton with it instead of reading `titleStatus === 'naming'` directly. A row
whose creation time cannot be read is treated as past the grace rather than as
inside it.

**Why:** A participant who was not the creator, and who had not opened the work
stream, watched a sidebar row shimmer indefinitely. The row is a cache entry, not
a read: the sidebar's query is `staleTime: Infinity` and is fed by socket pushes,
so the server's read-time relaxation of `naming` never reached it — and could
not, because that relaxation is derived and advances no row version, so the
versioned state ledger drops a fresh page carrying `automatic` as a repeat.
Opening the work stream was the only repair, and it repaired the header rather
than the row. The header already had this rule, for this exact reason; the
sidebar was the surface it was never applied to.

**Considered and rejected:** Making the client accept a page whose row version
has not advanced. That is the rule that stops a paged answer from walking back a
state the direct WorkstreamDO socket already advanced, and trading a permanent
skeleton for a title that can flicker backwards is the worse bug. Also rejected:
having the server stamp a new row version when the grace elapses. Nothing is
awake at that instant to stamp it — the whole point is that no further write is
coming — so it would mean a timer per unnamed work stream in the authority that
holds it, to change a value both sides can derive from `createdAt`.

**Consequences:** The grace is now enforced in three places against one exported
constant, and a fourth surface that renders a title from cached state has to use
the hook rather than the column. The API's read-time relaxation stays as it is;
it is what a fetching surface like the menu bar relies on. Where a rename push is
genuinely lost, the sidebar now shows the provisional title — the same answer a
fresh read gives — instead of a skeleton.

This document itself is new. Naming had no owner: `workstream-creation.md`
pointed at `workstream-descriptions.md` for it, and that document disclaims the
title in its own boundary section. The pointer now names this file.
