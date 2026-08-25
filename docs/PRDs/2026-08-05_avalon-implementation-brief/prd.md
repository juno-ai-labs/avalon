# Rally implementation brief

> Created 2026-08-05.
>
> The product contract for Rally as a whole — what a work stream is, what the
> agent may do, and what the prototype must deliver. Unlike a per-change PRD,
> this one stays current: it is the document every other document defers to on
> what Rally *is*, and it is edited when the contract itself changes. The
> phased build against it is
> [`../../implementation-plan.md`](../../implementation-plan.md).
>
> Conventions for this folder: [`../../prds.md`](../../prds.md).

Rally is an AI-native workplace communication and execution environment organized around concrete work streams rather than channels, direct messages, search, or a global inbox.

## Product contract

- A work stream is the durable, multiplayer home for a task, investigation, deliverable, client engagement, or automation run.
- Rally is inherent in every work stream. It is never shown as a removable participant.
- Viewing does not create participation. Creating, posting, answering an elicitation, or being explicitly added does.
- Every automation run owns exactly one work stream, including a scheduled run opened before its start time.
- Automations are versioned templates plus scoped subscriptions. Active subscriptions share one sidebar list and carry `You` or `Workspace` badges.
- Connected activities either trigger deterministic automation work, enrich an explicitly watched resource, or appear as an in-stream routing suggestion. Rally has no global activity feed.
- The agent uses typed, authorized tools. An ordinary work-stream run may load
  the Terminal plugin and execute bounded file/command operations inside one
  isolated, authority-fenced, workspace-network-policy-governed sandbox when
  code is useful. Rally still exposes no user-visible terminal, host shell,
  PTY, background service runtime, or user-authored workflow runtime.
- Ordinary authorized external writes execute without a global approval gate, but every attempt is idempotent, visible, and audited.

## Required prototype outcomes

The prototype provides a secure Electron shell; Global/EU signup routing; Google identity and separately scoped connector authorization; persistent work streams, participants, messages, resources, automations, and activities; live collaboration; OpenRouter streaming and tool execution; structured elicitation; dynamic scheduling; Google, GitHub App, Linear, Notion, signed-webhook, and Firecrawl web-tool paths; and contextual activity routing.

The visual language is a dense, quiet, dark work surface inspired by Codex and Claude Code: text-forward navigation, a readable shared transcript, a restrained bottom composer, compact status dots, and a contextual 320–380px right rail.

The full source specification remains the authority for detailed behavior. This document captures the implementation contract used by this repository.
