# Build plan

> Companion to [`prd.md`](./prd.md). Four phases, each with an acceptance gate.
> Phases 1 and 2 are independently shippable and deliver the two visible defects;
> 3 and 4 build on 2.

Every phase leaves `pnpm lint` (zero warnings), `pnpm typecheck`, and `pnpm test`
green, and updates [`slack-integration.md`](../../slack-integration.md) in the
same change as the code.

## Phase 1 — Agent output renders as formatted text

Fixes the visible defect first, because it is independent of the reaction work
and affects every delivery path.

- Add a Slack markdown-rendering helper: agent text in, `markdown` block plus
  plain-text notification fallback out, split at 12,000 characters preferring
  paragraph then line boundaries.
- Route `postSlackTextChunks`
  (`apps/api/src/services/slack-agent-service.ts:2937`) through it, replacing
  the raw `text:` post and the 40,000-character split.
- Give `deliverAutomationResult` (`:1211`) a `header` block for its title
  instead of prefixing the title to the body text.
- Give `deliverDigest` (`:1283`) the same treatment.
- Confirm the streaming path (`:1120`) needs no change — it already passes
  `markdown_text` — and that both paths now produce the same rendering.

**Gate:** a result containing a heading, list, table, and fenced code block
renders as formatted content on the fallback path; a streamed and a fallback
delivery of the same content render identically; existing Slack suites pass.

## Phase 2 — The reaction resolves

Delivers goals 1 and 3 without the rotation, so the stuck-👀 defect is fixed even
if phase 3 slips.

- Replace `SLACK_AGENT_ACKNOWLEDGEMENT_REACTION`
  (`packages/connectors/src/slack.ts:545`) with a reaction-set module: the
  acknowledgement, the working rotation, and the outcome map from the PRD.
- Widen `SlackAgentAcknowledgementCommandSchema` (`:546`) from `z.literal` to a
  validated emoji name, and generalize the command to carry an add, a remove, or
  a swap.
- Add `reactions.remove` to the Slack API contract map (beside `reactions.add`
  at `:766`), treating `no_reaction` as an idempotent success as
  `already_reacted` already is for add.
- Record the reaction Rally last placed on a session's source message, so a
  transition removes its own emoji and never a member's.
- Apply the outcome reaction in `deliverWorkstreamOutcome` (`:1092`) from the
  `outcomeStatus` it already carries.

**Gate:** a finished run leaves exactly one reaction, matching its outcome; a
member's own reaction on the same message survives; a run whose reaction calls
all fail still completes and still delivers.

## Phase 3 — The working reaction rotates

Delivers goal 2.

- Add a `SlackReactionTicker` Durable Object holding the session key, the
  rotation cursor, and the last-placed reaction, with an alarm-driven advance.
- Bind it in `apps/api/wrangler.global.jsonc` and `apps/api/wrangler.eu.jsonc`
  with a migration tag in both.
- Start it once the session is established; clear its alarm from the terminal
  transition in phase 2.
- Make the ticker fail safe: a lost or never-started ticker leaves the outcome
  reaction correct, because delivery remains the authority.

**Gate:** the reaction visibly changes during a live run; a run that ends while a
tick is in flight still finishes on the outcome reaction, not a working one; no
`slack_ingress_jobs` rows are written by the rotation.

## Phase 4 — Reaction sets are configurable

Delivers goal 6.

- Resolve reaction sets most-specific-wins: built-in defaults, then the
  workspace installation override on `connector_connections.config_json`, then
  the automation or work-stream override.
- Allow an override to replace any subset, inheriting the rest from the tier
  below.
- Fall back to the built-in default for a state whose configured emoji Slack
  rejects with `invalid_name`, once per use, logging the rejected name.

**Gate:** a workspace override changes the reactions on a run; a partial override
inherits the unnamed states; an override naming a nonexistent emoji degrades to
the default without failing the run.

## Cross-cutting

- **Documentation.** [`slack-integration.md`](../../slack-integration.md) owns
  this area: the prompt sequence under *Agent sessions and delivery*, the
  reaction paragraph under *Ingress and routing*, and the `eyes` invariant all
  describe behavior this change moves. Update them with the phase that makes
  each true, and append a changelog entry recording why.
- **Acceptance.** The seven checks in the PRD land in
  [`e2e.md`](../../e2e.md); Slack cannot be driven from the sandbox, so the
  reaction lifecycle and the rendered blocks are verified structurally in tests
  and confirmed against a real workspace during the Slack acceptance pass.
- **Decision log.** Append to the PRD in the same change as any decision that
  moves scope, behavior, or the contract.
