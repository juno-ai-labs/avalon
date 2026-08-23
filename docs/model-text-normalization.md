# Repairing model text on the way to a reader

Every model Avalon routes to writes Markdown, and several of them reach for TeX
when they want a symbol. `Backlog $\rightarrow$ In progress` is what a person
sees, because nothing downstream renders TeX: not the desktop's Markdown
renderer, not the digest email, not Slack. The delimiters and the command name
are shown verbatim, and a reader has no way to tell them from something Avalon
meant to write.

This module is the repair. It is one pure function pair in `@avalon/contracts`,
called by every surface that shows a model's words, that maps the closed set of
TeX commands appearing in work prose onto the Unicode characters the model meant
and leaves everything else exactly as written. [The prompt half](#the-other-half)
tells models not to produce it in the first place; this half is what happens when
they do anyway.

Read this before adding a surface that displays model-written text, before
widening what counts as math, and before moving where either function is called.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/model-markdown.ts` | `normalizeModelMarkdown` and `normalizeModelText`, the command table, and the rules deciding what is math. Exported as `@avalon/contracts/model-markdown`. |
| `packages/contracts/src/model-markdown.test.ts` | The behavioural suite, including the cases that must *not* be rewritten. |
| `packages/agent-harness/src/prompts/response-formatting.ts` | `RESPONSE_FORMATTING_POLICY`, the prompt section that asks for none of this to be necessary. |

The call sites, each on the path from stored text to a reader:

| Surface | Call site | Entry point |
| --- | --- | --- |
| Every Markdown surface in the desktop client | `renderer/components/workstream-blocks.tsx` (`MarkdownBody`) | `normalizeModelMarkdown` |
| The digest email, HTML and plain-text alternative | `services/digest-email-content.ts` | `normalizeModelMarkdown` |
| An elicitation's question | `renderer/components/workstream-blocks.tsx` (`ElicitationPanel`) | `normalizeModelText` |
| A generated work-stream title | `services/workstream-naming-service.ts` (`normalizeGeneratedTitle`) | `normalizeModelText` |
| A generated work-stream description | `services/workstream-description-service.ts` (`judgeDescriptionProposal`) | `normalizeModelText` |

Slack is deliberately absent: its answers are posted as Markdown for Slack itself
to render, and [`slack-integration.md`](slack-integration.md) owns that.

## How it works

`normalizeModelMarkdown` splits its input into code and not-code, rewrites only
the not-code, and reassembles. Within a run of prose it does two passes: the
delimited one, which unwraps `$…$`, `$$…$$`, `\(…\)` and `\[…\]`, and the bare
one, which catches a command a model wrote with no delimiters at all.

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
second parser in the Electron bundle. Avalon's models are not writing
mathematics; they are writing arrows. Mapping arrows costs one file and no
dependency, and it is cheap to reverse if that ever stops being true.

## Invariants

- **Code is never rewritten.** A fenced block or an inline span may be showing
  TeX deliberately — a snippet, a regex, a shell line with a `$` in it — and a
  rewritten code sample is worse than the symptom this module exists to fix.
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
- **Both functions are idempotent.** Their output contains no TeX, so a surface
  that normalizes twice is not a bug. This matters because the digest email
  normalizes for HTML and again for the plain-text alternative.
- **The command table is a closed list.** A command outside it is shown as a
  word rather than guessed at. A wrong symbol reads as fact; a visible `ohm`
  reads as a gap, and only one of those gets reported.

## Boundary

This module owns the mapping from a model's TeX to characters, and nothing else.
It does not parse Markdown, style anything, or decide where text appears.

- How that Markdown becomes DOM in the desktop client is
  [`markdown-rendering.md`](markdown-rendering.md).
- How it becomes an email is [`digests.md`](digests.md).
- How it reaches Slack is [`slack-integration.md`](slack-integration.md).
- The prompt section it pairs with is `RESPONSE_FORMATTING_POLICY`, which lives
  beside the harness prompts; [`writing-prompts.md`](writing-prompts.md) is the
  house guide those prompts are written against.

It is not a sanitizer. Everything it handles is untrusted text, but nothing it
emits is trusted either — each surface escapes for its own output, and
`normalizeModelMarkdown`'s escaping is about Markdown's own syntax, not safety.
[`security.md`](security.md) owns the trust model.

### The other half

`RESPONSE_FORMATTING_POLICY` is a section in the work-stream system prompt, the
digest brief, and both meeting prompts. It states that surfaces render
GitHub-flavoured Markdown, that TeX and math delimiters are never to be written,
and that a backslash or dollar sign belongs in backticks.

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
- **A `$` opening one line and closing the next is not a span.** The inline
  pattern refuses a newline, so a price at the end of a line cannot pair with one
  on the next.
- **An unterminated fence swallows the rest of the text.** Everything after it is
  treated as code and left alone, which is what the Markdown parser downstream
  does too.
- **A connector label containing TeX would be rewritten.** Normalization runs
  over `MarkdownBody`'s output, links included. Channel and connector names do
  not contain backslashes in practice, and the alternative — a parser that knows
  which parts of the string are link syntax — is a second Markdown parser.

## Testing

```bash
pnpm --filter @avalon/contracts exec vitest run src/model-markdown.test.ts
pnpm --filter @avalon/api exec vitest run test/digest-email-content.test.ts
pnpm --filter @avalon/desktop exec vitest run src/renderer/components/workstream-blocks.test.tsx
```

The suite's centre of gravity is the cases that must **not** change: money, shell
variables, Markdown escapes, code spans, fenced blocks. Those are the assertions
that fail when someone widens `looksLikeMath`, and widening it is the most likely
future edit. A test that only proves `\rightarrow` becomes `→` would pass against
a function that eats every dollar sign in the product.

Both entry points are asserted against the same input where they differ, so the
escaping rule is visible as a difference rather than stated only in prose.

## Changelog

### 2026-08-22 — Created, because TeX was reaching readers on every surface

**What changed:** `normalizeModelMarkdown` and `normalizeModelText` in
`@avalon/contracts/model-markdown`, called from `MarkdownBody`, the digest email
renderer, the elicitation panel, and the two API services that generate a title
and a description. `RESPONSE_FORMATTING_POLICY` was added to the work-stream
system prompt, the digest brief, and both meeting prompts.

**Why:** `$\rightarrow$` was being shown to people in work-stream turns. No
surface has ever rendered TeX, and several routed models emit it for symbols, so
this was not a bug in one renderer — it was a gap between what models write and
what every surface can display. Fixing it inside `MarkdownBody` alone would have
left the email and Slack, which is how the same repair ends up written three
times and drifting; a shared function in `contracts` is the only place all three
already depend on.

The rule that a span is math only if it contains a backslash was the decision
that took the most argument, and the reasoning is above under [what counts as
math](#what-counts-as-math). KaTeX was considered and rejected for the reasons in
the section below it. Both are recorded because both will look like obvious
improvements to someone who has not hit the currency case.

**Consequences:** A surface that shows model text now has to pick an entry point,
and picking the wrong one fails visibly — a backslash in a title, or an
italicized half-line in a paragraph. The ordering constraint against mention
offsets is real and silent if broken; it is stated as an invariant and the
comment at the call site points here. Widening `looksLikeMath` is the edit most
likely to be attempted next, and the tests are arranged so that doing it
carelessly breaks the money and environment-variable cases first.
