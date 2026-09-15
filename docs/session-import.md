# Prepared conversation content and session import

Prepared conversation content is an ordered list of user and assistant text
messages. Rally can store it as a new work stream's history without running a
model, or turn it into a Bind checkpoint for an evaluation. Import provenance
records who brought the history into Rally, separately from the source roles.

## Where the code lives

| File | Responsibility |
| --- | --- |
| `packages/contracts/src/substream-content.ts` | Text content, source, preview and provenance contracts. |
| `packages/agent-harness/src/prepared-content.ts` | Shared model-message projection and Bind 16 checkpoint creation; exports Bind's resume and fork primitives. |
| `apps/api/src/services/session-import.ts` | Provider formats and public-link retrieval. |
| `apps/api/src/services/workstream-object-creation-service.ts` | Creation receipt, routing, workspace directory and initial content. |
| `apps/api/src/durable-objects/workstream-object-product.ts` | Atomic transcript initialization and optional initial execution. |
| `apps/desktop/src/renderer/components/new-workstream-menu.tsx` | Shared plus-button menu for expanded navigation and compact rail. |
| `apps/desktop/src/renderer/components/session-import-dialog.tsx` | Link/file input, preview and creation. |
| `apps/desktop/src/renderer/components/message-byline.tsx` | Imported-by badge beside the speaker identity. |

## How it works

The sidebar plus button opens a menu with **start new work stream** and
**import from ChatGPT or Claude**. The import choice opens a URL dialog on the
new-workstream screen. Preview accepts a
public ChatGPT/Claude share link or a JSON/JSONL export. The user can inspect
all extracted messages and edit the title. Import creates a personal work stream.
The server derives importer identity and its display snapshot from authentication
and workspace membership; client-supplied content cannot choose another importer.

The creation service uses the existing receipt and directory workflow. Its
`initialContent` option is distinct from the ordinary opening message: the
Durable Object prepares every canonical text fact, then commits the root,
participants and all turns in one SQLite transaction. The stream starts idle;
its receipt has no harness run. Retries include content in their request hash.
A concurrent initializer checks the root again after asynchronous preparation.

Imported user turns use the importer's human account and immutable author
snapshot. Both roles carry `imported_session` structured content. Assistant turns
show the source provider, and the identity line exposes **Imported by Adam** via
an icon and accessible label. Stored timestamps describe import time; the system
does not invent source message timestamps.

A subsequent user message follows ordinary run admission. Canonical bootstrap
projects imported turns with their original user/assistant roles, without the
live-member authorship wrapper. Rally's existing durable Bind projection and
recovery continue to own execution.

Demo scripted text responses consume the same prepared-text projection while
retaining real run admission and settlement. A demo elicitation still calls the
real tool. Imported history never pretends that a demo or provider run happened.

For eval fixtures, `checkpointFromContent` accepts an execution ID, budget and
host bindings and calls Bind's `createLoopCheckpoint`. A one-message fixture is
an initial prompt. `forkLoopCheckpoint` branches an existing settled checkpoint;
`applyCheckpointInput` supplies new input, and `runFromCheckpoint` executes the
same Bind loop. Hosts provide `restore`, `captureBindings` and awaited `commit`;
they own environment snapshots and tool effects. This change supplies those
composable primitives, not a results database or an eval scheduling product.

## Invariants

- Historical content starts no execution. Fabricating a run would misrepresent
  provenance and could accidentally repeat tool effects.
- Root and text facts commit together. A partial transcript cannot be treated
  as a completed import receipt.
- Importer identity is server-owned. Source content does not establish that the
  importer wrote the original human prompt.
- Roles and message order are retained; thinking, tools, compaction, images and
  attachments are omitted. ChatGPT branch traversal follows `current_node`.
- Import never follows arbitrary redirects or retrieves arbitrary hosts.
- Bind owns checkpoint validation, forks, budgets and execution boundaries;
  Rally does not implement a second evaluation loop.

## Boundary

The public routes are `POST /workstreams/import/preview` and
`POST /workstreams/import`. Ordinary work-stream creation retains its opening
message requirement. Prepared content uses the same creation fields with a
separate history option, keeping history-only semantics off the ordinary route.
Existing active streams are not bulk-import targets: their durable model
projection already exists. See [ordered transcript storage](ordered-transcript-sqlite.md)
and [the agent harness](agent-harness.md) for storage and execution authority.

## Failure modes and limits

Provider share formats are not stable public APIs. The ChatGPT adapter reads the
JSON reference table in the observed share loader without executing JavaScript.
The Claude adapter reads `chat_messages` from the public snapshot response;
Claude Code JSONL reads wrapped messages and rejects compaction/meta events.
An export containing multiple conversations must be split before import.

Claude Code session links require signed-in access in the tested browser. Public
Claude shares render without login, but their snapshot endpoint may refuse a
server HTTP client with a browser challenge. Neither case yields an empty
successful import: the UI directs the user to a JSON/JSONL export. This change
does not copy browser credentials or bypass access controls. The public Claude
format was observed on the supplied September 15 share; the Code link itself
was not readable without login.

The existing title and message-admission limits still apply to live messages.
Prepared text has no new guessed size ceiling. Oversized imports remain subject
to the platform's HTTP, memory and SQLite transaction limits; no partially
committed history is published as complete.

## Testing

- `pnpm --filter @rally/api exec vitest run test/session-import.test.ts test/model-protocol-transcript.test.ts test/demo-seed-provider.test.ts`
  covers provider filtering, branch choice, redirect refusal, continuation
  projection and scripted demo output.
- `pnpm --filter @rally/api test:workers test-workers/conversation-creation.test.ts`
  drives real creation, canonical readback, no-run initialization and receipts.
  The import test was proved by temporarily dropping the assistant write: its
  canonical readback failed for the missing assistant turn.
- `pnpm --filter @rally/agent-harness test` covers the Bind upgrade and fixture
  serialization/fork behavior.
- Desktop transcript/new-workstream tests cover the existing mapping and launch
  paths; `new-workstream-menu.test.tsx` covers both plus-menu destinations and
  `sidebar.test.tsx` covers its expanded and compact triggers. Visual QA renders the actual import form and byline in a browser with a
  fixture API; this is presentation evidence, not a live provider import.

## Changelog

### 2026-09-15 — Separate prepared history from initial execution

**What changed:** Work-stream creation accepts prepared text history; imports,
scripted demo text and checkpoint fixtures share a text projection. Import
provenance is stored in canonical structured content and displayed by the client.

**Why:** Replaying imported assistant messages as demo model responses would
fabricate execution and couple content creation to inference. History and the
choice to execute need separate primitives.

**Consequences:** New history uses the existing transcript authority and receipt
workflow. Bind remains the checkpoint/loop authority; future eval hosts must
restore their own environment, and imports into already-running streams need an
explicit model-projection operation rather than a bulk SQL append.

**Considered and rejected:** A second synthetic transcript store, a second execution loop,
and direct writes to development seed APIs were rejected because each would
bypass production ownership and recovery semantics.
