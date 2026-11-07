# Which lines of a markdown string are code

Five rewriters in this repository take a model's markdown, change something in
it, and hand it on: the citation reduction that outbound email and Slack send,
the TeX repair every surface applies on the way to a reader, the email
renderer's block parser, its plain-text alternative, and the desktop's
streaming splitter. Every one of them has to recognise code, because a model
*showing* somebody markdown syntax — how to write a citation, what a
`$\rightarrow$` looks like — puts it in a code block, and a rewriter that edits
one deletes the very thing being shown.

`@rally/contracts/markdown-code` is the one place that question is answered. It
is not a markdown parser and never becomes one: it walks the lines of a
document and says of each whether a rewriter may touch it.

Read this before adding a rewriter that has to skip code, and before changing
what opens or closes a block — that rule is shared, and the surfaces it is
wrong for are not the ones whose tests you will be running.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/markdown-code.ts` | The rule: `markdownLineKinds`, `isMarkdownCode`, `mapMarkdownProse`. Exported as `@rally/contracts/markdown-code`. |
| `packages/contracts/src/markdown-code.test.ts` | The rule stated directly — what opens a block, what closes one, and what a transform is handed. |

The readers, each of which used to carry its own answer:

| Reader | Call site | What it reads |
| --- | --- | --- |
| The footnote grammar | `contracts/src/citations.ts` (`citationFootnotes`) | Every kind of code |
| The definition strip | `contracts/src/citations.ts` (`stripFootnoteDefinitions`) | Every kind of code |
| The citation reduction | `contracts/src/citations.ts` (`mapOutsideCode`) | Every kind of code |
| The TeX repair | `contracts/src/model-markdown.ts` (`normalizeModelMarkdown`) | Every kind of code |
| The email block parser | `api/src/services/email-markdown.ts` (`blocksFromMarkdown`) | Fenced blocks only |
| The email plain-text part | `api/src/services/email-markdown.ts` (`markdownToEmailText`) | Fenced blocks only |
| The streaming splitter | `desktop/renderer/components/workstream-blocks.tsx` (`splitStreamingMarkdown`) | Fenced blocks only |

The split in that last column is deliberate, and the [boundary](#boundary) says
why: the first four are *rewriters*, which must not touch code of any kind; the
last three are *structural*, and to them a fence is a block boundary while an
indented chunk is not.

## How it works

`markdownLineKinds(lines)` classifies every line of a document, in order, as
`prose`, `fence-open`, `fence-content`, `fence-close` or `indented-code`.
`isMarkdownCode(kind)` is `kind !== "prose"`. It takes the whole document
because both constructs are stateful: a fence runs until its closer, and an
indented block depends on whether a paragraph was open above it.

The delimiters are code, not prose. Reading one as prose puts a rewrite inside
the one line that proves the block was there.

**A fenced block** opens on up to three spaces of indent and a run of three or
more backticks or tildes, and closes on **any run of the opener's own character
at least as long, whatever follows it**. That is looser than CommonMark, which
wants a closer's rest-of-line bare, and it is the module's one deliberate
divergence. Reaching the difference means writing ```` ```more ```` inside a
block opened by a run of the same length, and erring loose keeps the delimiter
on the code side of the split, so the failure is a line left alone rather than a
line rewritten. The length test is what keeps the common case right: a
```` ```` ````-fenced sample containing a ```` ``` ```` block, which is how
anything in this repository shows somebody a code block, stays one block.

**An indented block** opens on four spaces or a tab and runs until a line
returns to the margin; a blank line inside it does not end it. The rule that
keeps this from going too far is that an indented chunk **cannot interrupt a
paragraph**, so a lazily-indented continuation line is prose and is still
rewritten. Without that half, a wrapped sentence someone happened to indent
reads as code and a real `resource://` target leaves Rally in an email — worse
than the bug the indented rule fixes.

`mapMarkdownProse(value, transform)` is the classifier applied to a whole
string: consecutive prose lines are handed to `transform` as one **maximal
run**, code lines come back exactly as written, and line endings are never
normalized. A rewriter that works a line at a time splits the run itself; one
that reads across a line break — the TeX repair's `\[…\]` — gets a whole run.

## Invariants

- **A delimiter line is code.** `fence-open` and `fence-close` are not `prose`.
  A reader that treats them as prose rewrites inside a fence marker, and the
  block it was trying to protect is the thing it damages.
- **`mapMarkdownProse` with an identity transform returns its input byte for
  byte**, trailing newline and CRLF endings included. `rewriteCitationsAsPlainText`
  promises a document containing no citations comes back unchanged, and this is
  where that promise is kept — a normalization added here breaks it at a
  distance, in a delivered email, with nothing failing locally.
- **The paragraph rule travels with the indent rule.** They are one decision.
  Recognising four-space indentation as code without it turns every lazily
  indented continuation line into code, which fails in the direction that leaks
  raw syntax to a reader rather than the direction that leaves text alone.
- **The close rule is loose on purpose.** Tightening it to CommonMark is a
  change to every reader here, not a correctness fix, and the reasoning above is
  what has to be argued against first.

## Boundary

This module owns *which lines* of a markdown document are code. It owns nothing
else about markdown.

**It does not own inline code spans.** The two rewriters that skip them want
different mechanics for the same idea: `citations.ts` *parks* a span behind a
placeholder so its line survives as a line, while `model-markdown.ts` *splits*
prose at one. Their patterns differ too — a single-backtick single-line span
against a matched run of any length — and narrowing either to match the other
changes what each rewrites. Whole lines are this module's business; a span
inside one is not.

**Three readers deliberately act on the fence kinds only.** The email renderer's
two passes and the desktop's streaming splitter are structural rather than
rewriting: they are deciding where a *block* starts and ends, and a fence is
such a boundary while an indented chunk is not — the email renderer already
gives an indented chunk a paragraph, and the splitter's
`CONTINUES_ACROSS_BLANK` already refuses to cut before an indented line. They
read one shared answer about fences rather than three private ones; that they
ignore `indented-code` is a statement about their job, not a second opinion
about what code is.

**It does not own the Slack chunker's fence tracking**
(`packages/connectors/src/slack-markdown.ts`, `nextFenceState`), which is
deliberately not a reader here. That code splits a message at Slack's block
limit and has to *reopen* the block in the next chunk, so it keeps the opening
line rather than the marker; and it closes only on a **bare** run — the strict
reading — because a fence it wrongly believes closed severs a code block in a
message that has already been delivered, where nothing heals it. Loosening it to
this module's rule would trade a rendering artifact for a delivery defect.
[`slack-integration.md`](slack-integration.md) owns that decision.

It does not own what any reader does with the answer:
[`markdown-rendering.md`](markdown-rendering.md) owns the desktop renderer and
its streaming splitter, [`model-text-normalization.md`](model-text-normalization.md)
the TeX repair, and `digests.md` (retired) the email renderer. The citation
protocol that `citations.ts` holds is
[`markdown-rendering.md`](markdown-rendering.md)'s too.

It is not a sanitizer. Everything it reads is untrusted text, and nothing it
returns is trusted — it decides what a rewriter may touch, never what is safe to
emit. [`security.md`](security.md) owns the trust model.

## Failure modes and limits

- **An unterminated fence swallows the rest of the document.** Everything after
  it is `fence-content`, forever. This is what the parsers downstream do too,
  and it fails toward leaving text alone.
- **A same-length nested fence closes the outer block.** The documented cost of
  the loose close rule, above. `````` ````…``` ```` `````` is the spelling that
  works.
- **A fence indented four columns or opened with a tab is not a fence** — it is
  an *indented block*, which is what CommonMark says too, so its contents are
  still code and still left alone. Some readers used to accept `[ \t]*` or
  `\s{0,3}` there and treated the lines beneath as a fenced block instead; the
  classification changed, the protection did not.
- **A list item's indented continuation is code to this module.** Four columns
  under a bullet is a paragraph of that item to a real parser and an indented
  block here. Telling the two apart needs the container context only a markdown
  parser has, which this deliberately is not. The paragraph rule keeps the
  common case — a continuation directly under the item's own text — as prose.
- **It is O(lines) and allocates one array per call.** `mapMarkdownProse` builds
  the runs it joins, so peak memory is roughly the input again. Every caller is
  already holding the whole document.

## Testing

```bash
pnpm --filter @rally/contracts exec vitest run src/markdown-code.test.ts
```

The rule is stated directly there — `kinds()` renders a document as the list of
line kinds, so a close test reads as the sequence it produces rather than as an
assertion about a rewrite three layers away. The readers' own suites are what
prove the rule is wired up correctly, and they are the ones that fail when it
changes:

```bash
pnpm --filter @rally/contracts exec vitest run src/citations.test.ts src/model-markdown.test.ts
pnpm --filter @rally/api exec vitest run test/email-markdown.test.ts
pnpm --filter @rally/desktop exec vitest run src/renderer/components/workstream-blocks.test.tsx
```

### 2026-08-28 — Created, so the classifier `citations.ts` grew is the one everybody reads

**What changed:** `codeLines` — the fenced-and-indented classifier that
`citations.ts` had just been given, and which its three passes shared — moved
into `@rally/contracts/markdown-code` as `markdownLineKinds`, widened from
`boolean[]` to a line *kind* so a reader can tell a delimiter from a block's
contents. `mapMarkdownProse` came with it. Every other rewriter's private fence
tracking is gone: `model-markdown.ts`'s `CODE_OR_TEXT`, the email renderer's two
copies, and the desktop splitter's `FENCE_OPEN`/`FENCE_CLOSE` pair.

**Why:** collapsing the three copies *inside* `citations.ts` fixed the visible
half of the problem and left the shape of it — the classifier was private to one
module while four other rewriters still each had their own, and they did not
agree with one another. The citation reduction and the email renderer run back
to back on the *same string*, so a disagreement between those two shows up as a
code sample rewritten in somebody's inbox while the prose beside it was not,
with nothing failing anywhere. Sharing the answer is what makes that class of
bug impossible rather than merely fixed once.

The kind, rather than a boolean, is what let the structural readers join. The
email block parser has to drop a fence's delimiters and keep its contents, and
the splitter has to know a block opened; neither can do that from "this line is
code". The same widening is why those three read only the fence kinds — see the
[boundary](#boundary).

What converging cost was measured rather than assumed. Each reader was run
against a vendored copy of its own pre-change implementation over a corpus of
every ordered combination of fence spellings, indented lines and prose
fragments, and the differences were classified:

| Reader | Documents | Differences |
| --- | --- | --- |
| `rewriteCitationsAsPlainText` | 15,625 | **none** — byte-identical, which is the point: the classifier moved, it did not change |
| `normalizeModelMarkdown` | 15,625 | 1,974, of which 1,082 are it *gaining* indented-code awareness; the rest are the fence rule (closer of the other character, closer not reaching the opener's length, delimiter indented four columns or by a tab) |
| `markdownToEmailHtml` / `markdownToEmailText` | 5,832 | 2,109, all of the same fence causes |
| `splitStreamingMarkdown` | 104,976 | 195, all of one cause: a closer carrying an info string |

No difference fell outside those causes.

The largest single group is a **fix**. `model-text-normalization.md` has carried
"an indented code block is not recognised… TeX inside one is rewritten" as a
known failure mode since the module was written; reading the shared classifier
closes it, for the same reason `citations.ts` wanted it — a model shows this
syntax in an indented block as readily as in a fence.

The shared close rule is the **citations** copy's, not the majority's, and that
was a choice between two defensible readings. `model-markdown.ts` and the email
parser accepted a closer of either character or any length; the desktop splitter
and the Slack chunker demanded a bare closer. The citations copy documented its
looseness and the safety argument for it — a line wrongly read as code is left
alone, never rewritten — so that is what the shared rule states.

An alternative existed and was read first: a competing implementation of the
same PRD (`packages/contracts/src/markdown-code.ts` on
`claude/prd-tdd-bdd-implementation-6hf8z4`) extracted `maskMarkdownCode` and
`mapMarkdownProse` from `model-markdown.ts`'s regex and pointed `citations.ts`
at them. It was not taken, for two reasons. It adopts `model-markdown.ts`'s
close rule, which silently drops the citation copy's documented looseness; and
its offset-preserving mask is not a faithful stand-in for a line classifier —
masking a fenced block to blank lines makes it indistinguishable from a real
blank line, and a blank line inside `citationFootnotes` continues a footnote
definition rather than ending it. Its length-preservation contract and the
astral-code-point trap behind it are real and worth keeping in mind if a mask is
ever wanted here; nothing needs one today.

**Consequences:** changing what opens or closes a block is now one edit with
seven readers, which is the point, and it is why the close rule and the
paragraph rule are written down as invariants rather than left in a regex. The
Slack chunker is deliberately outside this module and is the one place a private
copy still lives; its reasoning is in the boundary above, and collapsing it into
this rule would trade a transient rendering artifact for a severed code block in
a delivered message.

Shipped in the pull request that created this document.
