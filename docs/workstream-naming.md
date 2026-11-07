# Naming a work stream

A work stream is created faster than a model can name it, so it is created with a
placeholder and named a moment later. This document owns that gap: the
provisional title creation writes, the two passes that replace it, the icon each
pass chooses beside the name, the `title_status` column that says which of those
has happened, the sixty-second grace that bounds how long a reader is asked to
wait, and the skeleton every surface renders while the wait is on.

The promise the whole design turns on is narrow and worth stating plainly: **a
title skeleton means a name is seconds away.** Everything below exists so that
promise is kept even when the model is unreachable, the isolate goes away
mid-call, or the event carrying the name never lands.

Guest Main renames use the existing conversation-scoped `renameSubstream(id, '0',
title)` mutation from both header and sidebar. A Main grant authorizes that
conversation, not parent work-stream metadata. Members retain `renameWorkstream`.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/services/workstream-naming-service.ts` | Both passes, the icon pass for a Channel created with its name, the provisional title, the model call, the compare-and-set that advances `title_status`, and the rename event. The single source of every generated title. |
| `packages/agent-harness/src/prompts/` | `renderWorkstreamNameMessages` — the naming agent's prompt, including the icon catalog rendered into it. See [`writing-prompts.md`](writing-prompts.md). |
| `packages/contracts/src/workstream-appearance.ts` | The icon keys, one description per key, and the default. Shared with the picker; see [`workstream-appearance.md`](workstream-appearance.md). |
| `packages/contracts/src/index.ts` | `WORKSTREAM_NAMING_GRACE_MS`, `WorkstreamNameResultSchema`, and `titleStatus` on every work-stream shape. |
| `apps/api/src/durable-objects/workstream-identity-storage.ts` | `rename` — the one write that advances the status, sets the title, and offers the icon. |
| `apps/api/src/durable-objects/substream-agent.ts` | The second pass's caller, at the end of a run (`settleAgentRun`), addressed at the conversation that ran. |
| `apps/api/src/durable-objects/workspace-do.ts`, `workstream-object-product.ts` | Where the grace is applied to a read: `directoryWorkstream` for a sidebar row, `summary` for the work stream itself. |
| `apps/desktop/src/renderer/lib/naming-skeleton.ts` | `useNamingSkeleton` — the same rule applied to what the client already holds. Every renderer surface that shows a skeleton reads it from here. |

### The title a work stream is created with

A model call cannot sit on the create path — the person who pressed enter is
waiting on the response — so creation writes `provisionalWorkstreamTitle`: the
first non-empty line of the objective, truncated to the 180 characters `title`
accepts, or a caller-supplied fallback when the objective is blank. The row is
written `title_status = 'naming'`, and that value is the promise that a name is
coming.

A create that carries its own title is not named at all: it is written `settled`,
and neither pass will look at it. A conversation import is the one such create
that still gets a generated icon; see [Prepared history](#prepared-history).

### A private substream is named the same way

A substream is created with the message that starts it, so the same rule applies
one level down: its provisional title is that message's first line, its
`title_status` is `naming`, and both passes run against the child. Every call
carries the substream alongside the work stream — `createIdentityObjectPort` and
`createMessageObjectPort` take it, and `publishWorkstreamEvent` addresses the
child's own room — because each of those defaults to the main conversation, and
a default taken here renames the work stream somebody is not looking at. The
child's rename reaches the parent's registry, and from there every sidebar,
through the ordinary common projection rather than a second write.
`substream-creation.md` (retired) owns how that child is created;
this document owns what happens to its title afterwards.

The icon is stored for a child as it is for a work stream: the same call
answers both halves, the child's own row has somewhere to put it, and there is
no conditional here at all. Nothing draws it today — a substream's sidebar rows
carry the `↳` arrow, its compact mark carries the first character of its
title, and its header shows the parent's icon — and the directory payload those
rows are built from has no appearance field to carry one. So this is a value
kept where it belongs rather than a value on screen; a surface that ever wants
a substream's own icon will find one already chosen, and until then the rail
looks like what it is.

### The two passes

**The first pass** runs once, off the caller's clock, from the opening request
alone. It asks the naming agent for a label, normalizes the answer, and advances
`title_status` to `automatic` — *whether or not a name was produced*. A pass that
produced nothing still settles the promise, because a skeleton that never
resolves is worse than the provisional title standing for good.

**The second pass** (`refreshWorkstreamName`) looks again once the work stream
has become a conversation, and replaces the name if the transcript says something
better. It is eligible only while `title_status` is `naming` or `automatic`, and
only past `RENAME_AFTER_MESSAGE_COUNT` (5) member-or-agent text messages — the
first name was chosen from a request, and the identifier, the person, or the
actual problem usually arrives in the replies. It reads the *first*
`RENAME_CONTEXT_MESSAGE_LIMIT` (12) messages, 600 characters each: a name
describes what the work stream is for, which is established in its opening
exchange rather than in whatever is in flight now. A successful pass sets
`settled`, after which nothing generated will change the title again.

The two passes differ in what they do with a model that cannot be reached. The
first settles anyway, because a skeleton is on screen waiting for it. The second
leaves an `automatic` row alone, because nothing is waiting — an `automatic`
title and a `settled` one render identically — and the next run tries again. The
one exception is a row still in `naming`: that is a first pass that never
finished, and its promise is the one that has to be kept.

### The summary asked for on a first pass

When creation derived the description from the opening message, the first
pass also asks for a summary of the request, with its own schema
(`nameWithSummaryJsonSchema`) so the other passes do not pay for one, and
writes it through `redescribe`.
[`workstream-descriptions.md`](workstream-descriptions.md#the-first-summary)
owns the rules.

### The shape of a generated name

Two to four words in sentence case, thirty characters or less. The prompt asks
for it and `normalizeGeneratedTitle` repairs what comes back: a quoted phrase, a
Markdown heading, TeX, a trailing full stop, an answer that starts mid-sentence.

**Thirty is where the cut stops doing the naming.** The length was chosen by
replaying 89 named work streams from the Global directory through the prompt at
each candidate, and counting how often the model answered past it:

| Cap | Model answered over it | What that looked like |
| --- | --- | --- |
| 40 | 1 in 89 | Names sit well inside; the cap is a pure backstop. |
| 30 | 4 in 89 | Names sit inside; the cap is a backstop. |
| 20 | 37 in 89 | Two names in five are a truncation, not a name. |

At twenty the truncation was naming the work stream: names ended on the word the
model meant to continue — *Podcast from*, *Essay on rust and*, *Work on* — and
work streams differing only past the cut collided, with six QA work streams all
arriving as *PRODUCTION HARNESS*. Thirty keeps almost all of the brevity and
almost none of that, because the cut fires on a twentieth of the names rather
than two fifths.

**What the whole-word cut buys is narrower than that, and worth stating
exactly: no half words.** It cuts on a space, so `Avalon download link email to`
is what it produces rather than `Avalon download link email t`. It does not
prevent a name ending mid-thought, because a cut that lands after *to*, *from*
or *and* is a whole-word cut. Nothing here can tell a word the model meant to
continue from one it meant to end on; ruling it out would take a closed set of
function words in every language the prompt writes names in. What makes that
acceptable at thirty and not at twenty is only the rate. The cut also takes any
comma it exposes, so a name cut between two listed things does not keep the
separator to nothing.

Two lines of the prompt exist because the replay showed the model ignoring the
rule without them. *Count the characters before you answer* took the overshoot at
twenty from 56 in 89 to 37. And *never capitalize every word* is what stopped it
title-casing — at these lengths "capitalized as a sentence" alone returned *Logo
For Oslo Coffee*. Casing cannot be repaired afterwards: lowercasing every word
but the first would spell *Rally*, *Slack*, *IBM* and *INV-2291* wrong, so
`sentenceCased` only capitalizes a first word that is already all lowercase.

It capitalizes *before* the cut, which is what makes the cap a real bound. An
uppercase mapping can be longer than the letter it replaces — `ß` becomes `SS`,
`ﬁ` becomes `FI` — so a capital added after the cut can hand back 31 characters
from a cap of 30.

**Thirty is longer than the sidebar row shows.** At the default sidebar width a
row ellipsizes somewhere around fifteen to seventeen characters — in a captured
window, `Invoice INV-2291` fits and `Essay on Rust and OCaml` renders as *Essay
on Rust a…* — so the back half of a thirty-character name is only ever read in
the work-stream header, the substream list, and the menu bar, which show it in
full. That does not undercut the measurement behind the number, which was taken
on stored names, but it does mean the sidebar cannot be the argument for a
longer cap. It is recorded here because the arithmetic is not obvious from
either the constant or the row.

Two titles are deliberately longer, because neither was generated: the
provisional title, which is the person's own first line, and a title a person
typed. So a sidebar holds both kinds, and nothing downstream may assume a title
is short.

### The icon chosen with the name

Each pass asks for an icon in the same call as the name, out of the closed
catalog in `packages/contracts/src/workstream-appearance.ts` — the same keys the
header's picker offers, so nothing the model can choose is a mark a person could
not have chosen themselves.

**Every key in that catalog carries one or two sentences describing it**, and the
prompt renders all of them. A key on its own tells a model nothing — it has never
seen this catalog, and `spline`, `aperture` and `component` name drawings rather
than subjects — so each line names what the icon depicts and then how it is
drawn: *"A camera aperture: a ring of straight, angled blades that overlap and
spiral inward, leaving a small opening at the centre."*

**A description says what the icon draws and stops there.** None of them says
what kind of work an icon is for, and none should. Which mark suits a work stream
is the model's call, made with the request in front of it and the whole catalog
to compare against; a usage note in the catalog is that call taken in advance by
whoever last edited the file, and it narrows the icon to the subjects that person
happened to list. The prompt says the same thing to the model in as many words,
so it does not read the descriptions as a lookup table. A test rejects a description
containing usage language, because this would come back one line at a time — it
is a denylist of the phrasings that would actually be reached for ("fits",
"suits", "represents", "good for", "for tracking"), not a semantic check, so it
is a tripwire rather than a proof.

**Naming the thing is part of describing it, and geometry alone is not enough.**
The line for `coins` says it is two coins before it says one is face on and one
is behind it at an angle. A version that gave only the geometry — two overlapping
discs, ticked lines above an unticked one — left the model to work out what the
shapes *were*, and it put `list-checks` on an invoice reconciliation. Say what a
person would call the thing, then how it is drawn; that is a fact about the
picture, not an opinion about its use.

The only opinions the product keeps about *choosing* are in the prompt, where
[`writing-prompts.md`](writing-prompts.md) requires them: the tie-break when two
marks suit (the more specific one, and the catalog's own order when neither is),
and one fallback for work none of them suits, so that case resolves deliberately
instead of by stretching the nearest icon.

**The fallback is `circle-dot`, and deliberately not `sparkles`.** Sparkles is
the obvious generic mark and the wrong one here: it is already Rally's own glyph
in this product — the mention icon in the composer, and the account menu — so
using it for "no icon suits this" would badge exactly the work streams Rally
could not characterize as the ones the agent did something to. A plain dot in a
ring says nothing, which is what this fallback should say.

Descriptions are free to be reworded; the keys are stored values and cannot
change without a migration, which is why the two sit in the same file but are
separate structures. A `Record` keyed by the icon type makes the set exhaustive
by construction — adding a key without describing it does not compile.

**A generated icon is written only where no icon is stored.** This is a stricter
rule than the one on the title, and it has to be, because the fence that protects
the title cannot protect the icon: choosing an icon from the header changes no
title and settles nothing, so the row a second pass is still entitled to rename
is exactly the row whose icon a person may have just picked. Refusing to overwrite
any stored icon is what makes the two safe together. The cost is that a second
pass improves the name without revisiting the icon the first pass chose from
less; telling a generated icon from a chosen one would need provenance the
`appearance_json` column does not carry.

The icon is also tied to the name rather than written on its own. A pass whose
name normalized away to nothing, or whose model could not be reached, writes no
icon either — it is reporting that it produced nothing usable, and the one icon
the work stream gets should not be spent by it. And an icon that comes back off
the catalog degrades to no icon rather than failing the parse: the name is the
half a person is watching a skeleton for.

### Advancing the title is a compare-and-set

`advanceTitle` writes `title = COALESCE(<generated>, title)` and the new status
only `WHERE title_status = <the status the pass started from>`. A person can
rename a work stream from its header while a model call is in flight, and their
rename settles the title; a generated name arriving afterwards must not undo it.
Losing that race writes nothing and publishes nothing, because the rename they
made already told everyone.

### How the name reaches people

Two paths, and both matter because they serve different readers:

- **The work stream's room.** `publishWorkstreamEvent` publishes
  `workstream_renamed` with the title, the new status, and the icon *if one was
  written* — the object reports which, so a refused icon is never published and
  no open client paints over the choice it was refused for. The event reaches
  anyone with that work stream open, in practice the person who just created it.
  The client puts the icon on the **sidebar row only, and only where that row
  has no icon**; the header waits for the projection below. Two conditions, two
  reasons.

  *Row only*, because the cached detail behind the header is what the appearance
  picker reads to decide its own pending preview is finished, and `settled()`
  retires that preview as soon as the detail's icon moves off the baseline it
  was taken against — to any value, since another person changing the icon has
  to retire it too. An icon written there that nobody in this window picked
  would retire somebody's in-flight choice to the generated glyph and hold the
  header on it until the projection lands.

  *Only where the row has none*, because the event carries an icon exactly when
  the object had none at the moment it renamed, so a row that has one now holds
  something newer — a choice whose receipt already landed. The two travel
  different paths, the room socket and the Main command channel, so the event
  can arrive after that receipt.
- **The workspace directory.** The `UPDATE` names `workstreams`, so the
  work-stream object commits a `directory_common` effect beside it, which flows
  `SubstreamAgent -> Queue -> WorkspaceDO` (the Channel's parent, then the
  directory, in one object) and is pushed to every
  subscribed workspace socket as `workspace_workstream_state`. This is the only
  path to a sidebar row, and therefore the only path to somebody who is a
  participant in the work stream and has not opened it.

### The grace, and why it is applied twice

`WORKSTREAM_NAMING_GRACE_MS` is 60 seconds from creation. Past it, `naming` is
reported as `automatic`: the provisional title is the title, whatever the row
says. That relaxation is applied in two places, and both are load-bearing.

**On a read**, by the authority that serves it — `directoryWorkstream` in
WorkspaceDO and `summary` in the work-stream object. A surface that fetches, like
the menu bar's `/workstreams` page, needs nothing else.

**On what the client already holds**, by `useNamingSkeleton`. No renderer surface
refetches a title on its own: the sidebar list is `staleTime: Infinity` and is
fed by socket pushes, and the work-stream detail is replaced by snapshots. So a
client that held a `naming` row when the rename push failed to reach it would
keep that row for the session. Nothing later corrects it either — the read-time
relaxation is derived and advances no row version, so a fresh directory page
carrying `automatic` is dropped by the state ledger as a repeat of what the
client already has. The hook closes both by applying the same rule to the cached
row.

It decides on every render from that row's own `createdAt` and the clock, and
holds no state of its own; the timer it arms for the remainder of the grace only
schedules the render at the instant the grace lapses. That is what makes it safe
on the work-stream header, which stays mounted while the work stream under it
changes: an answer kept in state would be the previous work stream's until an
effect corrected it after paint, which is a frame of one work stream's request
text under another's header.


### Prepared history

An unnamed prepared conversation uses the same first naming pass after its history
is committed. The creation service requests canonical conversation context, reusing
the existing transcript reader and context bounds. Explicitly titled prepared
scenarios retain their names.

A conversation import is created with the name the importer typed, so it is
`settled` and the first pass never runs. Creation runs the **icon pass**
(`chooseWorkstreamIcon`) instead when the caller sets `chooseIcon`, which only
`openReservedImport` does. It is the same model call over the imported history,
written through `rename` with no title and `settled` on both sides of the fence:
the name and its status stay as they are, and the icon is written only where none
is stored. The model's name is discarded, and the icon stands even when that name
normalizes to nothing. The colour stays the id-derived one. The pass publishes no
room event, because `workstream_renamed` carries a title and one sent after a
person's rename would undo it; the directory projection carries the icon.

## Invariants

- **`title_status = 'naming'` is a promise that something will settle it.** Any
  path that writes it must schedule a first pass in the same request. A creation
  path that writes `naming` and never calls `nameWorkstream` leaves a permanent
  skeleton on every surface, with nothing in the product able to repair it.
- **The first pass advances the status even when it produced no name.** Returning
  early on a model failure is the one change that turns a bad title into a
  broken screen.
- **Every advance is a compare-and-set on the status it started from.** Writing
  the title unconditionally silently discards a person's rename.
- **A generated icon is written only where no icon is stored.** The status fence
  above does not cover it — a person picking an icon settles no title — so this
  condition is the whole of what protects their choice, and it lives in the same
  transaction as the title write rather than in the caller.
- **Nothing about the icon may throw inside `rename`.** Both parses there are
  non-throwing on purpose: the title write and the status advance share that
  transaction, so an unreadable icon or appearance would roll back the name and
  leave the permanent skeleton this module's first invariant forbids. The icon
  is the soft half everywhere — at the model parse, at the write, and on the
  client.
- **What is published is what was written.** The object returns the icon it
  actually stored; publishing the icon the pass *asked* for would tell every open
  client to show an icon the object had just declined to write.
- **A surface that renders a skeleton from a cached row applies
  `useNamingSkeleton`.** Reading `titleStatus === 'naming'` directly is correct
  only for a value that just came off a fetch; anywhere else it is the
  shimmer-forever bug, and it is invisible to a component test that renders a
  fixture.
- **The grace is one constant, exported from contracts.** A client and a server
  that disagree about it produce a row whose skeleton and whose title come from
  different rules. All three readers import `WORKSTREAM_NAMING_GRACE_MS`:
  `useNamingSkeleton`, `directoryWorkstream` in WorkspaceDO, and `summary` in the
  work-stream object. A fourth that writes the number instead is invisible to
  anyone changing the constant, and to anyone grepping for the rule.
- **Naming never fails its caller.** Both passes swallow everything: they are
  called after a work stream is created, after a run has finished, beside a
  message that is already durable. None of those can be failed by a title.

## Boundary

This module owns the title of a conversation — a work stream or one of its
private substreams: the placeholder, the passes that replace it, `title_status`,
and when a reader is shown a skeleton instead of text.

It does not own the objective — that is
[`workstream-descriptions.md`](workstream-descriptions.md), a separate loop over
a separate column. It does not own the create path or the optimistic launch
surface, which are [`workstream-creation.md`](workstream-creation.md); that
document renders this module's skeleton and defers to this one for what the
skeleton means. It does not own how a name is delivered: the room event is
[`workstream-durable-object.md`](workstream-durable-object.md)'s socket and the
sidebar push is its directory projection, and which of the two carries what is
[`choosing-sockets-or-rest.md`](choosing-sockets-or-rest.md).

It owns *choosing* an icon and the rule for when that choice may be written, and
nothing else about appearance. The catalog of keys, the descriptions beside them,
the header picker, the colour, the id-derived default a work stream falls back
to, and the projection that carries a stored appearance to every surface all
belong to [`workstream-appearance.md`](workstream-appearance.md). A change to
what icons exist is that document's; a change to how the model picks among them
is this one's. It does not own the
prompt's wording ([`writing-prompts.md`](writing-prompts.md)) or which model runs
it ([`feature-flags.md`](feature-flags.md)). A title a person types is an
ordinary work-stream update and belongs to the object's product service.

## Failure modes and limits

- **`OPENROUTER_API_KEY` is unset, or the model is unreachable.** No name is
  produced, and therefore no icon. The first pass settles the provisional title
  as `automatic`; the second leaves an `automatic` row for the next run. The work
  stream keeps the id-derived glyph, which is what an unnamed one shows anyway.
- **The model answers with an icon that is not in the catalog.** The name still
  lands and the icon is dropped. The request sends the icon as a plain string,
  because Gemini refuses the catalog as a 253-value enum, so this is the path
  for any answer the prompt did not hold to the catalog, as well as for a key
  renamed out from under a request already in flight.
- **A key the *object* does not know, or a stored appearance it cannot read.**
  Same outcome, enforced a second time and for a harder reason: `rename` parses
  both without throwing, because the title write and the `title_status` advance
  are in that transaction and a throw rolls them back — which is the permanent
  skeleton this whole module exists to prevent. The key case is a rollout, where
  a Worker one deploy ahead sends a catalog key the resident object's enum does
  not have; the appearance case is any value the column's `json_valid` CHECK
  admits that the schema does not, `'null'` among them. An unreadable stored
  appearance is left exactly as it is rather than replaced with a generated
  icon, per [`workstream-appearance.md`](workstream-appearance.md).
- **A person picked an icon first.** The write is refused, nothing about the icon
  is published, and the name lands as usual. This is also the outcome when they
  pick one between the two passes.
- **The model answers with something unusable** — a quoted phrase, a Markdown
  heading, TeX, a trailing full stop, an answer that starts mid-sentence, one
  that runs past the cap. `normalizeGeneratedTitle` repairs each of those rather
  than the prompt prohibiting it, and reduces an answer with nothing left —
  whitespace or trailing punctuation alone — to `null`, which is treated as no
  name. It repairs *form* only. Title case is prevented by the prompt instead,
  because the normalizer cannot tell a proper noun from an ordinary word, and an
  answer that is a bare emoji is written through as it stands.
- **The isolate goes away mid-call.** The row stays `naming`. Every *read* past
  the grace reports `automatic`, and every cached row stops shimmering at the
  same instant; the second pass repairs the row itself at the end of the next
  run.
- **The rename push is lost.** The client falls back to the provisional title at
  the grace, which is exactly what a fresh read would have said. The generated
  name arrives at the next event that touches the row, or the next reconnect that
  finds the row's version advanced.
- **Limits.** One icon per work stream, written once and never over a stored
  one. The catalog costs about 5,500 bytes of system prompt on every naming
  call, uncached. A generated title is capped at 30 characters, cut back to the last
  whole word — `title` holds 180, but a generated name is a label rather than a
  sentence, and the tail of a word cut mid-way reads as a typo. At this length
  the cut is a backstop: it fired on 4 of the 89 replayed work streams. The
  provisional title is capped at the column's 180. The second pass reads at most
  12 messages of 600 characters and runs at most once. The grace is 60 seconds.

## Testing

- `apps/api/test/workstream-naming.test.ts` (Node) covers both passes against the
  checked-in schema and a real work-stream object store: the compare-and-set, the
  message-count threshold, the unreachable model, the normalizer, and that
  nothing it does can fail its caller. It executes the object's SQL directly, so
  it proves the write and the room event but not the directory effect. The icon
  cases run through the same real `WorkstreamIdentityStorage`: break them by
  dropping the `appearance_json` value from `rename`'s `UPDATE` (the two passes'
  icon assertions fail), by removing the `stored.icon === null` condition beside
  it (*"keeps an icon a person chose"* fails, with the person's `rocket` replaced),
  or by dropping `.catch(null)` from `WorkstreamNameResultSchema` (the
  off-catalog case loses the name along with the icon). The two non-throwing
  parses have a case each — *"still renames when the icon is a catalog key this
  object cannot read"*, dispatched at the storage operation because the service's
  own parse degrades that value long before the write, and *"names the work
  stream past an appearance it cannot read"*. Restore either `.parse` and both
  fail with the row stuck in `naming`.
- The icon pass has its own cases in the same file: an imported Channel gets the
  icon from its history and keeps its settled name, and keeps the icon when the
  model's name normalizes away. Break both by offering no icon to `rename`, the
  second alone by dropping `iconOnly` from `generateName`. `apps/api/test-workers/session-import-run.test.ts`
  proves the wiring on real workerd: the opened Channel has the double's icon.
  Break it by passing `chooseIcon: false` from `openReservedImport`.
- `packages/agent-harness/src/prompts.test.ts` asserts a description line for
  every key in the catalog, not a sample of them. A key added without one fails
  to compile first; this is what catches one described in a way the prompt never
  renders. It also rejects a description containing usage language — a denylist
  of the phrasings someone would actually write, not a semantic check, guarding a
  rule nothing else enforces and that would erode one line at a time.
- `apps/api/test-workers/durable-object-runtime.test.ts` covers the other half on
  real workerd — *"pushes a generated name to a participant who never opened the
  work stream"* runs the naming statement through the runtime port and asserts the
  frame that arrives on a second member's workspace socket, with no work-stream
  room socket anywhere in the test. It carries the icon too, because that
  participant has no room socket and the projection is their only path to the
  glyph as well as the name. Break it by removing `workstreams` from the
  `affectsDirectory` pattern in `workstream-runtime-sql.ts`; it then times out
  waiting for a push that is never enqueued. Break the icon half by dropping the
  `appearance_json` value from `rename`'s `UPDATE`, and the pushed row arrives
  with no appearance.
- `apps/desktop/src/renderer/lib/use-workstream-socket.test.tsx` covers the
  delivery half — *"shows the name Rally gives a work stream in its header and
  its sidebar row"* asserts the icon reaches the sidebar row with the name **and
  that the cached detail is left without an appearance**, which is the guard on
  the picker-preview rule above. Break it by writing the detail as well, through
  `patchCachedWorkstream`, and the `not.toHaveProperty('appearance')` assertion
  fails. *"leaves an icon a person already chose alone when a naming event
  arrives after it"* covers the other condition; break it by dropping
  `!row.appearance?.icon` from `patchCachedGeneratedIcon`.
- `apps/desktop/src/renderer/components/sidebar.test.tsx` and
  `screens/workstream.test.tsx` cover the two surfaces of `useNamingSkeleton`,
  each with a row inside the grace and one past it. The rule is a function of
  `createdAt`, and both files' fixtures carry dates older than the grace, so a
  naming case has to supply its own: the inside-the-grace tests build one from
  the current clock, and the past-the-grace tests take fake timers, set the system
  clock to the creation instant, and advance past it. A naming fixture left on the
  file's hard-coded date asserts nothing.

## Changelog

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
