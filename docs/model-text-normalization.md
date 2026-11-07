# Repairing model text on the way to a reader

Every model Rally routes to writes Markdown, and several of them reach for TeX
when they want a symbol. `Backlog $\rightarrow$ In progress` is what a person
sees, because nothing downstream renders TeX: not the desktop's Markdown
renderer, not the digest email, not Slack. The delimiters and the command name
are shown verbatim, and a reader has no way to tell them from something Rally
meant to write.

This module is the repair. It is one pure function pair in `@rally/contracts`,
called by the surfaces listed below on the way to a reader, that maps the closed
set of TeX commands appearing in work prose onto the Unicode characters the
model meant and leaves everything else exactly as written. [The prompt
half](#the-other-half) tells models not to produce it in the first place; this
half is what happens when they do anyway.

Read this before adding a surface that displays model-written text, before
widening what counts as math, and before moving where either function is called.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/model-markdown.ts` | `normalizeModelMarkdown` and `normalizeModelText`, the command table, and the rules deciding what is math. Exported as `@rally/contracts/model-markdown`. |
| `packages/contracts/src/markdown-code.ts` | Which lines are code — the rule this module reads rather than states. See [`markdown-code.md`](markdown-code.md). |
| `packages/contracts/src/model-markdown.test.ts` | The behavioural suite, including the cases that must *not* be rewritten. |
| `packages/agent-harness/src/prompts/response-formatting.ts` | `RESPONSE_FORMATTING_POLICY`, the prompt section that asks for none of this to be necessary. |

The call sites, each on the path from stored text to a reader:

| Surface | Call site | Entry point |
| --- | --- | --- |
| Markdown surfaces in the desktop client | `renderer/components/workstream-blocks.tsx` (`MarkdownBody`) | `normalizeModelMarkdown` |
| Every Rally email's HTML body — the digest, an automation's result | `services/email-markdown.ts` (`markdownToEmailHtml`) | `normalizeModelMarkdown` |
| Every Rally email's plain-text alternative and preheader | `services/email-markdown.ts` (`markdownToEmailText`, `markdownToEmailPreheader`) | `normalizeModelText` |
| An elicitation's question, option labels and descriptions, and answered label | `renderer/components/workstream-blocks.tsx` (`ElicitationPanel`, `elicitationAnswerLabel`) | `normalizeModelText` |
| A tool card's summary line | `renderer/components/workstream-blocks.tsx` | `normalizeModelText` |
| A message export's file name | `renderer/components/workstream-blocks.tsx` | `normalizeModelText` |

`MarkdownBody` repairs by default and skips the repair when its caller marks
the text `verbatim` — a person's own message bubble and the attachment
lightbox's document preview do, because what a member typed and the bytes of a
file they attached are not a model's words to fix.

Slack is absent: its delivery paths post Markdown for Slack itself to render,
and Slack renders no TeX either, so a model's `$\rightarrow$` still reaches a
channel verbatim — see [failure modes](#failure-modes-and-limits) for why the
gap stands.

## How it works

`normalizeModelMarkdown` splits its input into code and not-code, rewrites only
the not-code, and reassembles. The split has two levels and only the inner one
belongs to this module: whole lines of code — fenced *and* indented blocks — are
[`markdown-code.ts`](markdown-code.md)'s answer, shared with every other
rewriter in the repository so none of them can disagree about where a block
ends, and inline code spans are this module's own, a run of backticks closed by
a run of the same length. Within a run of prose it does two passes: the
delimited one, which unwraps `$…$`, `$$…$$`, `\(…\)` and `\[…\]`, and the bare
one, which catches a command a model wrote with no delimiters at all. The bare
pass takes only a command standing as its own token — beginning after a space,
a bracket, or an orphaned `$`, and ending before space, closing punctuation,
or the end — because without that boundary `C:\to\dist` is a path with an
arrow in it and `\in-flight` a hyphenation with a set operator, and two call
sites store what this returns. The `\(…\)` and `\[…\]` forms additionally
demand a real `\command` in the body, not merely a punctuation escape: the
escaping step below writes `\[` and `\]` itself, and reading that back as
display math on a second pass would eat the brackets.

An unwrapped body is rendered by `texToPlainText`: transparent wrappers such as
`\text{…}` and `\operatorname{…}` lose their braces, known commands become their
character, TeX's punctuation escapes become the punctuation, and digit
sub- and superscripts become `₁` and `¹`. A command the table does not know
keeps its name without the backslash — `\ohm` becomes `ohm` — because a visible
stray backslash reads as corruption while a bare word reads as a word.

`normalizeModelText` is the same repair for a surface that renders no Markdown.
It differs in exactly two ways, both following from there being no parser
downstream: nothing is escaped, and code is not skipped. See
[the escaping invariant](#invariants) for why the first of those is not optional
on the Markdown side.

### What counts as math

**A delimited span is math only if it contains a backslash.** This is the whole
test, and it is the most consequential decision in the module.

The obvious alternative — treat `$…$` as math the way a TeX renderer does —
fails on the text this product actually carries. `Plans cost $50 and $70 per
seat` is a sentence about money, and `Set $DATABASE_URL and $API_KEY` is a
sentence about a shell. Both are ordinary in a work assistant; neither is
algebra; and a dollar-delimiter rule silently eats the dollar signs out of both.
Prices and environment variables are far more common here than mathematics, so
the rule is written to protect them and to accept the cost below.

The cost is that `$x^2$` and `$a_{key}$` — real math with no backslash in it —
are left alone and shown as written. That is a visible imperfection rather than a
wrong fact, which is the trade this module prefers in every case.

### Why a KaTeX dependency is not the answer

Rendering the TeX properly, with `remark-math` and `rehype-katex`, was rejected.
It carries the same ambiguity in a worse place: `remark-math` reads `$50 and $70`
as a math span, so the currency problem becomes a typeset formula rather than a
literal dollar sign, and it arrives with a stylesheet, a font payload, and a
second parser in the Electron bundle. Rally's models are not writing
mathematics; they are writing arrows. Mapping arrows costs one file and no
dependency, and it is cheap to reverse if that ever stops being true.

## Invariants

- **Code is never rewritten.** A fenced block, an indented block, or an inline
  span may be showing TeX deliberately — a snippet, a regex, a shell line with a
  `$` in it — and a rewritten code sample is worse than the symptom this module
  exists to fix. *Which lines* are a block is not decided here; see
  [`markdown-code.md`](markdown-code.md), whose close rule is deliberately loose
  and shared with the citation reduction and both email passes.
- **Unwrapped math is escaped before it re-enters Markdown.** What comes out of
  `texToPlainText` is literal text that a Markdown parser then reads. A subscript
  that mapped to a bare `_` would open an emphasis run and italicize the rest of
  the line. `normalizeModelMarkdown` escapes; `normalizeModelText` must not,
  because on a plain-text surface that escape is a backslash the reader sees.
  Adding a Markdown call site that renders its result as plain text, or the
  reverse, produces exactly one of those two failures.
- **Normalization runs after mention offsets are resolved.** `MessageMention`
  carries `startOffset` and `endOffset` measured against the *stored* text.
  Anything that changes the string's length invalidates them, so `MarkdownBody`
  calls `withConnectorMentionLinks` first and normalizes its output. Reversing
  the two silently attaches connector chips to the wrong words.
- **Stored text is never rewritten.** This is a display repair applied on the way
  out. The message a run reads back, exports, and hands to the next model is the
  one the model wrote. The two plain-text call sites in the API are the deliberate
  exceptions: a title and a description are short labels generated once, they
  carry no offsets, and every one of their many readers would otherwise have to
  repeat the repair.
- **Both functions are idempotent.** Their output contains no TeX the passes
  would touch again — the bracket forms refuse their own escaped output — so a
  string repaired once is not corrupted by a surface that repairs it again. A
  stored title is normalized at the write and may reach a display-time call
  site later; that path is why this is an invariant rather than a nicety.
- **The command table is a closed list.** A command outside it is shown as a
  word rather than guessed at. A wrong symbol reads as fact; a visible `ohm`
  reads as a gap, and only one of those gets reported.

## Boundary

This module owns the mapping from a model's TeX to characters, and nothing else.
It does not parse Markdown, style anything, or decide where text appears.

- How that Markdown becomes DOM in the desktop client is
  [`markdown-rendering.md`](markdown-rendering.md).
- How it becomes an email is `digests.md` (retired).
- How it reaches Slack is [`slack-integration.md`](slack-integration.md). No
  Slack path calls this module today; the gap and its reason are recorded
  under [failure modes](#failure-modes-and-limits) so neither document assumes
  the other owns the repair.
- The automation compiler's drafts are stored and re-rendered into future run
  prompts, but they are not repaired at the write: the overview screen shows
  them through `MarkdownBody`, which repairs at display, and a stored copy a
  model reads back is the prompt half's job to prevent. A future change that
  wants write-time repair there is changing that decision, not filling a gap.
- The prompt section it pairs with is `RESPONSE_FORMATTING_POLICY`, which lives
  beside the harness prompts; [`writing-prompts.md`](writing-prompts.md) is the
  house guide those prompts are written against.

It is not a sanitizer. Everything it handles is untrusted text, but nothing it
emits is trusted either — each surface escapes for its own output, and
`normalizeModelMarkdown`'s escaping is about Markdown's own syntax, not safety.
[`security.md`](security.md) owns the trust model.

### The other half

`RESPONSE_FORMATTING_POLICY` is a section in the work-stream system prompt —
which every work-stream run carries — and in both meeting
prompts. It states that written answers are GitHub-flavoured Markdown while an
elicitation's question is a plain-text label, that TeX and math delimiters are
never to be written, that a literal backslash belongs only in code formatting,
and that a dollar sign in ordinary prose is plain text. `prompts.test.ts` pins
the TeX line so a tidy-up cannot silently delete it.

A prompt is guidance, not a guarantee, which is why the repair exists at all. But
it is the only half that also fixes the copy of the text that is *stored* —
exported, quoted into a later run, read back by the next model — and so both
halves are kept.

## Failure modes and limits

- **Math with no backslash is left alone.** `$x^2$` renders as `$x^2$`. Stated
  above as the deliberate cost of the currency guard.
- **A display equation is flattened, not typeset.** `\[ \frac{a}{b} \]` has no
  fraction to become; `\frac` is not in the table, so it reads `frac a b`. Real
  mathematics is not something this module makes look good, and a model that
  needs to show one should use a fenced block.
- **Money and TeX in one sentence leaves stray delimiters.** The inline pass
  pairs the first two `$` it sees, so `Costs $50 and moves $\rightarrow$ done`
  becomes `Costs $50 and moves $→$ done` — the price ate the real span's
  opening delimiter, and the bare pass repaired what was left inside the
  orphaned pair. Pinned in the tests as a known artifact; it is the documented
  cost of the money rule, seen from its other side.
- **A `$` opening one line and closing the next is not a span.** The inline
  pattern refuses a newline, so a price at the end of a line cannot pair with one
  on the next. The explicit `\(…\)`/`\[…\]` delimiters have no such guard.
- **An unterminated fence swallows the rest of the text.** Everything after it is
  treated as code and left alone, which is what the Markdown parser downstream
  does too.
- **A fence closes only on its own character, at a length it reaches.** A
  ```` ``` ```` block used to close on a `~~~` line here and no longer does,
  since the shared rule replaced this module's own. The other direction is the
  same rule's documented looseness: a same-length nested fence closes the outer
  block. Both are in [`markdown-code.md`](markdown-code.md).
- **A list item's indented continuation is treated as code.** Since this module
  started reading the shared classifier it *does* recognise indented blocks, and
  four columns under a bullet is a paragraph of that item to a real parser and
  an indented block to the classifier — so TeX there is now left as written
  rather than repaired. That is the safe direction, and the trade is deliberate:
  telling the two apart needs the container context only a real Markdown parser
  has, which this module is not. The paragraph rule keeps the common case right;
  [`markdown-code.md`](markdown-code.md) has it.
- **A connector label containing TeX would be rewritten, and a mention inside a
  math span is flattened.** Normalization runs over `MarkdownBody`'s output,
  links included; a `$…$` span with a backslash command that also encloses a
  mention link unwraps the whole body, so the reader sees the escaped raw
  destination instead of a chip. It cannot become a live link — the escaping
  guarantees that — but it is loud. The alternative, a parser that knows which
  parts of the string are link syntax, is a second Markdown parser.
- **A streamed span flickers once.** While `$\rightarrow` has no closing
  delimiter it shows as written; the close arrives and the next render repairs
  it. An inline code span being typed reverses once the closing backtick
  lands — repaired, then shown as the code it turned out to be. Both are
  transient and strictly better than the raw TeX main showed forever.
- **Slack still shows the TeX.** No Slack delivery path calls this module: the
  non-streaming paths render through Slack's `markdown` block, whose handling
  of manufactured escapes has not been exercised against a live workspace, and
  the streaming path appends chunks, where a span can split across a chunk
  boundary and a per-chunk repair would tear it. Fixing it means one call site
  in `slackMarkdownMessages` once the escape behaviour is verified live, plus a
  decision about the streamed path.
- **A title generated before this shipped keeps its TeX.** The two stored
  surfaces repair at the write, with no backfill; an old sidebar row sits
  unrepaired above a transcript that now renders correctly. Regenerating the
  title is the remedy, and a backfill was judged not worth a migration for a
  cosmetic defect that ages out.

## Testing

```bash
pnpm --filter @rally/contracts exec vitest run src/model-markdown.test.ts
pnpm --filter @rally/api exec vitest run test/email-markdown.test.ts
pnpm --filter @rally/desktop exec vitest run src/renderer/components/workstream-blocks.test.tsx
```

The suite's centre of gravity is the cases that must **not** change: money, shell
variables, Markdown escapes, code spans, fenced blocks. Those are the assertions
that fail when someone widens `looksLikeMath`, and widening it is the most likely
future edit. A test that only proves `\rightarrow` becomes `→` would pass against
a function that eats every dollar sign in the product.

Both entry points are asserted against the same input where they differ, so the
escaping rule is visible as a difference rather than stated only in prose.

### 2026-08-28 — The code splitter moved out, and picked up indented blocks on the way

**What changed:** `CODE_OR_TEXT` — the single regex that recognised a fenced
block *and* an inline code span in one pass — is gone.
`normalizeModelMarkdown` now calls `mapMarkdownProse` from
`@rally/contracts/markdown-code` for the whole-line half and keeps a `CODE_SPAN`
pattern of its own for the span half. Nothing about what counts as math, what is
escaped, or what either entry point returns changed.

**Why:** this module's code splitter was one of five copies of the same
question, and they did not agree with each other. `citations.ts` had just
collapsed its own three onto a private classifier;
[`markdown-code.md`](markdown-code.md) records moving that classifier where the
rest of us can read it, and why the shared close rule is the citation copy's
rather than this one's.

**The headline consequence is a fix, not a cost.** The shared classifier knows
indented code blocks, so the failure mode this document carried from the
beginning — "an indented code block is not recognised… TeX inside one is
rewritten before the downstream parser renders it as code" — is closed. Measured
against a vendored copy of the old implementation over 15,625 documents, 1,082
of the 1,974 differences are exactly that: TeX under four spaces now left as
written. It replaces a narrower limit, listed above: an indented *continuation
of a list item* is now read as code too, which errs toward leaving text alone.

The rest of the differences are the fence rule converging: a block now closes
only on its own delimiter character (it closed a ```` ``` ```` block on a `~~~`
line), only on a run reaching the opener's length, and a delimiter indented four
columns or by a tab is an indented block rather than a fence — which changes the
classification and not the protection, since both are code.

Inline code spans deliberately stayed. The other rewriter that skips them parks
a span inside a line rather than splitting prose at one, and their patterns
differ — narrowing either to match would change what each rewrites. Splitting
lines first and spans second also means a backtick run opened in prose can no
longer swallow a fence line, which the single combined regex allowed.

**Consequences:** the code rule is no longer visible in this file, so a reader
asking why a sample was or was not rewritten has one more hop to make; the
pointer is in *How it works*, in the invariant, and beside `CODE_SPAN`. Changing
what closes a block is now a change to seven readers, and the shared document
says so.

### 2026-08-23 — Created, because TeX was reaching readers

**What changed:** `normalizeModelMarkdown` and `normalizeModelText` in
`@rally/contracts/model-markdown`, called from `MarkdownBody` (with a
`verbatim` opt-out for the human bubble and the attachment preview), the shared
email renderer on all three of its outputs — HTML, plain-text alternative, and
preheader, covering the digest and automation-result emails alike — the
elicitation panel's question, options and answered label, tool-card summaries,
the export file name, and the two API services that generate a title and a
description.
`RESPONSE_FORMATTING_POLICY` was added to the work-stream system prompt and
both meeting prompts.

**Why:** `$\rightarrow$` was being shown to people in work-stream turns. No
surface has ever rendered TeX, and several routed models emit it for symbols, so
this was not a bug in one renderer — it was a gap between what models write and
what every surface can display. Fixing it inside `MarkdownBody` alone would have
left the email and the label surfaces showing the same artifacts, which is how
the same repair ends up written several times and drifting; a shared function
in `contracts` is the one shared package all the consumers already depend on.

The rule that a span is math only if it contains a backslash was the decision
that took the most argument, and the reasoning is above under [what counts as
math](#what-counts-as-math). KaTeX was considered and rejected for the reasons in
the section below it. Both are recorded because both will look like obvious
improvements to someone who has not hit the currency case.

Review hardening in the same pull request: the bare pass gained its
standalone-token boundary after a run-verified review showed `C:\to\dist` and
`\in-flight` being rewritten — sharper on the two surfaces that store the
result; the `\(…\)`/`\[…\]` forms now demand a real command so the module's own
escaped output is not unwrapped a second time; `\lt`, `\gt` and the long
double-arrows joined the table; and brace pairs became separators so `\frac{a}{b}`
reads `frac a b` rather than `fracab`. Slack was in the original branch as a
`markdown_text` delivery commit and was dropped when main's #241 landed the
same rendering repair more thoroughly; the TeX gap it leaves is recorded under
failure modes rather than fixed blind against an unverifiable Slack behaviour.
The branch's enriched digest-local renderer met the same fate when the shared
`email-markdown.ts` landed on main mid-flight: the enrichment was dropped, and
the repair — normalization plus the escape-consuming pass its contract
requires — moved onto the shared renderer, where the automation result email
inherits it too; `digests.md`'s changelog carries that story.

**Consequences:** A surface that shows model text now has to pick an entry point,
and picking the wrong one fails visibly — a backslash in a title, or an
italicized half-line in a paragraph. The ordering constraint against mention
offsets is real and silent if broken; it is stated as an invariant and the
comment at the call site points here. Widening `looksLikeMath` is the edit most
likely to be attempted next, and the tests are arranged so that doing it
carelessly breaks the money and environment-variable cases first.

Shipped in #257.
