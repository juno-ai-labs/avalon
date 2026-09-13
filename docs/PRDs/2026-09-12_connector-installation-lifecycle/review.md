# PR #737 review disposition

Nine independent review-swarm personas reviewed the implementation at high effort:
backend, security, React, architecture, QA, UX, prompts, documentation, and
simplicity. Opus was unavailable in the runtime; the reviewers used GPT-6 Astra.
Concurrency allowed three reviewers at a time. The user authorized opening and
updating the PR; deployment and merge remain excluded.

## Findings and corrections

| Reviewer | Finding | Correction |
| --- | --- | --- |
| Backend P1 | Late successful creation after repair/key replacement deleted a still-desired webhook. | Retain and inspect the exact desired identity; obsolete/disconnected intent becomes cleanup. Never call an uncovered event selection current. |
| Backend P1 | Granola ID-only reconciliation claimed healthy delivery without its signing secret. | Require matching signing credentials before current; retain exact removal authority and explicit manual recovery when the secret is unavailable. |
| Backend P2 | Repeated disconnect invalidated in-flight/completed cleanup receipts. | Already-disabled disconnect preserves the receipt and cleanup state. |
| Backend P2 | Released Granola clients lacked the newly required retry key. | Admit the old payload through the same atomic reservation; new clients retain explicit retry identities. |
| Security P2 | Public ingress buffered and forwarded oversized bodies before enforcing the existing limit. | Share the existing bounded byte reader and configured admission policy at both HTTP transports, before routing/RPC. |
| Security P2 | New administrative transitions omitted acting-user audits. | Record content-free setup, maintenance, disconnect, cleanup-forgetting and credential replacement actions; setup replay is deduplicated. |
| React P1 | Unadopted Granola connections had no reachable Test. | Render Test for a loaded, enabled legacy connection and refresh its adopted installation. |
| React P1 | Queue completion/reconnect did not invalidate installation details. | Add installation queries to the existing connection topic's invalidation roots. |
| React P2 | API and desktop independently declared response envelopes. | Share setup, nullable read, non-null mutation and Test schemas in contracts. |
| Architecture P1 | Key replacement could overwrite a provider-issued secret committed during validation. | Read generation before refreshing the credential snapshot; advance generation when provider credentials settle and reject stale replacement with HTTP 409. |
| QA P0 | Public installation authentication/authorization lacked runtime coverage. | Signed-session owner/admin/member/cross-workspace and malformed-request cases exercise the actual Hono service and WorkspaceDO. |
| QA P0 | Event/signing-key and saved-selection boundaries lacked negative runtime coverage. | Both guards reject valid-but-unauthorized signatures before payload, receipt or Queue persistence. |
| QA P1 | Credential replacement preservation was tested below the real service boundary. | Exercise encryption, provider validation, delivery with both retained keys, disconnect races, and Granola secret settlement while validation is suspended. |
| QA P2 | Concurrent maintenance did not prove two frozen target outcomes survive. | Exercise production D1 per-target settlement with overlapping distinct outcomes, stale completion and cancellation before its target sweep. |
| UX P2 | Reading signing-key guidance mutated installation health. | Local disclosure displays recovery instructions without a provider or installation mutation. |
| UX P2 | Test did not explain its provider-repair behavior. | Show its credential-check and approved-configuration repair effect beside the action. |
| UX P2 | Personal Ashby setup omitted account/opt-in prerequisites. | Add prerequisite copy and a support guide to the existing card. |
| UX nit | Recovery selector showed provider enums instead of readable event labels. | Reuse the same event labels as the registration summaries. |
| Prompt P2 | Workspace-only Ashby advertised personal recruiting tools. | Derive distinct personal and event-only trusted catalog presentation from granted capability. |
| Docs P2 | Ingress override absent from the environment reference. | Document the server-only override, production default and local destination requirement. |
| Docs P2 | Connections acceptance instructions contradicted Test, personal refresh and labels. | Update the owning acceptance checklist and old label references. |
| Docs P2 | Schema/provider/security facts appeared only in changelogs. | Update current reference bodies and their lifecycle links. |
| Docs nit | New module structure/changelog formatting differed from repository rules. | Restore required section order and amend the single #737 entry per owning document. |
| Simplicity P2 | Granola retained dead direct repair/revoke provider pipelines. | Remove superseded adapter writers and their obsolete test; lifecycle management is the sole writer, health remains read-only. |

The new public route test also exposed a superseded replacement returning HTTP
500 despite correctly refusing the write. It now returns a safe HTTP 409 with
reload guidance. None of the review findings requires a product confirmation or
an expansion of the two approved Ashby events.

## Additional PR review feedback

The GitHub automated reviewers' findings were checked as well:

- Oversized ingress and released Granola payload findings duplicate the corrected
  swarm findings above.
- Maintenance now settles an action-required target when failed/unknown
  replacement work leaves only dependency-blocked removal pending. Dispatched work and runnable
  pending steps postpone settlement; manual recovery does not loop a Queue.
- A Worker/configuration version mismatch records a retryable, undispatched
  failure. Test can repair it when the matching Worker is available.
- Resume rejects an unapplied preview, so it cannot bypass the frozen
  configuration that Apply prepares. Resume before the first Queue preparation
  leaves that preparation to the normal runner; it cannot stamp an operation
  identity over the old configuration.
- Workspace Ashby onboarding opens Connections Settings, matching the API-key
  setup path; personal Ashby continues through OAuth.
- Custom MCP Settings and support copy no longer promise per-tool confirmation.
  Linear, Notion and Custom MCP support use the current Connect labels. Native
  inspection caught a second stale policy description beside the selector; it
  was corrected along with the footnote.
- The v54 SQL now lives inline in the immutable WorkspaceDO migration entry.
  Statement bytes are unchanged; the runtime protocol no longer exports schema
  statements that a future protocol edit could accidentally alter.
- Follow-up audit review added the acting administrator to explicit Test repair,
  and current operator identity to regional apply/resume/cancel request audits.
  Regional request logs follow the existing Ace audit mechanism; they do not
  imply successful target completion.

Later review also led to these corrections:

- Setup now persists its existing completion telemetry once per new reservation;
  replay does not count a second setup. Both disconnect entry points use full
  local teardown even if adoption or cleanup Queue dispatch fails. Cleanup only
  becomes an uncertain provider write immediately before its provider call.
- A failed setup response recovers the existing workspace reservation in Settings.
  If recovery lookup fails, the form requires finding that reservation before
  another setup request. Reconciliation only offers eligible unresolved steps,
  clears stale input after success, and shows readable Granola event labels.
- Dedicated ingress health checks the Global routing directory and both regional
  ingress contracts, including region identity. The duplicate shared-host API
  routing path and Global API-to-EU Ashby binding were removed. The first rollout
  automatically bootstraps Global when the active router export is absent,
  verifies its health/export, then proceeds to EU and shared ingress. No manual
  pre-merge Global-only deployment is required.
- Historical connection-dependent lists are explicitly named through v53. The v54
  installation foreign key is documented for future rebuilds without changing
  old migration SQL or hashes.
- New isolated claim fencing, overlapping maintenance, real-migration routing,
  teardown and Queue-consumer regressions strengthen the disputed coverage.

The following suggestions were assessed without changing the approved scope:

- Removing rotation/fleet maintenance, adding a new operator secret, or introducing
  a launch feature flag conflicts with explicit user requirements. The existing
  Ace credential remains the chosen authority, with action audits.
- The inherited ten-second explicit Test repair budget remains. A provider write
  interrupted after dispatch becomes unknown; undispatched work stays retryable.
  Test then performs the separate health check, while installation details retain
  delivery status. Automatically recreating after an ambiguous timeout would
  violate the no-duplicate-registration requirement. No new timeout was added.
- Model plugin IDs satisfy the shared contract and are stored before lookup; no
  OAuth-only ID allocator contract applies to workspace API-key setup.
- Granola adoption is lazy on explicit administration and records a durable
  installation once. The stored ownership marker prevents duplicate writers; it
  is not a feature flag or a second indefinite legacy provider pipeline.
- Granola's exact outbound create URL, Bearer header, scope and four-event body
  remain covered by its provider unit test, which the shared facet calls.
- The external Claude review and this Codex swarm ran in different model runtimes.
  The swarm's runtime/model statement above describes only this Codex run.
- Stylistic redesign suggestions do not identify a hidden or unusable control.
  Native inspection verifies the existing Settings primitives and recovery states;
  no unrelated visual redesign or speculative configuration was introduced.

Three other bot claims do not establish defects in the implementation:

- The reported Ashby guard nesting was not present: it was a sibling after the
  Slack closing brace. The now-redundant API host guard was subsequently removed
  when dedicated ingress became the sole shared-host transport.
- The installation Queue handler rethrows non-retirement errors for Queue retry.
  Its runner drains runnable steps; another active claimant owns dispatched
  work. Dependency-blocked manual recovery is visible in receipts and must not
  trigger blind provider replay. The distinct maintenance terminal-status defect
  was fixed as described above.
- Maintenance targets are frozen at preview. No supported operation inserts,
  removes or reorders that array; atomic positional updates cannot switch target
  identity. The two-target workerd test and whole-document-overwrite mutation
  establish that concurrent sibling outcomes survive.

## Regression evidence

Added workerd suites cover recovery, public routes, maintenance progress,
administrator/operator audit, teardown, overlapping Queue deliveries, isolated
claim-generation fencing and resume before preparation. The original installation
suite also exercises actual maintenance Queue dispatch, ingress readiness,
preview/resume, blocked removal and version handoff recovery. They exercise actual runtime
storage, service authorization, signed ingress and Queue admission; only provider
HTTP is substituted. Renderer/catalog cases cover the presentation fixes.

The subsequent CI secret-scan finding was the synthetic Granola signing fixture,
not provider-issued credentials. The exact encoded test phrase is allowlisted
with a narrow rejection test; no test file or webhook-key shape is excluded.
Pinned Gitleaks full-history verification passes locally.

Production mutation results and final gate counts are recorded in [plan.md](plan.md).
Each mutation is temporary, runs only its affected test file, and is restored
before final validation. These are regression proofs, not live Ashby acceptance.

Native Electron inspection includes the updated legacy Granola Test,
rotation guidance,
personal prerequisite guide, and
recovery/permission denial.
Additional native captures show failed recovery lookup,
recovered installation,
connection-specific actions, and
Granola recovery. Inspection caught a
clipped four-event selector label; the compact Granola note events option now
fits while the full event list remains in its heading and title.
All captures use synthetic public status metadata.

## Acceptance that remains unavailable

The absence of an authorized Ashby organization prevents live OAuth, real tool
inventory/execution, provider webhook/recovery and confidential-event audience
acceptance. The PRD remains in progress. Ashby workspace automation admission is
restricted until the audience is verified; personal queries and usable workspace
events are both required for launch. The dedicated Worker isolates ingress only;
provider management and MCP still execute in the regional API. See the exact
remaining checks in [plan.md](plan.md). The workflow automatically handles the
first Global router deployment before EU; no bootstrap or deployment was performed.

## Automatic subscription follow-up — 2026-09-13

The user's later instruction replaces the original two-event setup choice with
all 27 documented business event subscriptions. The shared vocabulary drives
installation defaults, operational trigger discovery and readable status labels;
setup takes only the API key. Existing explicit grants remain bounded and ping
remains transport-only. No recruiting REST tools or individual tool confirmations
are added.

The email-change beta is handled as a candidate signal. Its renewable delivery
watermark cannot cause a canonical identity conflict, but a changed candidate
still does. Raw deliveries retain their actual hashes and distinct regional R2
objects. A provider rejection stays visible and does not stop other registrations.
No undocumented availability API or error classification is invented.

The full test suite passes (870 real-workerd tests). Four representative
production mutations fail at the expected assertions; details and scoped counts
are in [plan.md](plan.md). The native setup window and local public support copy were inspected. This follow-up does not claim live Ashby compatibility or
resolve the separate first-deployment ordering issue.

## Simple management follow-up — 2026-09-13

The user's screenshot review found that normal installation management exposed
provider internals without a useful hierarchy. The primary view now shows status,
last delivery and explicit Test, with a help link on trouble states. Advanced
contains API-key replacement, signing guidance and unresolved-create recovery;
provider registration diagnostics are separately collapsed. Cleanup retry remains
contextual, while forgetting the cleanup credential is advanced. No backend
permission or provider behavior changed.

The focused renderer suites pass 163 tests, including hidden-by-default controls,
read-only expansion, explicit Test, offline handling, reconciliation and legacy
Granola adoption. Lint/typecheck, docs validation, site build and native/public
visual inspection pass. All ten committed screenshot files and PR image embeds
were removed at the user's request; visual QA continues locally.

## Automatic deployment ordering — 2026-09-13

The first Global router bootstrap is now selected automatically from active
exports, with existing EU targets checked before reversing the ordinary order.
Global health/export failure stops EU; shared ingress follows both regional
health barriers. Partial regional dispatch and Worker-first migrations retain
their boundaries. No manual pre-merge deployment remains required.

The 460-test scripts suite, lint, typecheck and docs check passed; five reverted
production mutation proofs caught missing ordering/failure barriers. Detailed
evidence and the unavailable live Cloudflare credential check are in
[plan.md](plan.md#automatic-deployment-ordering--2026-09-13). No deployment or
merge was performed; live Ashby acceptance is still outstanding.
