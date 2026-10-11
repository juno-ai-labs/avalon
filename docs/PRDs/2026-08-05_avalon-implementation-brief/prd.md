# Rally implementation brief

> Created 2026-08-05.
>
> The product contract for Rally as a whole — what a Channel and a Thread are, what the
> agent may do, and what the prototype must deliver. Unlike a per-change PRD,
> this one stays current: it is the document every other document defers to on
> what Rally *is*, and it is edited when the contract itself changes. The
> phased build against it is
> [`../../implementation-plan.md`](../../implementation-plan.md).
>
> Conventions for this folder: [`../../prds.md`](../../prds.md).

Rally is an AI-native workplace communication and execution environment organized around Channels and the Threads inside them, the durable homes work actually happens in, rather than direct messages, search, or a global inbox. Its visible hierarchy is Organizations, Channels, Threads, and Breakouts; a Space level above Channels exists in the model but is not shown.

## Product contract

- A Thread is the durable, multiplayer home for a task, investigation, deliverable, client engagement, or automation run, and the conversation Rally participates and acts in.
- A Channel is a stable, named list of Threads for an ongoing area of work, Organization-wide or private to its members. It holds no conversation, runs no inference, and grants no access to its Threads; each Thread keeps its own audience. Every non-deleted Thread belongs to at least one Channel, one Thread may sit in several Channels at once, and a person starts a Thread from a Channel's composer.
- A Breakout is a private or shared conversation inside a Thread, carrying that Thread's context without widening its audience. Breakouts do not nest.
- Rally is inherent in every Thread. It is never shown as a removable participant.
- Viewing does not create participation. Creating, posting, answering an elicitation, or being explicitly added does. An impersonation-aware surface may perform a participant action under an active workspace-scoped **can impersonate** relationship while retaining audit attribution to the initiating operator. The relationship is independent of demo status; the surface still applies the represented participant's ordinary authorization and availability rules.
- Every admitted automation run owns exactly one Thread. A scheduled run is admitted and creates that Thread at its due time; Rally does not pre-open a planned Thread merely because a future occurrence exists.
- Automations are versioned templates plus scoped subscriptions. Active subscriptions share one sidebar list and carry `You` or `Organization` badges.
- Connected activities either trigger deterministic automation work, enrich an explicitly watched resource, or appear as an in-stream routing suggestion. Rally has no feed of connector activity. Its one cross-thread feed, Activity, lists events about the viewer (being added, mentions, new Breakouts, finished runs, new Threads in their Channels), each opening the Thread it names; it has no reply or triage of its own.
- The agent uses typed, authorized tools. An ordinary Thread run may load
  the Terminal plugin and execute bounded file/command operations inside one
  isolated, authority-fenced, organization-network-policy-governed sandbox when
  code is useful. Rally still exposes no user-visible terminal, host shell,
  PTY, background service runtime, or user-authored workflow runtime.
- Ordinary authorized external writes execute without a global approval gate, but every attempt is idempotent, visible, and audited.

## Required prototype outcomes

The prototype provides a secure Electron shell; configured deployment signup routing; Google identity and separately scoped connector authorization; persistent Channels, Threads, participants, messages, resources, automations, and activities; live collaboration; OpenRouter streaming and tool execution; structured elicitation; dynamic scheduling; Google, GitHub App, Linear, Notion, signed-webhook, and Firecrawl web-tool paths; and contextual activity routing.

The visual language is a dense, quiet, dark work surface inspired by Codex and Claude Code: text-forward navigation, a readable shared transcript, a restrained bottom composer, compact status dots, and a contextual 320–380px right rail.

The full source specification remains the authority for detailed behavior. This document captures the implementation contract used by this repository.
