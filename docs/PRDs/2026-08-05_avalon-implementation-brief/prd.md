# Rally implementation brief

> Created 2026-08-05.
>
> The product contract for Rally as a whole — what a Canvas and a Sidekick are, what the
> agent may do, and what the prototype must deliver. Unlike a per-change PRD,
> this one stays current: it is the document every other document defers to on
> what Rally *is*, and it is edited when the contract itself changes. The
> phased build against it was the prototype's implementation checklist, retired
> on 2026-11-08 (see [`architecture.md`](../../architecture.md#changelog)).
>
> Conventions for this folder: [`../../prds.md`](../../prds.md).

Rally is an AI-native workplace for doing work with Rally and with shared AI agents, organized around two shared homes rather than direct messages, search, or a global inbox: Canvases, where people and Rally make things together, and Sidekicks, the agents people share. Its visible hierarchy is Organizations, then the Canvases and Sidekicks inside them.

## Product contract

> Rewritten on 2026-11-07 for
> [Canvases and Sidekicks](../2026-11-06_canvases-and-sidekicks/prd.md), which
> replaces Channels, Threads and Breakouts with Canvases and Sidekicks; that
> PRD's "Impact on the product contract" section and decision log are the
> reasoning.

- A Canvas is the shared home for work: a conversation with Rally that produces artifacts of any kind (documents, spreadsheets, images, PDFs, archives and live sites), shown beside the conversation, each with its own versions. A Canvas is identified by its conversation and starts with no artifact; Rally changes an artifact by publishing a new version, attributed to Rally.
- A Canvas has its own audience: its creator only by default, then the people added to it, or the whole Organization, and guests can be invited to it. Its creator and the Organization's owners and administrators manage that audience, and owners and administrators can open every Canvas. Everyone in a Canvas sees who else is in it now, pins it in their own list, and comments on its artifacts through annotations that arrive in the Canvas's conversation.
- A Sidekick is the shared home for an agent: a versioned definition with one shared conversation that everyone it is shared with (its author, named people, or the Organization) can join. A message addressed to the Sidekick starts a run under its definition, which acts as the requester when they are not one of its delegates; a tool that would need a delegate is then refused with a named reason. Its managers edit the Sidekick in the same conversation through an explicitly marked wizard edit; nothing infers an edit from the text. Each run appears in the conversation as a row carrying its reply.
- A Canvas a Sidekick writes admits the Sidekick's audience as it stands, read live from the Sidekick, plus whoever is added to the Canvas itself.
- Rally is inherent in every Canvas's conversation. It is never shown as a removable participant.
- Viewing does not create participation. Creating, posting, answering an elicitation, or being explicitly added does. An impersonation-aware surface may perform a participant action under an active workspace-scoped **can impersonate** relationship while retaining audit attribution to the initiating operator. The relationship is independent of demo status; the surface still applies the represented participant's ordinary authorization and availability rules.
- Every run is a child of its Sidekick's shared conversation. A scheduled run is admitted at its due time; Rally does not pre-open a run merely because a future occurrence exists.
- Rally has no Channels, Threads, Breakouts, Activity feed, routing suggestions or digests. Connected activities either trigger Sidekick work or enrich an explicitly watched resource, nothing else; Rally has no feed of connector activity.
- Structured elicitation appears in a Canvas's conversation and in a Sidekick's conversation.
- The agent uses typed, authorized tools. An ordinary run may load
  the Terminal plugin and execute bounded file/command operations inside one
  isolated, authority-fenced, organization-network-policy-governed sandbox when
  code is useful. Rally still exposes no user-visible terminal, host shell,
  PTY, background service runtime, or user-authored workflow runtime.
- Ordinary authorized external writes execute without a global approval gate, but every attempt is idempotent, visible, and audited.

## Required prototype outcomes

The prototype provides a secure Electron shell; configured deployment signup routing; Google identity and separately scoped connector authorization; persistent Canvases, Sidekicks, participants, messages, resources, and activities; live collaboration; OpenRouter streaming and tool execution; structured elicitation; dynamic scheduling; and Google, GitHub App, Linear, Notion, signed-webhook, and Firecrawl web-tool paths.

The visual language is a dense, quiet, dark work surface inspired by Codex and Claude Code: text-forward navigation, a readable shared transcript, a restrained bottom composer, compact status dots, and a contextual 320–380px right rail.

The full source specification remains the authority for detailed behavior. This document captures the implementation contract used by this repository.
