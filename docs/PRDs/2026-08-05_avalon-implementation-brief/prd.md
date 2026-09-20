# Rally implementation brief

> Created 2026-08-05.
>
> The product contract for Rally as a whole — what a Channel is, what the
> agent may do, and what the prototype must deliver. Unlike a per-change PRD,
> this one stays current: it is the document every other document defers to on
> what Rally *is*, and it is edited when the contract itself changes. The
> phased build against it is
> [`../../implementation-plan.md`](../../implementation-plan.md).
>
> Conventions for this folder: [`../../prds.md`](../../prds.md).

Rally is an AI-native workplace communication and execution environment organized around concrete Channels — the durable homes work actually happens in — rather than direct messages, search, or a global inbox. Its visible hierarchy is Organizations, Spaces, Channels, and Breakouts.

## Product contract

- A Channel is the durable, multiplayer home for a task, investigation, deliverable, client engagement, or automation run, and the conversation Rally participates and acts in.
- Every non-deleted Channel belongs to at least one Space, and one Channel may appear in several Spaces at once. A Space is an organizational and inheritance surface — audience, resources, and Sidekicks — not a conversation of its own.
- A Breakout is a private or shared conversation inside a Channel, carrying that Channel's context without widening its audience.
- Rally is inherent in every Channel. It is never shown as a removable participant.
- Viewing does not create participation. Creating, posting, answering an elicitation, or being explicitly added does. A participant action may be performed under an approved represented-user delegation while retaining attribution to the initiating operator. The first such surface, the internal demo messaging sidecar, is restricted to authenticated users with verified `@rallywith.ai` emails in eligible demo Organizations; it permits no impersonated messaging in regular Organizations.
- Every admitted automation run owns exactly one Channel. A scheduled run is admitted and creates that Channel at its due time; Rally does not pre-open a planned Channel merely because a future occurrence exists.
- Automations are versioned templates plus scoped subscriptions. Active subscriptions share one sidebar list and carry `You` or `Organization` badges.
- Connected activities either trigger deterministic automation work, enrich an explicitly watched resource, or appear as an in-stream routing suggestion. Rally has no global activity feed.
- The agent uses typed, authorized tools. An ordinary Channel run may load
  the Terminal plugin and execute bounded file/command operations inside one
  isolated, authority-fenced, organization-network-policy-governed sandbox when
  code is useful. Rally still exposes no user-visible terminal, host shell,
  PTY, background service runtime, or user-authored workflow runtime.
- Ordinary authorized external writes execute without a global approval gate, but every attempt is idempotent, visible, and audited.

## Required prototype outcomes

The prototype provides a secure Electron shell; configured deployment signup routing; Google identity and separately scoped connector authorization; persistent Channels, Spaces, participants, messages, resources, automations, and activities; live collaboration; OpenRouter streaming and tool execution; structured elicitation; dynamic scheduling; Google, GitHub App, Linear, Notion, signed-webhook, and Firecrawl web-tool paths; and contextual activity routing.

The visual language is a dense, quiet, dark work surface inspired by Codex and Claude Code: text-forward navigation, a readable shared transcript, a restrained bottom composer, compact status dots, and a contextual 320–380px right rail.

The full source specification remains the authority for detailed behavior. This document captures the implementation contract used by this repository.
