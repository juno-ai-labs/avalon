# Prepared conversations and session import

A prepared conversation is ordered user/assistant content with resolved file
references and trusted provenance. The same conversation authority materializes
it into a root work stream or private child. Starting an execution is a separate
choice. Importing a prior assistant answer never claims Rally executed it.

## Where the code lives

| File | Responsibility |
| --- | --- |
| `packages/contracts/src/substream-content.ts` | Source content/files, resolved prepared conversations, initialization modes and import provenance. |
| `apps/api/src/services/session-import.ts` | Provider envelope decoding and visible message/file extraction. |
| `apps/api/src/services/session-import-files.ts` | Constrained file retrieval, unavailable outcomes, upload reconciliation and trusted attribution. |
| `apps/api/src/services/resource-service.ts` | Existing verified upload, staged R2 cleanup and resource creation. |
| `apps/api/src/durable-objects/workstream-object-product.ts` | Shared materialization, preparation receipts, file reservations, root/child publication. |
| `apps/api/src/durable-objects/workstream-transcript-storage.ts` | Canonical fact preparation for ordered conversations. |
| `packages/agent-harness/src/evaluation.ts` | Scenario/checkpoint evaluation using the production Rally runtime. |
| `apps/desktop/src/renderer/components/session-import-dialog.tsx` | URL-only import dialog. |

## How it works

The plus menu offers **start new work stream** and **import from ChatGPT or
Claude**. The dialog accepts a shared conversation URL; **Create a new work stream** imports it in one action.
It does not display an export picker, editable title, or transcript preview.
Available attachments and artifact files are resolved automatically; missing file
references remain visible in the imported conversation. The source roles stay
intact; the byline says who imported them. After creation, the standard background
LLM naming path reads the prepared history and names the work stream. The source
title provides its objective and provisional fallback.

There are three separate boundaries:

1. **Decode source content.** Provider adapters identify the selected conversation,
   visible text, embedded bytes and recognized file descriptors. Unknown visible
   content is an error, not permission to omit part of a conversation. Tools,
   thinking and compaction remain absent from the transcript.
2. **Resolve content.** Preview freezes successful remote downloads as bytes and
   records unavailable outcomes. Import stores bytes through `ResourceService.upload`,
   which checks existing size policy, verifies MIME, hashes bytes, stages R2 cleanup
   and creates workspace-owned resources. Stable operation/file identities make
   retries reconcile the same upload. Importer identity comes from authentication.
3. **Materialize a conversation.** The authority prepares canonical facts, reserves
   resource drafts and commits all turns and relationships with its publication
   fence. Root creation and private-child initialization use the same preparation
   and commit operations. The latter runs before the parent publishes readiness.

`ConversationInitialization` distinguishes `prompt` and `history`. Normal opening
messages retain their existing execution path. `createPrepared` accepts content
without an empty opening-message field at its caller boundary. The internal
compatibility adapter still carries legacy opening fields for existing creators.
A history stream starts idle and has no run. A caller can subsequently submit an
ordinary message to start execution, including after preparing a private child.

Demo pack creation has an explicit `execution: history` mode for prose. It uses
`createPrepared` and verifies canonical turns rather than waiting for an invented
run. The decision-memo opening exercises that path. Scripted tool/elicitation
scenarios continue through ordinary production executions.

First continuation reads the complete canonical transcript, including attachment
manifests for both source roles. Historical image bytes are not replayed into the
model. Existing authorized file tools retrieve stored resources when needed. The replay layer imposes no separate message-count or serialized-byte ceiling.
The first continuation must still fit the selected model: automatic compaction
starts only after a completed provider turn supplies usage, and cannot rescue an
oversized first request. Import never silently truncates the canonical history.

### Evaluations

`runRallyEvaluation` accepts either a prepared scenario or a settled Rally
checkpoint. The host restores executable configuration and an isolated environment;
Rally uses the same `runHarnessWithBind` assembly, plugins, authorization hooks,
provider routing and tool handling as production. There is no separate eval loop.

Bind owns checkpoint validation, boundary advancement, budgets, transcript state,
forking and reply/wake input. Rally captures its flat projection and capability
activation hints alongside each Bind checkpoint. Eval forks require a fresh host
loop identity and rebase Rally reservation identities, preserving settled provider
messages. A checkpoint after a tool result resumes after that result instead of
repeating the tool effect. Host bindings remain the host's responsibility: callers
must restore the corresponding tool environment and persistence, not merely messages.
This provides an executable eval seam, not a scheduler or scoring database.

## Invariants

- Imported history never creates fake runs, tool receipts or artifact deployments.
- Canonical turns, attachment relationships and preparation completion commit together.
- Draft holds have a durable owner: either a pending live input or a prepared
  conversation. Definite failed preparation releases holds; ambiguous responses
  remain recoverable under the same preparation identity.
- Source request identity is hashed separately from materialized importer snapshots.
  The preparation receipt freezes materialized content across retries.
- Uploaded user files and assistant artifact bytes use the existing resource authority.
- Unavailable files remain readable references, never fake downloadable resources.
- Extracted document text is a separately named text file; the original reference remains.
- Source links do not authorize arbitrary downloads or credential forwarding.
- Bind owns settled execution state; Rally owns conversation facts and host restoration.

## Boundary

Public APIs are `POST /workstreams/import/preview` and `POST /workstreams/import`.
Clients can provide source content, not another importer's identity. Prepared
conversation installation is an internal coordinator operation; the private-child
receipt and conversation creator authorize it. Existing active conversations are
not bulk-import targets.

The URL freezes during submission. Resolved content and request identity are retained
for retries after an uncertain response; editing the URL starts a new request.
The decoding API continues to support JSON/JSONL exports for programmatic callers.

Source files are inline UTF-8/base64, recognized HTTPS downloads, or explicitly
unavailable references. Known Claude image/document blocks (including plain-text
document sources), artifact documents and
full-content Write/artifacts tool payloads preserve file content without importing
the tool invocation. ChatGPT exports preserve attachment descriptors and image
references. Source sandbox links without bytes remain unavailable.

## Failure modes and limits

Provider share formats are not stable APIs. Public Claude snapshots can challenge
server HTTP clients; Claude Code URLs require login in the tested browser. These
cases cannot be imported through the URL-only dialog.
Expired/private file URLs, absent export bytes and unsupported download origins
remain unavailable and are recorded in the imported transcript.

Downloads refuse redirects and use the existing workspace `MAX_ATTACHMENT_BYTES`
policy while streaming. File uploads retain the same policy. Prepared histories
have no additional guessed size ceiling, but HTTP, memory, SQLite and provider
context limits still apply. Full canonical replay is paged but assembled in memory;
An oversized first provider request can fail before automatic compaction is available. A source export containing multiple
conversations must be split before import.

HTML/code artifacts remain stored files; importing does not launch a site. Exports
that contain only patches, inaccessible sandbox paths or proprietary artifact state
cannot reconstruct original files automatically.

## Testing

- `test/session-import.test.ts`: provider branches, one-record JSONL, visible-format
  refusal, attachment-only messages, embedded artifacts and extracted-text labeling.
- `test/session-import-files.test.ts`: constrained origins, redirect refusal,
  frozen download bytes and the existing file size policy.
- `test-workers/conversation-creation.test.ts`: real upload/R2 bytes, role-specific
  attachments, failed reservation cleanup, idempotent creation, and actual provider
  continuation with history and attachment manifests.
- `test-workers/substream-creation-runtime.test.ts`: private-child materialization,
  publication and conflicting replay.
- `test-workers/workspace-draft-attachment-reservation.test.ts`: existing draft holds
  and canonical projection release.
- `packages/agent-harness/src/evaluation.test.ts`: production runtime from an initial
  scenario and serialized tool-settled checkpoint, with no repeated write after fork.
- Desktop menu/launcher/transcript tests cover navigation and attribution. Real
  Electron visual QA covers the URL-only dialog and submission
  using a fixture API; backend lifecycle tests provide storage/execution evidence.

## Changelog

### 2026-09-15 — Compose prepared content, resources and execution

**What changed:** Root/private creation and text-only demos share authority-owned
materialization. Imports preserve available files and explicit unavailable references.
The URL-only dialog imports directly and reuses background naming from canonical
history, avoiding an additional preview or manual naming step.
Prepared receipts own content and draft reservations. Evals reuse Rally's production
Bind runtime and capture both Bind state and Rally projection/activation bindings.

**Why:** A text-to-model field rename did not share actual creation behavior.
Inferring execution from an optional import field, dropping files and wrapping Bind
checkpoint exports left each next consumer to invent lifecycle and restoration.

**Consequences:** Publication remains with the destination authority, resources remain
with WorkspaceDO/R2, and execution remains with Bind. Source decoding and file
retrieval cannot grant identity or execution authority. Eval hosts must restore an
isolated environment and allocate fresh fork identities.

**Considered and rejected:** Replaying history as scripted model executions,
fabricating generated-resource receipts, separate eval loops and merely raising
canonical replay ceilings would misrepresent provenance or duplicate ownership.
