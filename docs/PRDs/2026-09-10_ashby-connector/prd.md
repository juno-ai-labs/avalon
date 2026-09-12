# Ashby connector

> Created 2026-09-10.
>
> Connect a person's Ashby account to Rally for recruiting work through Ashby's
> official hosted MCP server. Companion: [connector contract](design.md).
> Standing contract: [Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).
> Read alongside [connectors](../../connectors.md),
> [hosted MCP connectors](../../hosted-mcp-connectors.md), and
> [security](../../security.md).

## Summary

A recruiter, hiring manager, or other eligible Ashby user connects their own
account in Rally Settings and works with recruiting information in a work
stream. They can investigate a hiring pipeline, prepare for an interview, and
make an explicitly requested recruiting update through the tools their Ashby
account exposes. Answers identify their sources and distinguish completed
changes from drafts or uncertain outcomes.

The connector uses Rally's existing personal hosted-MCP path. Availability is
unflagged across all Rally workspaces at launch, as requested by the product
owner. Availability does not install it for anyone or share a person's Ashby
authority with their workspace. Provider eligibility still applies. This PRD
does not introduce a workspace API-key connection or background recruiting sync.

## Motivation

The immediate evidence is the request on 2026-09-10 to add Ashby as a Rally
connector. Rally's current connector registry has no native Ashby entry. A user
can configure a custom MCP server, but must supply the endpoint and understand
its authentication rather than discover a supported Ashby connection in
Settings. Without a connection, recruiting work requires manually supplying
context and carrying changes back to the recruiting system.

No customer interviews, usage frequency, time savings, or revenue evidence were
provided. The hypothesis is that bringing recruiting context and deliberate
updates into the work stream makes Rally useful for recruiting tasks. Validate
that hypothesis with the acceptance workflows below; do not present an adoption
forecast as evidence.

Ashby's documented service provides the necessary starting point: personal
OAuth at `https://mcp.ashbyhq.com/mcp/v1`, with dynamic client registration and
access governed by the user's Ashby permissions. An organization admin enables
MCP in **Admin → Organization Setup → Opt-in Features**; eligible users then
connect individually. Analytics-only organizations are excluded. Its beta tool
schemas can change, so a static copy would be unreliable. These provider facts
were checked on 2026-09-10 in [Ashby's MCP documentation](https://docs.ashbyhq.com/ashby-mcp-server-beta).

## Goals

1. An eligible member discovers Ashby, completes personal authorization, and
   runs a useful recruiting task without entering a server URL or API key.
2. Recruiting reads use the connected person's provider permissions and return
   source-backed answers in the current work stream.
3. An explicitly requested provider mutation follows Rally's existing hosted
   MCP confirmation and receipt rules, with a visible, truthful outcome.
4. A second member cannot spend the first member's Ashby credentials by joining
   a work stream, sharing a link, or continuing the conversation.
5. Expired authorization, missing access, unavailable tools, and uncertain
   writes produce a clear next action without silent omissions or retry loops.
6. The same connection experience works in Global and EU, retaining Rally-owned
   credentials and product data in the workspace's region.

## Non-goals

1. **Workspace API keys or a service account.** Deferred: personal authorization
   fits individual recruiting access. A shared credential would require a
   separate decision about who receives organization-wide hiring authority.
2. **Background sync, webhook triggers, watches, and recruiting digests.**
   Deferred: this is an on-demand tool connector, not an ingestion subsystem.
   It declares no activity streams, event types, or watchable resources.
3. **An ATS replica or new recruiting screen.** Rejected for this proposal:
   Ashby remains the system of record; Rally provides the work stream.
4. **A new hosted-MCP safety policy.** Deferred: this connector does not remove
   confirmations for provider-described reads or trust remote safety hints.
5. **Autonomous hiring decisions or bulk hiring campaigns.** Outside this
   proposal: no automatic ranking, rejection, outreach, or stage changes based
   on an agent's inferred preference. Concrete human-directed updates remain
   within the available tool and authorization contract.
6. **A promised, fixed Ashby tool list.** Rejected: availability is determined
   by live discovery. Missing provider functionality is reported, not emulated
   through browser automation, private endpoints, or an API-key fallback.
7. **Unattended recruiting automations.** Deferred as a launch outcome: no
   change allows a workspace automation to inherit a member's personal grant,
   and no change bypasses a tool confirmation when nobody is present.

## Product behavior

### Discover and connect

**Settings → Connections** includes an **Ashby** entry under personal
connections, searchable by Ashby, recruiting, hiring, candidates, interviews,
and applicant tracking. The entry says: “Use your Ashby account for recruiting
work. Access follows your Ashby permissions.” It also identifies the provider
service as beta and explains that tool calls use Rally's confirmation flow.

The setup surface explains the provider prerequisite above and opens Ashby
authorization in the browser. Rally offers no workspace-scope choice, API-key
field, or editable server URL. A member does not need Rally administrator
status to connect their own account. One enabled Ashby personal connection per
member per Rally workspace matches the existing personal-connection experience;
reconnecting updates that connection rather than silently creating a duplicate.

The attempt belongs to the initiating member, workspace, and region. Switching
Rally workspaces while the browser is open cannot move the connection. The
callback follows the shared workspace-addressed desktop handoff and reconciles
against the stored attempt. Cancelled consent leaves the member disconnected;
an expired or replayed callback tells them to start again.

Success shows the connection with its personal scope and provider-verified
account or organization label when available. If the provider supplies no
verified label, show “Ashby — personal”; never infer identity from an email
domain or display a credential-derived identifier.

### Work in a work stream

The member asks for recruiting work in the composer. Rally discovers and loads
the eligible Ashby plugin, then uses its live tools. Loading does not fetch
candidate records, change hiring state, or start a background process.

Priority acceptance workflows are:

| User request | Required experience |
| --- | --- |
| “How is the pipeline for our backend role looking?” | Resolve the intended job, distinguish similarly named jobs, and report the scope and freshness of the returned pipeline information. |
| “Help me prepare for my upcoming interview.” | Resolve the interview and relevant candidate before preparing a factual brief with source references. Ask for a disambiguating detail when necessary. |
| “Find Jordan Lee's application for this role.” | Resolve candidate and application separately; show alternatives when the name is ambiguous. |
| “Add this note to the candidate.” | Identify the exact candidate and note text, use the existing confirmation flow, and distinguish a provider draft from a saved note. |
| “Move this application to the next stage.” | Discover the actual application and valid destination stage; make the exact target and change reviewable before execution. |

These are product acceptance scenarios, not hard-coded remote operation names.
The implementation validates them against a test account's live tool surface
before release. It never claims a scenario succeeded merely because a tool with
a similar name was found.

Results appear in the transcript. Use source links and identifiers returned by
Ashby; do not manufacture candidate, application, or interview URLs. Where a
result contains no usable URL, identify the record by its returned type and ID
and say that no direct link was supplied. A source reference is not a watched
resource and does not schedule updates.

Answers distinguish “no matching records” from “no permission,” and a partial
page from a complete dataset. Counts come from an explicit provider count or a
fully traversed result set with its filters stated. A current read is not a
transactionally consistent snapshot across several calls. Historical transcript
content is not represented as a fresh Ashby lookup.

### Authority, visibility, and confirmations

Only an eligible run under the connection owner's authority uses the personal
connection. Another participant needs their own connection for a new provider
operation. Joining a work stream or seeing an earlier answer does not grant
access to the original connection.

**Personal credentials do not make a shared transcript private.** Setup and
connection details say: “Only you can use this connection. Information you bring
into a work stream is visible to people who can view that work stream.” Users
can use a private work stream for sensitive recruiting work. This proposal
does not add field-level transcript access control or automatically widen a
work stream's audience.

All hosted-MCP calls retain the existing confirmed-write classification,
including operations Ashby describes as reads. The confirmation identifies the
Ashby connection, operation, and concrete arguments. A declined confirmation
causes no provider call. Loading a plugin or receiving tool results is never
blanket consent for subsequent changes. Provider-required draft/confirmation
steps are honored as well; a draft is not reported as a completed mutation.

Feedback submission to Ashby and communication to third parties require an
explicit user request. An agent encountering an error does not volunteer
candidate information to provider support.

### Connection and failure states

| State | What the user sees and can do |
| --- | --- |
| Not connected | Connect action, personal-scope explanation, and prerequisites. |
| Connecting | Pending browser authorization, with cancellation and shared attempt reconciliation. |
| Connected, tools not loaded | Connection is available; the first relevant task loads its current tools. |
| Loading tools | Visible tool/plugin progress. A failed discovery exposes no partial catalog. |
| Empty result | An explicit no-match result with the search scope; no invented candidate. |
| Provider access refused | A bounded explanation to check Ashby access or ask its admin; no inference that a hidden record exists. |
| Reconnect needed | Reconnect action for a refused grant. No repeated prompt for an API key. |
| Rate limited or unavailable | Explain that work could not finish. Honor supplied retry guidance; do not present cached content as current. |
| Offline | Connection management and live calls are unavailable. Existing transcript content remains historical; no provider write is queued invisibly. |
| Outcome uncertain | State that the operation may have happened. Stop duplicate execution and direct the member to inspect Ashby. |
| Disconnected | Future use is blocked and active runs lose authority at the next check. Historical work-stream content remains subject to Rally's existing retention and access rules. |

Connection testing is read-only at the protocol level: validate authorization
and discover tools, without invoking a recruiting tool or submitting feedback.
Disconnect removes local usable credentials and follows supported provider
revocation where available. Local disablement succeeds even when Ashby cannot
be reached; the UI does not claim provider revocation without confirmation.

## Impact on the product contract

None — this adds a personal connector within the existing work-stream and typed
tool contract. There is no global recruiting inbox, activity feed, or search
surface. The existing hosted-MCP confirmation policy remains a connector-specific
policy; this proposal adds no global approval gate to Rally's ordinary tools.

## Decision log

None yet.

## Key design decisions

1. **Use the official hosted MCP service.** Reuse discovery, OAuth, live tool
   loading, and receipts already used for personal connectors. A REST adapter
   would mean owning another catalog and an admin-key lifecycle. Ashby's REST
   API authenticates with a long-lived API key via Basic Auth, which is a
   different authority model ([API authentication](https://developers.ashbyhq.com/reference/authentication)).
2. **Personal scope only.** Workspace-wide availability is a distribution
   decision, not permission for every member to use one person's account.
   Reject automatically promoting a personal grant to workspace authority.
3. **Live discovery owns the catalog.** A later activation can learn changed
   provider tools. Do not ship a frozen list derived from documentation or an
   authenticated development account; [design.md](design.md) defines the exact
   mapping and verification obligations for every discovered tool.
4. **Keep the shared safety behavior visible.** Accept its confirmation cost
   instead of inventing a read allowlist as part of an Ashby integration. Any
   lower-friction hosted-MCP policy requires its own proposal.
5. **No feature flag.** The product owner's 2026-09-10 answer is “Available to
   all workspaces at launch.” No Ashby Flagship key or Ace registration is
   introduced. Authorization, regional readiness, and provider prerequisites
   still apply.

## Data model

Reuse WorkspaceDO-owned connector connections, encrypted credentials,
connection-owned grants, and OAuth attempt receipts. Register connector type
`ashby` and Rally capability `ashby.personal.mcp`. The latter is an internal
authorization capability, not an invented OAuth scope to send to Ashby.

OAuth correlation stays in regional D1 as defined by the shared connector
system. Execution, activation, and tool receipts stay with the existing
work-stream authorities. There are no candidate tables, bulk imports, sync
cursors, activity records, or backfills. Existing custom MCP connections remain
unchanged; adoption of the named Ashby connector is explicit.

## Regional impact

Global and EU expose the connector at launch. Each workspace's backend performs
its own OAuth exchange, discovery, and tool execution and stores credentials
and returned product content in its existing regional authorities. Use regional
callbacks; do not add a Global relay carrying EU authorization codes or results.

Ashby remains an external processor. An EU Rally workspace is not a promise
that Ashby's service itself is EU-hosted. Verify the provider configuration and
data-handling disclosure before launch; never retry an EU failure through the
Global Worker. Existing regional telemetry and inference policies apply.

## Security and trust model

Use the shared credential door, PKCE, single-use OAuth state, HTTPS origin
validation, and encrypted connection-bound credential envelope. The renderer,
model, shell, resource URLs, and logs never receive access or refresh tokens.
Provider OAuth endpoints must match explicitly verified origins; no wildcard
trust or user-supplied endpoint is introduced.

Treat tool descriptions, candidate content, attachments, notes, and returned
URLs as untrusted provider data. They cannot authorize other tools, change the
execution principal, or instruct the agent to disclose information elsewhere.
Minimize recruiting information to the requested task and preserve distinctions
between source facts and the agent's interpretation.

Reuse content-free connector diagnostics. Do not add candidate names, emails,
resumes, feedback, queries, record URLs, or tool payloads to analytics or support
logs. Provider content may enter the authorized transcript and existing governed
run storage; disconnect does not retroactively erase content already shared.

## Agent behavior

The static Ashby descriptor is deferred and searchable. Loading it exposes the
current authorized server surface under a connection-specific plugin. Every
tool uses `ashby.personal.mcp`, `mode: write`,
`idempotency: record_before_execute`, serial execution, and the existing hosted
MCP timeout. [The companion contract](design.md) specifies identities, wire
mapping, discovery, schemas, error handling, replay, and exact standing guidance.

The agent discovers records before referring to their IDs, disambiguates before
mutations, uses returned valid fields/stages rather than guesses, and follows
provider draft semantics. It stops on uncertain side effects and revoked
authority. It does not imply that personal connection ownership shields data
placed in a shared work stream.

## Provider configuration

Register the named connector in both regional registries and the desktop
catalog. Configure the shared OAuth helpers with the published MCP endpoint,
regional Rally callback URLs, and verified authorization origins. Dynamic client
registration identifies the client as Rally. No organization API key or
provider-wide secret is requested from the member.

Release evidence must verify the actual protected-resource metadata,
authorization metadata, requested scopes, DCR acceptance of both callbacks,
token refresh, and any client-registration or beta restrictions. These were
not authenticated during PRD preparation. Do not equate a published endpoint
with a working Rally authorization flow. Document provider requirements in
[provider apps](../../provider-apps.md) when implementation lands.

## Rollout

Ship without a feature flag to all workspaces after Global and EU acceptance.
Deploy regional backend support before exposing the desktop Connect action;
an older backend must show an unavailable action rather than a broken flow.
There is no silent installation, migration of custom MCP credentials, or
automatic population of recruiting data.

If release acceptance fails, hold the release and fix the connector. After
launch, rollback uses the normal release mechanism; disabling a broken
connector in the backend must block existing tool execution as well as new
connection starts while leaving disconnect available. Preserve stored encrypted
rows for recovery rather than deleting customer connections during rollback.

Update the durable connector, hosted-MCP, provider configuration, security, and
manual acceptance documentation alongside implementation. Write any phased
implementation plan only after this PRD is approved.

## Acceptance

1. **Setup:** complete authorization in Global and EU, including denial,
   expired/replayed state, workspace switching during consent, duplicate connect,
   refresh, reconnect, and disconnect. No token appears in client responses,
   tool output, configuration, or logs.
2. **Access:** use two members with different Ashby access. Each sees only
   provider-authorized records; neither spends the other's grant. Workspace
   automation and read-only child paths cannot inherit this personal tool
   authority. Verify changed permissions and disablement during an active run.
3. **Useful work:** complete each priority workflow against test records.
   Verify the final write in Ashby itself and demonstrate that declining the
   confirmation leaves the record unchanged. Do not mutate real candidates as
   an acceptance shortcut.
4. **Discovery:** load all catalog pages; reject collisions and malformed
   schemas; handle a removed tool and a changed schema without executing a
   differently named operation or replaying a changed confirmed plan.
5. **Truthful failure:** demonstrate empty versus denied reads, pagination,
   provider outages, cancellation, rate limiting, oversized output, and an
   interrupted mutation with an uncertain outcome. No false success or blind
   duplicate write is acceptable.
6. **Model usability:** on the configured medium fallback model, evaluate
   recruiting-keyword discovery, successful multi-tool work, an ambiguous name,
   a wrong ID family, a changed application stage, a missing tool, and stop
   conditions. Include the actual confirmation interaction and no-loop checks.
7. **Verification:** add connector/schema contract tests and appropriate real
   runtime integration tests; prove the integration behaviors fail when their
   production checks are broken, per [testing](../../testing.md). Inspect the
   setup, result, confirmation, and error states in a real desktop window.
   Implementation leaves lint, typecheck, and applicable tests green.

Use the acceptance sessions and existing content-free connector outcomes to
assess setup success and useful task completion. Record reasons for failed
tasks; no new metrics stack or invented adoption target is required to launch.

## Open questions

1. **Provider compatibility — blocks release:** which exact OAuth origins,
   scopes, callback registrations, refresh behavior, and account restrictions
   does a real Rally connection require? Verify before finalizing configuration.
2. **Live tool contract — blocks release:** can the current account-specific
   surface complete all priority workflows, including any provider confirmation
   step, within Rally's supported MCP features? If not, explicitly revise scope
   or implement the missing shared protocol support; do not claim support.
3. **External data handling — blocks release:** does the actual Ashby service
   configuration support the disclosures made to both Global and EU users?
   Record the verified answer without inventing an EU provider endpoint.
