# Work-stream artifacts — protocol framework and data-model rationale

> Created 2026-08-26. Companion to [`prd.md`](prd.md); read that first. This
> file carries the material too detailed for the PRD body: the
> generation-protocol decision framework and its confirming experiment, the
> artifact/resource unification assessment, the version-ledger substrate,
> and the multi-file, future-type, and external-document analyses.

## The generation-protocol decision framework

The question: by what mechanism does a model's document become an artifact?
The PRD's UX must not depend on the answer — the version ledger's write
contract is the seam — but V1 must pick one mechanism to build, and the
pick must be argued, not assumed.

### The three candidates

**1. Markup extraction.** The model emits the document inside a marker in
its ordinary response text — `<artifact>…</artifact>` or a fenced
convention — and the harness extracts it into the ledger. This is the shape
several chat products use.

**2. Typed artifact operations.** The model calls explicit write tools —
`create_artifact`, `revise_artifact`; later possibly `replace_in_artifact`
— and the document travels as a tool argument. Ordinary assistant output
stays conversational. Reads ride the existing attachment tools, because an
artifact is a resource.

**3. The Terminal file workflow.** The model uses its trained file-and-
shell repertoire — write a file, edit it with targeted replacements, check
it with the usual text tools — inside the work stream's existing
authority-fenced sandbox, and the result is published back into the work
stream. The publish half exists today: Terminal's publish operation already
lands a sandbox file as a durable generated resource with receipt-backed
dedupe. "Teleporting the file back" is not hypothetical machinery; it is
the current contract.

### Comparison

Judged on the nine axes the commissioning discussion named. "Terminal"
below means the file workflow riding the existing Terminal plugin's
sandbox, lifecycle, and publish path.

| Axis | Markup extraction | Typed operations | Terminal file workflow |
| --- | --- | --- | --- |
| Model reliability / training alignment | Weakest. Product-specific markup is out of distribution for coding-RL'd models; malformed or unterminated markers are a live failure class, and the failure is silent (the document lands inline). | Strong. Tool calling is universally trained; a two-tool family with strict schemas is the easiest possible call. Failure is loud and typed. | Strongest for *editing*: file write/replace workflows are heavily RL-trained. Creation is equal to tools; the alignment win concentrates in targeted edits of long documents. |
| Tool-selection ambiguity | None (no tools) — but replaced by a worse ambiguity: every response must decide whether to speak markup, with no schema to catch a wrong guess. | Low if the family stays small. The real risk is overlap with other text-writing tools (memory, tables, block submission); mitigated by registration exclusivity, distinct naming, and policy that names the one protocol. | Highest risk in mixed scope: a run holding both artifact tools *and* file tools has two ways to write a document, which is the confusion the discussion warned about. Mitigation if chosen: the file path *is* the artifact path — do not also register typed writes. |
| Latency | Best-in-theory (content streams in the response) — but the win is presentation-only and the PRD defers pane streaming anyway. | One internal write per version; no provider round-trip beyond the call itself. Sandbox never involved. | Worst cold: first file operation acquires the work stream's sandbox. Warm operations are fast; cold-start on a casual "draft a PRD" request is real cost for no user-visible gain in V1. |
| Observability | Poor. No receipts, no typed failures; extraction success is inferred by parsing. The inference lakehouse shows the raw text, and nothing else does. | Best. Every version has a receipt, a typed outcome, a stable failure code; the instrumentation section's creation-side events fall out of the write path. | Good. Terminal ops are receipted and audited; but the *artifact-level* intent (which file operations constitute "the revision") must be reconstructed from a series of file ops plus a publish. |
| Revision behavior | Worst. A revision is the model re-emitting the whole document in chat markup — exactly the inline wall the feature exists to remove, now hidden behind extraction. | Full replacement per version: simple, self-contained, matches the external-diff rule. Targeted edits need a future `replace_in_artifact`. | Best for long documents: targeted in-place edits are the trained behavior, and the ledger still captures the complete resulting version at publish. |
| Compaction / context recovery | Poor. The document exists only in transcript history; after compaction the model must regenerate rather than re-read, unless it is separately stored anyway. | Good. Artifact-as-resource rides the compaction-surviving inventory and the list/read rails; recovery is list → read → revise. | Good, differently: the file persists in the sandbox across the work stream's runs, and the resource copy persists regardless. Two recoverable copies — which also means a divergence risk between them to manage. |
| Future human editing | Neutral — extraction says nothing about how a human writes a version. | Clean. A human-authored version is a ledger row with `member` provenance; the tools never own the ledger, they are one producer. | Clean for the same reason, plus a wrinkle: a human edit made in the pane must reach the sandbox copy or the next model edit works on stale text. The ledger stays authoritative; the sandbox is a working copy. |
| Implementation complexity | Low-looking, high-hiding: streaming-safe marker parsing, malformed-marker recovery, and authorization for a side effect produced by prose (Rally's contract requires typed, authorized operations — prose is not one) make this costlier than it reads. | Moderate and mostly already-paved: two tools on the existing plugin, ledger authority, card append. The smallest real build. | Highest for V1: ties every casual document request to sandbox lifecycle, region gating, and egress policy; publish-to-ledger versioning glue is new. Cheapest *later*, once the ledger exists and Terminal adoption grows. |
| Multi-file support | Awkward: multiple documents in one response multiply the marker-parsing failure class. | N calls for N files — workable; a collection object arrives later regardless. | Natural: a folder of files is the native shape; the media-packet case is where this candidate shines. |

### Recommendation

**Typed artifact operations for V1**, on the joint strength of
observability, authorization fit, implementation size, and cold-latency —
with two standing commitments that keep the decision honest:

1. **The Terminal file workflow is a designed-in future producer, not a
   rejected one.** Its publish path already lands resources; when the
   ledger exists, versioned publish is glue, not architecture. It becomes
   the right producer where its axes dominate: long documents needing
   targeted edits, code-adjacent outputs, and multi-file collections. A
   run should hold one document-writing protocol at a time — whichever
   producer is active for that run's purpose — so the tool-selection
   ambiguity the discussion warned about never materializes.
2. **Markup extraction is set aside, not struck.** Its fatal problems for
   Rally are authorization (a side effect produced by prose has no typed,
   authorized operation behind it, which the product contract requires)
   and silent failure. If a future model generation makes marked-up
   document emission a strongly trained behavior, the framework re-runs;
   the ledger would not change.

### The confirming experiment

Before implementation hardens, run the two serious candidates head-to-head
on the configured medium fallback model — the model the tool standard says
must succeed, not a frontier model whose success proves little:

- **Tasks:** create from a document-type request; create from an implicit
  request; revise after a small ask; revise after compaction (list → read
  → revise); a two-document request; a conversational question that must
  *not* produce an artifact.
- **Scored on:** task success rate; wrong-call and loop incidence;
  end-to-end latency including sandbox acquisition where applicable;
  narration discipline (document content absent from chat text).
- **Outcome:** recorded in the PRD's decision log with the run evidence;
  the Agent behavior section is revised only if Terminal wins outright.

## Artifacts and resources: the unification assessment

The commissioning question: should resources (inputs supplied to the
model) and artifacts (outputs generated by it) share one structural
representation, with the distinction a role label rather than a type?

**Answer: yes — and the codebase has already voted.** Three existing
subsystems make generated content a resource:

- **Terminal publication** lands sandbox files as `resources` rows with a
  generated relationship label and Rally-generated provider identity —
  generated outputs on the input rail, shipped and working.
- **Meeting notes** are an AI-written, continuously revised document whose
  authoring lifecycle lives in a first-class table while everything
  reader-facing is a materialized resource — "the only view of a note
  anything outside this module has." This is the hybrid the artifact
  model follows: authority table for lifecycle, resource for reach.
- **The 2026-08-12 artifact retirement** concluded in as many words that
  "anything durable that a person should be able to open belongs in
  `resources`."

What unification buys, concretely — each of these is a rail the retired
design lacked and a fork a parallel store would create:

- the model's list/read/search/view/summarize tools serve artifacts with
  no new read surface;
- the right rail's resource list and the model's inventory share one
  visibility predicate, which may never diverge;
- the compaction inventory keeps artifacts discoverable after context
  loss with no artifact-specific prompt machinery;
- the R2 content lifecycle, deletion outbox, and per-region residency are
  inherited;
- the per-work-stream link machinery gives cross-work-stream reference by
  construction;
- digests and any future delivery path see a durable, openable object —
  the literal fix for the retirement's failure mode.

What resources lack, and the version ledger adds: revision lifecycle.
`resources` is a current-pointer object — content identity pins exact
bytes, and updating means pointer swap plus derivative invalidation, with
no history. The ledger supplies history without disturbing the pointer
contract: the resource row's pointer always names the current version's
object (every existing reader keeps working, unversioned), and the ledger
rows carry the past.

The role distinction lands in two existing places, not a new type: the
work-stream link's relationship label (attachment vs artifact — whether
that is a new value or reuses the generated label is settled at
implementation against the actual column constraints) and the resource's
provider-style provenance. An input and an output are the same kind of
object with different provenance — which is also what makes the future
interesting cases cheap: a human-uploaded document later edited by the
agent, or an external snapshot later re-fetched, cross the input/output
line without changing type.

**Rejected alternatives, recorded:**

- **A parallel artifact store** (its own tables, read tools, visibility,
  inventory, cleanup): forks every rail above; the Terminal PRD already
  rejected a Terminal-specific artifact table on exactly this ground.
- **Artifact-as-transcript-message** — this PRD's own first draft: the
  document as a typed message row, versions as new messages. It is the
  smallest possible build and closes the retirement trap, but it cannot
  honestly carry the commissioned foundation: a version-history UI from
  transcript rows fights pagination gaps (the draft's "newer revision"
  affordance was best-effort for this reason), multi-file and non-Markdown
  futures do not fit message content, human editing would have to mint
  agent-shaped messages, and cross-work-stream reference has no object to
  reference. Superseded by this revision.

## The version ledger

One append-only table beside the workspace resource authority; sketch:

- `resource_id` — the artifact (or, later, any versioned resource).
- `version_number` — monotonic per resource from 1; unique with
  `resource_id`; allocated by the authority, never by the producer.
- `content_ref`, `content_sha256` — the immutable content object for this
  version, in the region's existing bucket under resource keys. The
  resource row's current pointer names the newest version's object and
  swaps atomically with the version insert.
- `author_kind` — `agent` | `member` | `connector`; V1 writes only
  `agent`. Author identity columns accompany the kind: producing run and
  receipt for `agent`; user for `member` (dormant); connection for
  `connector` (dormant).
- `produced_by` receipt identity — the idempotency key. A replayed write
  finds its receipt and returns the persisted version; a version commits
  at most once per receipt. This is the same discipline as Terminal's
  receipt-deduped publish and the block-result receipts.
- `title`, `created_at`.

Rules the sketch implies, stated so implementation cannot miss them:

- **Versions are immutable.** No update path exists; correction is the
  next version.
- **The fence is compare-and-swap at the authority.** The producer passes
  the version it believes current; the authority compares under its own
  serialization and refuses stale writes with the typed conflict. No
  client and no model ever computes a version number.
- **The card append converges with the ledger.** The transcript card is
  written on settle and deduplicated by the same receipt identity, so
  crash-and-replay between ledger and card cannot double either.
- **Retention is a decision, not a default.** Version rows and content
  objects grow without bound by design in V1 (documents are small; the
  team may later choose a policy). Any retention number is the team's,
  per the limits doctrine; nothing in V1 ships a cap.
- **Deletion follows the resource.** Deleting the artifact resource ends
  the ledger rows and their content objects through the existing deletion
  outbox; version objects are enumerated into it like derivatives.

Diffs, when they come, are computed by comparing two stored versions —
externally, deterministically, at read time or materialized later. The
model's own account of what it changed is never stored as history.

## Multi-file artifacts and future types

**V1 is single-file by decision, multi-file-ready by shape.** One
artifact = one resource = one file; a media-packet request yields several
artifacts and several cards. Because each artifact is an independent
resource, a future **collection** is one small association (a labeled
group of resource ids, itself likely a resource so it can be linked and
listed) — additive over V1 rows, no reshaping. The alternative — a group
object in V1 whose only occupancy is groups of one — was rejected in the
PRD as pure carrying cost.

**Future types ride the type identity the object already has.** A
Markdown document, a structured table, an HTML dashboard, an interactive
mini-app, are different content types of the same object kind, and the
resource row already carries MIME/kind identity. What gates each future
type is a renderer and a security decision, not storage: V1's pane
renders Markdown and nothing else; HTML and app artifacts require their
own sandboxing PRD before any pane executes anything (PRD non-goal 7).
The classification registry's natural-language kinds already include
`markdown`; later types extend classification, not the ledger.

## External documents: snapshot now, subscription later

V1 behavior, unchanged from today's attachment contract: an external
document referenced in a work stream is fetched at reference time into a
snapshot resource; the source may change afterwards and Rally's copy does
not. Re-asking fetches a newer snapshot. Nothing subscribes, polls, or
syncs.

The dormant design, so the future costs occupancy rather than migration:
the work-stream link already carries a watch bit, the product contract
already names "enrich an explicitly watched resource" as connected
activity's second job, and the ledger already reserves `connector`
authorship. A future subscription PRD composes those three — change
events on a watched external resource arrive as activity, the agent
decides whether to re-read, and a re-fetch lands as a connector-authored
version. None of that ships here: no watcher, no webhook route, no sync
loop, and explicitly no continuous bidirectional synchronization ever
promised (PRD non-goal 6).
