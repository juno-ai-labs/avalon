# Implementation review for the onboarding redesign

> 2026-09-05. Companion to [the expert redesign](redesign-proposal.md).
> This records current code versus proposed work. It does not claim the redesign is implemented.

The existing onboarding has the right persistence and execution boundaries, but its first-use content does not yet demonstrate Rally's durable, collaborative execution model. Preserve those boundaries while replacing the learning experience.

| Current implementation | Consequence | Required redesign work |
| --- | --- | --- |
| Three separate scenes: generic welcome, connector reads, floating task characters | Users can infer a bot collection rather than a shared place where work progresses | One continuous example with a goal, its source context, a saved result and a revision in the same work stream |
| Selected personal avatar is animated in the task handoff | User identity can be mistaken for agent configuration | Keep the Rally mark on AI activity and label the chosen personal avatar as You |
| Both starter buttons explicitly ask Rally to ask questions first | The first response can be more onboarding work, with no useful output | Collect rough notes and a desired deliverable, then visibly ask for a first draft with marked assumptions |
| Broad connector catalog precedes a specific use case | The person cannot judge which permission request helps their task | Recommend a connection only for the chosen source; preserve paste-only first use |
| Teammate discovery precedes the result | Asking for colleagues before showing value creates work and an invitation decision | Keep a clear solo path in the existing order; moving the invitation step after the result requires a deliberate new sequence |
| Guide completion checks only a completed latest harness run | A successful run may still contain only questions or an unhelpful answer | Distinguish execution completion, real artifact availability, user-confirmed usefulness and a follow-up revision |
| No hands-on child conversation or shared human contribution in the guide | Users can miss Rally’s private exploration and multiplayer work model | Add a real private substream exercise and an explicit teammate contribution path after the first draft |
| Stage transitions are enforced in WorkspaceDO, with presentation required before example | Reordering cannot be achieved by rearranging renderer screens | Update the durable transition contract, resume rules, service checks and real-workerd tests together |

## First useful result

The current harness already specifies document generation as a real published Markdown resource and same-path revision, with an inline fallback when the sandbox is unavailable (`docs/agent-harness.md`, Document generation policy). The first-use request can exercise that ordinary capability. A real draft shown inline remains useful but must not be represented as a saved file. Source links are only shown when the actual result provides them.

Keep the original first-message replay identity and immutable submitted prompt. A correction after submission is a normal follow-up in the same work stream, not a rewritten starter or a second hidden run. The user should see the exact request that is submitted, including the instruction to draft without sending messages externally.

## What can change without new authority

Explainer copy and choreography, identity labeling, first-task examples, an editable structured draft composer and guidance copy can use current boundaries. Suggestion chips may prepare text but must not submit it automatically. The existing no-flag decision and existing-account exemption continue to apply.

Moving stages, remembering deferred setup independently from learning completion, persisting a pre-submit task brief, recording user-confirmed usefulness, or detecting a saved artifact requires explicit contract and persistence changes. Do not encode these solely in renderer booleans. Personal appearance remains an account preference; workspace learning content and task drafts remain regional.

## Verification for a later implementation

Walk creator, accepted member and pending-invitation entry; paste-only and authorized-connector tasks; empty notes, missing context, provider failure and inline fallback; relaunch before and after submission; concurrent progress updates; and reduced motion. Show the real initial artifact and a real same-stream revision using configured providers before describing the wow path as verified. A completed HTTP request or harness status alone cannot prove that experience.

## Substreams and multiplayer are core learning

The product owner explicitly included both in onboarding on 2026-09-05. Teach the distinction through the same task: continue shared work in Main log, explore a side question privately in a substream, and start a new work stream for a different outcome.

Use the existing prepare → context preview → confirm flow for the child. Its initial context is a frozen summary of eligible completed main-conversation content. It starts creator-only and idle until an explicit new message. Do not imply continuous synchronization, inherited parent participants, an automatic run, or an automatic merge back to Main. Returning a finding means the person reviews and posts the chosen text to Main through the normal composer. The parent sidebar's shared participant roster is not the child's access list; contextual guidance must make that distinction clear.

Multiplayer learning uses an explicitly added, authorized real person and a visible contribution to the shared task. A workspace invitation alone neither shares the private starter nor proves that someone has joined it. The introductory example may illustrate fictional people if clearly labeled Example; the live exercise must never invent a teammate, cursor, message, presence, or contribution. Waiting for a person is not a completion requirement: keep an actionable invitation/share state and let the learner continue independently.

Additional acceptance checks cover creator-only child visibility, reviewed frozen context, no child run before Send, return-to-Main without accidental private-text disclosure, and a second real account seeing and contributing only after authorized access. Confirm a contribution reaches both clients. Live multiplayer success and a displayed invitation are separate outcomes.
