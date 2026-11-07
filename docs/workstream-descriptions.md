# Work-stream descriptions (retired)

**The description loop is deleted.** A Thread's description started as the
first line of its opening message, was replaced by a summary the first naming
pass wrote, and was then re-evaluated by a model pass after each run, behind a
rest window, a novelty threshold and guards that stopped it generalizing. The
Canvases and Sidekicks pivot
([PRD](PRDs/2026-11-06_canvases-and-sidekicks/prd.md)) gives a Canvas and a
Sidekick conversation no model-written description, so plan step C-2 deleted
`workstream-description-service.ts`, the harness's
`prompts/workstream-description.ts`, the pass after each run and a Breakout's
empty-description summary, in the same step that retired
[`workstream-naming.md`](workstream-naming.md).

This document is kept for its changelog: why the provisional description is the
opening line rather than the whole message, why a proposal is repaired before it
is judged, and why the refresh lease shares the owning object's transaction were
each learned here, and other documents cite them. The `description_refresh_state`
table remains; the `workstream_description` model role and its Flagship key,
`agent-model-workstream-description`, were retired on 2026-11-07
([`feature-flags.md`](feature-flags.md)). Do not build on anything else
it describes; the code is gone. The body that described the loop was cut on
retirement, and with it the 2026-10-12 entry's pointer to its section on the
first summary; `git show 82f2db7:docs/workstream-descriptions.md` has it whole.

## Changelog

### 2026-10-12 — The first naming pass summarizes the request

**What changed:** A thread started from the composer gets its description
replaced by a one-to-two-sentence summary of the request, written by the
first naming pass in the call it already makes.

**Why:** The Channel feed now shows the description under each thread's name,
and the product owner asked whether it was a summary. It was not: the
derived first line was the only description most threads ever had, because
the loop below only rewrites after ten messages and real drift, which a
typical thread never reaches.

**Considered and rejected:** Letting this loop make its first pass without
its volume gates. That is a second model call per thread, after the first
run rather than a moment after creation, and it asks a judgment model
built to say "keep" to write from scratch.

**Consequences:** The description every run starts from is now a model's
summary rather than the person's first line. The opening message is still
the first message, stored whole, so no run loses the request. The summary is
`derived`, so this loop may still rewrite it later.

### 2026-09-04 — Keep descriptions as context, not navigation copy

Global navigation now shows titles only, with a timestamp only when unread.
Descriptions remain searchable and retain their routing/context role. Removing
their display is not permission to delete the authoritative description loop.

### 2026-08-26 — Socket hand-offs do not erase the sidebar description

**What changed:** Both control-socket snapshot readers now map the authoritative
WorkstreamDO `description` into the desktop directory model's `objective` alias.
The sidebar also refuses to replace a known description with an empty legacy
projection while workspace and direct sockets are handing authority over.

**Why:** The ordered-transcript migration moved work-stream reads to the direct
socket, but only the workspace-feed reader populated `objective`. Opening a work
stream could therefore replace the sidebar row with a structurally newer row
whose description was missing, leaving the selected item title-only.

**Consequences:** Every new snapshot source must preserve description identity
even if its wire name differs from the desktop alias. Empty compatibility data
may not erase a description already supplied by an authoritative source.

### 2026-08-24 — The provisional description is the opening line

**What changed:** `provisionalWorkstreamDescription` lives here and is what the
composer create and both Slack create paths derive a description with: the first
non-empty line of the opening message, bounded at
`WORKSTREAM_DESCRIPTION_MAX_CHARACTERS`. The composer path previously used the
whole trimmed message; the Slack paths used `prompt.slice(0, 4_000)`, which was
right in size and wrong at a surrogate pair.

**Why:** Raising the message ceiling to `MESSAGE_MAX_CHARACTERS` (100,000) forced
the question this module had never had to answer, because at 4,000 the message
*was* a plausible description. It is not one at 100,000. Three choices existed
and only one of them keeps both fields honest:

- Let the description inherit the message's ceiling. Rejected: it widens the
  `workspace_workstream_directory` column CHECK, the producer bound in
  `workstream-regional-effect.ts`, and every directory push and classifier input
  along with it — a cost paid on reads that have nothing to do with the work
  stream being described.
- Truncate the whole message to 4,000. Rejected: it is the same copy, cut
  mid-sentence, and it makes the description longer and less useful than the loop
  below will ever write.
- Take the opening line. Chosen: it is what the person is asking for, the
  paragraphs under it are how, and this value is replaced by the loop below after
  the first run anyway.

**Consequences:** A multi-line create now opens with a shorter description than
it used to — its first line rather than its whole message. That is a visible
change to every work stream started from a multi-paragraph message, and it is
the intended one. The bound stays the storage ceiling rather than
`MAXIMUM_DESCRIPTION_CHARACTERS`: this value is the fallback that stands when
naming and this loop both fail, and cutting a person's own first line to 280
would be inventing a summary rather than deriving one.

### 2026-08-23 — A proposed description is repaired before it is judged

**What changed:** `judgeDescriptionProposal` runs the proposal through
`normalizeModelText` before the length, genericness and divergence rules see it.

**Why:** A description is shown as plain text in the sidebar and the header, so a
model writing `$\rightarrow$` in one puts TeX where nothing will ever render it.
Repairing before the rules rather than after means every bound is measured
against the sentence a reader gets: the delimiters and command name would
otherwise count toward the character ceiling, and the normalized comparison used
to detect a restyling would differ from the stored text for no real reason.

**Consequences:** The plain-text entry point is the correct one here and the
Markdown one would be a bug — it escapes what it unwraps, which on this surface
is a backslash a reader sees. [`model-text-normalization.md`](model-text-normalization.md)
states that rule.

### 2026-08-17 — Description refresh shares the WorkstreamDO transaction

**What changed:** The description and `description_refresh_state` are now
mutated in one transaction in the owning object.

**Why:** The refresh lease and the product field it protects must have one
linearization point after the work-stream authority cutover.

**Considered and rejected:** Leaving the refresh row in D1 and coordinating it
with the local description through retries; that permits an automatic rewrite
to race and overwrite a person's edit.

**Consequences:** Existing refresh logic keeps its guards and rest windows, but
all reads and conditional writes use object-local SQL.
