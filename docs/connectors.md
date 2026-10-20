# Connector architecture

Connectors are typed adapters behind a registry. A manifest declares OAuth needs, supported personal/workspace scopes, activity and resource types, tools, polling, webhooks, and watches. The adapter owns provider protocol details; Rally owns tenancy, execution principals, persistence, retries, schedules, and audit.

The model state tool and desktop share `connectorAuthorizationStatus`: only
`needs_reconnect` means **Reconnect required**. Generic
`error` states, such as a failed background poll, display as healthy because
they do not establish that authorization needs renewing. `disabled` remains
distinct. A committed successful poll clears only `connector_poll_failed` and
`connector_poll_timeout` errors; other diagnoses are preserved. Poll failure
cannot replace `needs_reconnect` or `disabled`. Provider refusals can replace
generic errors, preserving the first authorization diagnosis.

This availability rule covers every generic error, including
`custom_mcp_unreachable` and Linear, Notion, or Slack route-registration failures.
Connected describes authorization availability, not provider reachability or
inbound delivery health: route registration can fail while outbound tools remain
usable, and an unreachable custom MCP endpoint still reports its execution error.
These diagnostics remain stored; only a provider authorization refusal establishes
a reconnect verdict. GitHub installation suspension also records
`needs_reconnect`; its unsuspend webhook restores healthy authorization. Every
diagnosis-carrying refusal path promotes both healthy and operational-error rows,
while preserving disabled connections and existing authorization diagnoses.

OAuth deliberately crosses one authority boundary. Regional D1 owns the
single-use encrypted `oauth_states` row because the callback must be validated
and routed before a WorkspaceDO can be addressed. The selected WorkspaceDO owns
`connector_oauth_attempts`: the user-visible pending/succeeded/denied/failed
receipt, telemetry correlation, and resulting connection pointer. Start writes
the object receipt before advertising the D1 state; a failed D1 write removes
the pending receipt best-effort, with expiry as the final orphan fence. Callback
success commits the connection row and attempt's `connection_id` in one
WorkspaceDO transaction; only the opaque D1 ingress-route synchronization is a
recoverable post-commit edge.

The callback target also carries the attempt's owning `(region, workspace_id)`.
OAuth state remains the server authority: changing the active desktop workspace
while consent is open cannot rebind the attempt or connection. The desktop treats
the callback as an explicit destination, activates that exact workspace through
the ordinary membership and meeting-change guard, and only then refreshes its
connector caches. If the state cannot be resolved, the server emits an
unaddressed failure because inventing a workspace would be less safe than asking
the member to restart. This path is shared by Google, GitHub, Granola, Linear,
Notion, and Slack; a provider-specific callback must not mint its own link shape.

Connector start advertises `desktopHandoffVersion=2` as an additive query
capability. The regional service persists the matching return URI with the OAuth
state: version 2 uses the fail-closed `workspace/<region>/<workspace>/auth/complete`
shape, while an omitted capability retains the legacy unaddressed callback for
the older initiating desktop. An older API safely ignores the query marker and
returns the legacy shape to a newer desktop. The pending attempt itself lives in
the application session rather than a Settings component, so changing workspace
or remounting Settings does not orphan reconciliation.

An opted-in conversation feed may start that same flow from a validated agent
tool card. The
tool stores only a connector catalog id and requested scope; the desktop maps
that id to the provider, capability bundle, presentation, and regional OAuth
route already used by Connections. Reconnect uses the existing connection row.
The model never supplies the authorization URL or requested capability list,
and the card's presence is not evidence that OAuth completed. A paired read
tool resolves the same catalog id and scope against caller-visible WorkspaceDO
rows, returning durable `connected`, `reconnect_required`, `not_connected`, or
`unavailable` state without pretending to have made a fresh provider call.

The started tool fact retains the validated catalog id and scope, and transcript
lifecycle updates carry that safe input into the terminal fact. The feed can
therefore reconstruct the card from durable history after reload, pagination,
recovery, or virtualization. Summary-only interrupted-run recovery uses the
same shared summary formatter as the writer. Arbitrary assistant prose cannot
create a card.
Unknown connector IDs or scopes in completed structured tool requests render a generic
**Connector not recognized** card with **Update Rally** (desktop) or **Reload
Rally** (browser), including when agent work is hidden. This is display-only;
the card never authorizes an unknown provider or starts OAuth. Hosts without
connector setup, including guests, do not show it. Desktop update checks and
downloads show live progress before offering a restart when ready.
Adjacent repeated presentations of the same connector and scope collapse to the
newest durable row, while an intervening conversation row keeps a later request
as a separate occasion.

The card shows connection state alongside a separate **Reconnect** action for
an existing connection, including one still reported as healthy. New connections
show **Connect**. The active connections query owns the displayed state; the
feed's success latch only bridges a loading/remount gap. OAuth completion
publishes the workspace socket's `connector_connections` topic to refresh it.
A healthy existing grant does not itself complete a new reauthorization attempt:
the callback or OAuth-attempt reconciliation clears the waiting state. The card
checks the attempt on mount, focus, connection refresh, and workspace OAuth topic
updates. Multiple matching connections require an explicit account selection.

Apollo.io uses the personal-only [hosted-MCP connector](hosted-mcp-connectors.md).

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/external-people.ts` | Shared deduplication and the 10,000-person activity limit. |
| `apps/api/src/durable-objects/connector-event-people.ts` | Ordered event-owned person rows, legacy readback, and schema-only v122. |
| `apps/api/src/services/connector-queue-payload.ts` | Canonical-event references for oversized connector delivery context. |
| `apps/api/src/durable-objects/workspace-event-resources.ts` | Exact workspace/connection/provider identity resolution for incoming event relationships. |
| `packages/connectors/src/index.ts` | The registry, and the cross-validation that runs at its construction. |
| `packages/connectors/src/types.ts` | The manifest and descriptor types, and the unexported symbol that brands `AuthorizedConnectorConnection`. |
| `packages/connectors/src/provider-utils.ts` | `withProviderReauthorization` — the shared mid-call recovery every adapter routes through. |
| `packages/connectors/src/hosted-mcp.ts` | The reusable hosted-MCP OAuth, live discovery, and exact call-forwarding abstraction described in [`hosted-mcp-connectors.md`](hosted-mcp-connectors.md). |
| `packages/connectors/src/<provider>.ts` | One adapter per provider. |
| `apps/api/src/services/connector-connection-access.ts` | `withAuthorizedConnection` — the one door that mints the brand. |
| `apps/api/src/services/connector-credential-refresh.ts` | The refresh coordinator and its WorkspaceDO-local lease. |
| `apps/api/src/services/connector-actor-identity.ts` | `resolveConnectorActorIdentity` over `external_user_identities`. |
| `apps/api/src/services/user-delivery.ts` | Whether a connection is a personal delivery destination for a given user. |
| `apps/api/src/services/connector-tool-inventory.ts` | Shared dynamic inventory validation and model-facing tool names for activation and Settings counts. |
| `apps/api/src/lib/connector-registry.ts` | Which connectors this region registers. |
| `apps/api/src/queues/activity-consumer.ts` | Regional Queue admission into WorkspaceDO, native connector-event retry, and the reusable routing processor, including `activityIsDigestible`. |
| `apps/api/src/workflows/connector-poll.ts` | `pollCheckpointedActivityStreams` and the shared checkpoint runner. |
| `apps/api/src/workflows/connector-event.ts` | Drain-only compatibility for connector-event Workflow instances created before the Queue-processing cutover. New events never create one. |
| `apps/api/src/durable-objects/workspace-do.ts`, `workspace-domain-schema.ts` | Connector credentials/configuration, external identities, workspace-local Slack/handoff state, normalized event authority, ingress receipts, processing claims, and settlement. |
| `packages/contracts/src/connector-api-keys.ts` | Per provider: the page that issues its API key, and the key format the provider documents — the one declaration the API's request schema, the adapter's own check and the desktop field all read. |
| `apps/desktop/src/renderer/components/connector-api-key-field.tsx` | The paste step as one control: the issuing link, the field, and the message shown when a paste cannot be that provider's key. Every surface that takes a key uses it — Granola's and Ashby's setup modals, and **Replace workspace API key**, which appears only for an installation whose provider still takes one. |

### Pasting an API key

Some connectors are configured by pasting a key rather than by an OAuth round
trip, and the product rule for that step is one key and nothing else: somebody
pastes it and Rally does the rest. Two things are declared per provider in
`packages/contracts/src/connector-api-keys.ts`, and every surface that takes a
key reads them from there — the Worker's request schema, the adapter's own
check, and the desktop key field:

- **Where the key is issued.** `issuingUrl` is the provider page that creates
  the key — Ashby's admin API keys page — so the link opens the place the key
  comes from rather than a documentation page to read first. Granola is the exception in the other direction: its workspace
  keys are created in the Granola desktop app and it publishes no web page that
  issues one, so that entry points at the help-centre article and the modal's
  numbered steps carry the rest.
- **What a key looks like**, but only where the provider documents it.
  `format` holds an anchored pattern, the placeholder the empty field shows, and
  the sentence shown when a paste does not match. Granola documents `grn_`; that
  pattern is the same object the API's request schema and the adapter's own
  check use, which is what stopped the three copies of it drifting. **Ashby
  declares no format, deliberately.** It documents none — its authentication
  page shows a key only as a basic-auth username — and a prefix guessed here
  would reject a valid key at the exact step this exists to smooth, so a
  provider with no documented format is checked only for being non-empty.

A mismatch is said out loud under the field, not left as a Connect button that
refuses to light up with no reason given — but not while somebody is still
typing the key: the verdict waits for a paste or for the field to be left,
because a half-typed key is not a wrong key. The submit button beside it asks
`connectorApiKeyAcceptable`, so the message and the gate cannot answer
differently.

**Fireflies has no entry, and that is the worked example of what this list
means.** It still has workspace installations — the ones made before that scope
was withdrawn keep their tools, their ingress and their activity — but no
Fireflies key is pasted into Rally any more. The personal connection is OAuth,
the workspace setup was removed, and `replaceInstallationApiKey` refuses a new
credential for a scope the connector no longer connects, with 422
`connector_scope_not_connectable`, before the key is validated or stored. Such
a connection works until its key changes and no further; deleting it is the
management that remains. An entry here would describe a paste that cannot
happen, and `isConnectorApiKeyProvider` — which is what **Replace workspace API
key** asks before drawing a field — would offer one.

The catalog is keyed on `ConnectorApiKeyProviders`, its own list, rather than on
the installation-provider enum the same three names happen to fill today.
"Somebody pastes a key into it" and "Rally manages its event subscriptions" are
different questions, and a connector installed over OAuth would otherwise have
to invent an issuing page to satisfy the guard.

### Reading provider files

A connector that reads a provider file uses one converter, never its own parser. Google Drive and Slack do today. `packages/connectors/src/documents.ts` defines the contract:

- `ConnectorDocumentReader` is the host's converter. The API builds it in `apps/api/src/services/connector-document-reader.ts` over the attachment pipeline's `buildAttachmentDerivative`, so a connector file converts like the same file uploaded: plain text, Word, Excel, PowerPoint, and PDFs, with OCR for a scanned PDF, metered to the connection's workspace as `document_ocr`. Unlike an upload, nothing is stored: every read converts again, and a scanned PDF is OCR'd and billed each time.
- `createConnectorRegistry({ documents })` hands it to every adapter that takes a `documents` config field.
- `readConnectorDocument({ reader, file, connection, textBudgetBytes, signal, download })` is the only call an adapter makes, for a file `reader.reads` accepts. It skips the download when the declared size exceeds the converter's ceiling, reads the source bounded by that ceiling, converts it, and cuts the text to the adapter's budget with `contentTruncated: true`. There is no cursor past the cut. A failure comes back as a code in `contentOmittedReason`: `source_too_large`, or the converter's own, such as `invalid_office_archive`.

To read files from another provider, describe the file (`fileName`, `mimeType`, `size`), pass a `download` that returns the provider's authenticated `Response`, and map the returned fields onto the tool's output. The adapter keeps its own URL trust checks and credentials; the reader never sees them.

### Authorization model

Rally-authored cursor tools use [first/next pagination](tool-pagination.md).
Adapters extract their known continuation field before bounding content; the
run's receipt authority stores it and returns a plugin-prefixed page ID. Native
tools are opted in explicitly, while hosted MCP schemas/results remain untouched.

- A personal connection can be used only by its owner principal.
- A workspace connection is an organization capability: every ad-hoc work stream in that workspace receives all tools granted to the connection. Those tool calls execute as the workspace principal, even when the run was started by a member.
- Workspace automations remain explicitly bound to selected workspace connections so a published automation cannot silently change providers or accounts.
- A work-stream participant does not expose their personal connections by joining.
- Tools require both a manifest capability and a capability recorded on the connection.
- Credentials are decrypted only for the duration of a backend operation.

Hosted MCP personal connections add one more layer without weakening those
rules. Their static connector descriptor supplies trusted catalog prose and
policy, while the provider supplies the active tool names, descriptions, input
schemas, and informational annotations through `tools/list` after `load_plugin`
reauthorizes the connection. Annotations never downgrade Rally tool policy,
and Rally never copies that response into source. The shared
mechanism and provider recipe are in
[`hosted-mcp-connectors.md`](hosted-mcp-connectors.md).

### Settings tool counts

The Connections tables show a numeric count under the Tools heading, and every
count arrives in `GET /connections` itself (`Connection.toolCount`), so opening
the tab is one request. The count is what the agent would be offered: tools
matching the connection's grants and scope.

- **A fixed tool surface** is counted in the list handler from the adapter's
  `agentPlugin.tools` and the row's grants, with no I/O — and counted as
  activation expands it: a paginated definition arrives with its generated page
  tools (`gmail.search` brings `gmail.search_next`; `read_resource` brings a
  `_next` and `read_resource_previous`). The names come from
  `paginatedToolNames` in `apps/api/src/services/tool-pagination.ts`, the pure
  rule `withToolPagination` builds its tools from, so the count and the
  activation cannot drift. The released per-row endpoint counts the same way.
  A discovered surface is not expanded, because activation does not expand it.
- **A live-discovered surface** (hosted MCP, custom MCP) reports
  `connector_connections.discovered_tool_count` (WorkspaceDO migration 73): the
  count its last successful discovery found. A discovery counts exactly what activation
  would expose — the live inventory through the credential door, validated by
  `validateDynamicConnectorTools` — under the existing 20-second Settings
  inventory deadline. It is written when discovery already runs or the
  connection changed: after an OAuth completion or reconnect (in the
  background, behind the handoff), after a passing Test, by the custom-MCP tools
  read and therefore by a tool-policy save, and by the released
  `GET /connections/:id/tool-count`. A row the list finds with no count
  reports `null` and has one discovery started behind the response — one per
  connection, ever: the list claims `tool_count_backfill_attempted_at` (same
  migration) with a returned witness before any provider call, so concurrent
  lists start it once and a failed one is not retried behind later lists.
  After that, only the paths above refresh the count.
- **A failed discovery clears the count.** A timeout, a provider error, or
  `validateDynamicConnectorTools` refusing the catalog (a name collision) leaves
  `load_plugin` offering the agent none of those tools, and none of them moves
  the row's status off `healthy` — so an old number there would read as a
  working connection. The discovery sets `discovered_tool_count` to `NULL`
  under the same fence as a successful write and publishes the same way, then
  logs `connection_tool_count_refresh_failed` with the adapter's code. An
  authorization refusal is the one failure that keeps the count: the credential
  door has already marked the row `needs_reconnect`, which is what the badge
  shows, and a reconnect to the same account offers the same tools. A caller
  that aborts (a closed per-row request) is not a provider failure and clears
  nothing.
- **Every write is fenced** on the `granted_scopes_json`, `config_json` and
  `provider_account_id` the discovery ran under, so a late answer — a count or a
  clear — never overwrites what a newer policy, grant or reconnect already
  changed, and it publishes `connector_connections` with `{ connectionId }`
  only when the stored value moved, which refetches the list in that
  connection's audience.
- **`null` is never zero, and says why.** `Connection.toolCountMissing` names
  the reason: `disabled`; `connector_unavailable` (the region does not register
  the connector — static configuration, so it is reported on the row rather
  than logged on every list, and the registry is read once per list);
  `counting` (this list just started the connection's one background
  discovery); `not_counted` (the last discovery failed, or one started earlier
  has not finished). The desktop draws a dash whose `title` and accessible name
  say which. The field defaults to `null`, so a region that predates it still
  parses; the desktop then reads `disabled` from the status and says only that
  there is no count otherwise.
- **No staleness window.** Nothing re-discovers a count it already has on a
  timer or an age. A server that changes its catalog with no Rally-side event is
  reflected at the next event above; adding a refresh window is a limit whose
  number the team has not chosen
  ([`adding-security-defensive-and-other-limits.md`](adding-security-defensive-and-other-limits.md)).

`GET /connections/:id/tool-count` stays for desktops released before the list
carried the count. It still discovers live on each call; the current desktop
never calls it.

### Credential freshness

Every adapter entry point that authenticates to a provider — `executeTool`, `healthCheck`, `hydrateResource`, `poll`, `pollingActivity.pollStream`, and `revoke` — takes an `AuthorizedConnectorConnection` rather than a `ConnectorConnectionContext`. The difference is a brand that cannot be produced by writing an object literal, because the symbol keying it is declared in `packages/connectors/src/types.ts` and never exported. Refreshing an expiring credential before calling a provider is therefore not a step a caller can forget: it is a value a caller cannot otherwise obtain.

`withAuthorizedConnection` in `apps/api/src/services/connector-connection-access.ts` is the one door that produces one, and ESLint pins the import that mints the brand to that module. Around the operation it owns the three duties that used to be stacked by hand at each call site: refreshing through `ensureFreshConnectorCredentials`, persisting credentials the adapter rotated in place, and marking a connection `needs_reconnect` when the provider refuses the authorization. Stacking them by hand is what produced the defect this design replaces — `load_plugin` revalidation and resource hydration each reached a provider with a credential nobody had refreshed, and a Granola personal connection, whose MCP access token is the shortest-lived credential Rally holds, became unloadable a few minutes after it was connected while the connections screen still showed it healthy.

For a harness connector tool, one live run-authority and connection-row check runs before looking up a completed receipt or starting execution. Its validated row is carried through that invocation's credential preparation and provider effect. A completed receipt needs the same initial check, while an interrupted attempt that bypasses the ordinary before-tool hook falls back to a fresh read during preparation. Active tool listings between model turns use their frozen activation scope and do not read the connection row. A revocation during an already authorized invocation may allow that invocation to finish; the next tool call checks current authority again.

The Sidekick creator's connector tools make the same invocation-scoped tradeoff:
the first membership and connection-row reads run together before credential
preparation, and a refresh does not trigger a second authorization read before
the provider effect. Revocation during that invocation may let it finish; the
next creator tool checks again.

The claim is scoped to adapter entry points. A few host paths need only a fresh token rather than a connection to hand an adapter — `slack-agent-service.ts`, `slack-unfurl-refresh.ts`, and `slack-notification-service.ts` each call `ensureFreshConnectorCredentials` directly to read a bot token — and the brand correctly does not apply to them. They get freshness, but not the mid-call recovery below, because they are not making a call an adapter would recover.

Rotation is available to every connection a person has not disabled. The coordinator's lease claim, its credential reload, and the write that stores a rotated credential all admit any row except `disabled`, so a connection this database believes is broken is refreshed and rotated exactly like one it believes is fine, and the provider gets to say whether the belief was still true. A successful token refresh preserves status: it proves token liveness, not that every required scope is present. Reauthorization and explicit connection tests can heal authorization diagnoses; successful polls heal only polling diagnoses.

Freshness at the door is necessary but not sufficient, because a credential can be revoked or expire while a call is already in flight. `withProviderReauthorization` in `provider-utils.ts` is the shared recovery: a provider that refuses the credential gets one refresh and one repeat of the call, and a second refusal is raised as the real one. Adapters must route their authenticated provider calls through it rather than carrying a private copy, and must not report a first rejection as a revoked grant.

Two things about that recovery are easy to get wrong, so neither is left to the caller. **What counts as a refusal is provider-specific and is never inferred from the `unauthorized` code alone** — adapters raise that for policy and configuration failures that never reached the provider, and spending a single-use refresh token on one buys a retry that fails identically. Each adapter states its own vocabulary through `isProviderCredentialRejection`, which additionally admits only errors carrying provider response details: Granola matches a 401 from its MCP transport and not a 403, Slack matches `token_expired` and not the settled answers around it, Google matches the two reasons a new access token resolves. **And the rotation itself is serialized by the host**, not performed beside the coordinator: the door hands the adapter a `rotateCredentials` that claims the same WorkspaceDO-local lease, so two calls refused at the same moment cannot each redeem a rotating refresh token and leave the loser marking a connection `needs_reconnect` that its sibling had just rotated successfully. A caller that finds the stored credentials already changed adopts them instead of redeeming over them.

Two adapter obligations sit alongside that. **A health check answers a question and must not write.** Reauthorization calls it on every plugin activation, so a read-shaped call that quietly repairs provider state does so on that cadence; an adapter with state worth restoring uses its installation-management facet, or `repair` when it has no installation lifecycle. Only an explicit connection test invokes repair; Granola webhook restoration belongs solely to the shared lifecycle. A repair never fails the test, and its outcome is reported in the test result either way, because a connection whose delivery is still broken must not read the same as one that was fixed. The health check reports the same condition without failing on it: the authorization is sound and every read tool works, so failing would take a usable connection out of every run to describe a problem only the test can fix. **And a token-endpoint failure is classified by the provider's error code, not its status.** `isRevokedGrantError` treats `invalid_grant`, `expired_token`, and `invalid_token` as a dead grant and everything else the provider names as Rally's problem, because OAuth reports a revoked grant and our own malformed request with the same HTTP 400 — and marking a member's working connection `needs_reconnect` over our bug is the worse of those two mistakes. `providerJsonResponse` carries the code through as `details.providerError`, read from `error` or `code` and from either nested, since Notion keys its token-endpoint envelope differently from the OAuth spec. When a provider names nothing at all the original status test stands: an unclassifiable failure that leaves a dead connection reporting healthy, prompting nobody while every call fails, is worse than one that asks for a reconnect that was not needed.

Both halves are held to account by `connector-credential-freshness.test.ts` — see
[Testing](#testing).

### Stored status is a belief, not a gate

`connector_connections.status` records what Rally observed the last time it looked. It is not a fact about the grant, and nothing re-checks it: a row marked `needs_reconnect` at 08:00 says exactly as much at midnight, whether or not the credential was repaired in between. **A belief must never be the reason Rally declines to attempt something a provider is asking it to do.** If an incoming request can be answered, answer it. The provider's response is the only thing that is current, and it is what decides the outcome.

There is one exception, and it is a different kind of value. `disabled` is a person's decision, so it is authoritative and it is honoured everywhere. Every other status — `healthy`, `error`, `needs_reconnect` — is a guess about the past. Query for `status <> 'disabled'`, never `status = 'healthy'`, wherever the row is being consulted to decide whether to *try*.

That applies to the whole inbound surface, not merely to tool calls: provider webhooks, Slack events and interactions, identity linking, automation delivery, resource hydration, scheduled polls, and the plugin catalogue an automation is built against. It applies to writes as much as reads — a credential an adapter rotated must be storable on a row the database believes is broken, since that rotation is very often the thing that fixes it.

*This rule was written after a Slack workspace connection spent sixteen hours refusing work it could have done. A scheduled refresh found the installation missing a bot scope Rally had begun requiring after the workspace installed it, and marked the row `needs_reconnect` — correctly. From then on the mark, not the grant, was what failed every request: the refresh coordinator filtered its lease and its credential reload on `status = 'healthy'`, so each new Slack event was refused with `Connector authorization is unavailable` without a single call being made to Slack. The refusal then overwrote `error_json` with its own generic reason, erasing the accurate `missing_scopes: reactions:read` diagnosis hours after the fact. Every work-stream link shared in Slack during that window lost its unfurl permanently, because Slack reports `link_shared` exactly once and never redelivered it. Nothing in the sequence after the first mark involved Slack's opinion at all.*

Three consequences follow, and each is load-bearing:

- **Marking is still allowed; refusing to try is not.** A provider that genuinely refuses still marks the row, and the desktop still asks for a reconnect. What changed is that the mark no longer prevents the next attempt from reaching the provider.
- **A mark records the first, most specific diagnosis.** The writes that set `needs_reconnect` accept `healthy` and `error` but exclude `disabled` and existing `needs_reconnect`, so a row that is already marked keeps the verdict that explains why. Re-marking on every later attempt is what replaced a precise scope failure with a bare `unauthorized`.
- **Success heals.** Success clears the diagnosis it actually disproves: a successful poll clears polling errors; a full connection test or reauthorization clears authorization errors. Token rotation alone does not prove missing scopes have been granted.

Recovery is part of the contract too. A durable job that failed on authorization may be classified non-retryable — that is correct while a grant is dead — but something has to lift the ceiling once the connection is reauthorized, or the outage becomes permanent for every request that arrived during it. `redriveReauthorizedIngress` is the Slack example: a job whose connection has been written since the job last failed is re-queued, which is self-limiting because a job that fails again stamps itself newer than the connection.

### Actor identity and work-stream attribution

The resolver preserves guest identity for attribution, using the role returned by
its existing regional membership query. Automatic connector audience admission
excludes guests, including on legacy conversations; a provider audience cannot
create an unrelated grant. Slack also excludes guests from automatic creator
seating and session assignment. Explicit scope sharing remains the admission
path, and guests retain access to connectors within their shared workstreams.

Every connector that can start work from a provider identity resolves that identity to an
Rally member through one shared mapping, `resolveConnectorActorIdentity` over
`external_user_identities`. This is the contract for every agent connector rather than
per-connector logic: Slack's Agent surface is the only caller wired today, and Linear's
native-agent sessions and every later agent connector are expected to resolve through it
instead of repeating a provider lookup of their own. The mapping is tried strongest first:

1. **`account_link`** — a mapping already recorded for `(workspace, provider, provider tenant,
   provider user)`, including the ones the opportunity directory sync republishes from
   confirmed Slack account links and personal connections.
2. **`personal_connection`** — a personal connection of that provider, not disabled, whose normalized
   identity is the actor. The member authorized that account themselves, so an exact match is
   that member. The comparison uses the `providerTenantId`/`providerUserId` pair every OAuth
   callback writes to `config_json`, not `provider_account_id`, which is provider-shaped:
   `<team>:<user>` for Slack, the organization for Linear. An explicit null user ID
   excludes the connection from identity matching and directory sync; only older
   connections that omit the field may fall back to their provider account ID.
3. **`verified_email`** — a provider-verified address held by exactly one active workspace
   member. An ambiguous or unknown address resolves to nobody.

Only a `verified_email` resolution is recorded. The stronger tiers are already durable — a
stored row, or the connection itself — so re-recording them would add a write to every inbound
provider message, churn the `updated_at` ordering the opportunity directory reads, and relabel
another writer's row with a synonym of its own label. `verification_source` therefore has
several vocabularies in the table (`slack_user_link` and `personal_connector_oauth` from
`syncVerifiedIdentityDirectory`, `verified_email` from this resolver); each is mapped back onto
the tiers above on read, so a stored row is judged at the strength it was recorded with and
re-recording cannot silently promote it. The write is also monotonic: a `verified_email`
observation never replaces a stronger stored mapping, because a provider profile can carry an
address belonging to a member other than the one that identity is linked to.

A work stream a connector creates for a resolved member records them as its
`created_by_user_id` and adds them as a participant with `participation_reason = 'creator'`,
so it reads as their work rather than as workspace automation. When a mapping only arrives
later — the member links their account or joins the workspace after the task ran — the
connector credits their earlier ownerless work streams then, promoting the participation
reason it recorded at the time.

An existing creator is never rewritten, with one exception: an explicit account link may
correct a creator that the same connector session's own `verified_email` guess produced. The
link is the stronger statement about who that provider identity is, and the address it
disagrees with can belong to somebody else. The member it displaces stays a participant.

Taking a task over is not the same claim as starting it. Where a connector lets another member
assume a task's authority, only the member the actor resolves to is credited; the one who took
it over stays a participant.

Attribution is not authorization. A resolved member does not authenticate the actor, does not
expose that member's personal connections, and never changes the execution principal: an
unlinked author's task still runs with the workspace principal. Message authorship is also
untouched — the opening message keeps its external actor, so the transcript still shows which
provider identity wrote it. A connector that cannot map its actor leaves the work stream
ownerless instead of guessing a member.

### A work stream's audience is the conversation it started in

`connector-workstream-audience.ts` holds the second half of the same idea, and it is
connector-wide for the same reason: **a work stream starts with the audience of the
conversation it came from.**

- A conversation the provider calls public opens a public work stream by storing the existing
  `workspace` scope, readable by the workspace like any other. This is the branch that has to
  *say* something: a work stream is born private, so a create that lost this scope on the way
  through would narrow a channel's work stream to whoever happened to be resolved from it.
- A private conversation — a private channel, a direct message, a group message — opens a
  private work stream by storing the existing `personal` scope, whose participant room starts
  with that conversation's resolved members. A conversation the connector cannot classify is
  treated as private: that is the fail-closed direction, and the two mistakes do not cost the
  same.
- **A conversation past the connector's size threshold is `workspace` whatever its privacy
  says, and seats nobody.** Below the threshold a conversation is a room, and modelling it as
  one is what makes the work stream findable by exactly the people who were in it. Above it
  that stops being true in both directions: nobody experiences a sixty-person channel as
  private, and the participant list standing in for it is a large stale copy of a membership
  the provider already maintains. The widening is deliberate and is the cost — such a work
  stream is readable by workspace members who are not in that conversation — and is taken
  because a work stream nobody can find is the worse failure at that size. It also skips the
  identity resolution entirely, which is the expensive half of reading a roster.
  **Each connector states its own threshold; there is no shared default**, because what counts
  as too many is a fact about that provider's conversations rather than about Rally. Slack's
  is `SLACK_CONVERSATION_WORKSPACE_SCOPE_THRESHOLD`, 50. A listing that *fails* reports zero
  and leaves the scope to the conversation's privacy, so a provider outage cannot publish a
  private channel's work stream.
- **The room is seated from the conversation whatever the scope says.** Scope and membership
  answer different questions — Rally's visibility rule and the provider's are not the same
  system, and the provider's is the one that knows what the person meant. Somebody who summons
  Rally in a channel means the people in that channel to be in the work stream, so the roster
  is read and seated for a public conversation exactly as for a private one. Seating people who
  could already see it costs nothing; the alternative is a work stream that is *visible* to a
  channel while belonging to nobody in it, which then empties itself the moment anyone narrows
  the scope. **The whole roster goes in, and Rally caps nothing.** The create used to be
  bounded at 25 participants, which a channel routinely exceeds and which did not degrade when
  it did — it failed the create outright. Truncating instead would have been Rally deciding
  that some of the people in the conversation are not in the room, which is the provider's fact
  to state. The only bound left is the provider's own page size
  (`SLACK_AUDIENCE_MEMBER_LIMIT`, Slack's 200), and anyone past it is seated when they reply.
- Anybody who can reach the conversation may continue the work stream. A member who arrives
  later is seated by their own message — **on every message, whatever the work stream's scope**,
  because the question that admission answers is "is this person in this conversation", not
  "is this work stream private". That is what makes a private work stream answer them rather
  than 404 at them, and what keeps a public one's room honest as the channel's changes. Membership is only ever admitted, never revoked — somebody who leaves
  the provider conversation keeps the work stream, because removing them is a membership
  decision a person makes. Connector admission publishes the same `participant_added` event as
  the in-product participant picker, so connected clients see the durable room change immediately.
- A person the connector cannot map to a Rally account is not an obstacle. Their message is
  recorded under their external actor, because a work stream that silently drops what somebody
  said in the conversation it lives in is worse than one whose participant list is shorter than
  the channel's.

**Each message runs under the authority of whoever sent it**, resolved per message rather than
per conversation: a member with an *account link* runs as themselves, and everybody else runs
under the workspace principal. This is the one place the strength tiers above are load-bearing
rather than descriptive — a run spends personal connectors, memory, and approvals made in
somebody's name, so nothing weaker than a link may authorize one. A `verified_email` match is
enough to credit somebody and enough to seat them in a private room; it is not enough to spend
their credentials. Two consecutive messages in one conversation can therefore run under
different principals, exactly as they do when two members type into the same work stream in
Rally. How "runs as themselves" reaches the work-stream object is the connector
principal — `principal: "connector"` on the shared auth context, set only after verifying the
link on the delivered message; the mechanics and the invariant behind it live in
[`slack-integration.md`](slack-integration.md#who-a-slack-work-stream-belongs-to) and the product-auth bullet of
[`workstream-durable-object.md`](workstream-durable-object.md#invariants), and the next adapter
that runs a member as themselves goes through the same marker.

Conversation rosters resolve as a batch. The connector asks D1 once for every identity it already
knows, enriches only the unresolved provider members, and bounds that provider work by concurrency
and one shared deadline. Do not turn roster size into one database query and one unconstrained API
request per member: private conversations may legitimately reach the connector's 200-member cap.

### Delivering a digest to a person

A connector that can hand a finished digest to a specific person declares `userDelivery` in its manifest: the `targetType` stored on the digest destination, the label and one-line description the Daily digest's **Send to** choice shows, and `requiresPersonalIdentityLink`. Nothing about which providers can deliver is written into the API or the client — declaring this is what puts a connection in the digest's destination list, and a connector that declares nothing is never offered. The scheduled digest ([`digests.md`](digests.md)) is the one consumer. It used to serve personal automation results as well; automations no longer have destinations of their own — a run sends its result with the connector tools it holds, inside the loop — so a connector that starts declaring a surface becomes a digest destination without the digest changing.

`requiresPersonalIdentityLink` marks the providers whose installation is workspace-wide. A team-wide bot addresses nobody on its own, so such a connection becomes a destination only for a user who has linked their own provider identity to it. `apps/api/src/services/user-delivery.ts` answers that question: it maps each delivery target type to the table recording "this Rally user is this provider user on this connection" — `slack_user_links` for `slack_agent_dm` — and is the one place a new linked provider is registered. A target type absent from that map needs no link, because its connection already belongs to one person. The connections endpoint resolves `userDelivery` per requesting user, so a disabled connection, an unlinked installation, or a connector Rally does not register in this region is simply not a destination. A connection merely marked `needs_reconnect` stays a destination: the send is what discovers whether the credential still works.

Saving a **digest** destination runs the same resolution. `resolveFrozenDeliveryIdentity` asks `resolveUserDelivery` whether this connection is a destination for this user — the identical declaration, health, and identity-link test the settings screen was offered on — and only then calls the target type's entry in `FROZEN_IDENTITY_RESOLVERS` for the provider tenant and user to store. Eligibility is therefore stated once: the API cannot reject a destination the screen offered, and no rule about connection scope is written into the save path. Nothing about which providers can deliver lives in the API or the client.

Slack declares `slack_agent_dm` with a required identity link. Teams or Discord would declare their own target type the same way and register it in `AutomationDeliveryTargetTypeSchema` (kept under that name because digests and receipts share it), in `PERSONAL_IDENTITY_LINKS` if the surface needs a link, in `FROZEN_IDENTITY_RESOLVERS`, and in `CONNECTOR_DELIVERIES` in `digest-delivery-service.ts` — but no schema change: `digest_delivery_targets.target_type` is checked per family (email versus connector-addressed) rather than enumerated. A target type with no resolver is refused at save rather than half-stored. The two identity columns are still named `slack_team_id` and `slack_user_id`; they hold the provider tenant and user of whichever connector owns the row, and a second connector is the point at which renaming them earns its migration.

### Being found, and being refused

Two things every connector owes a run, both settled on the descriptor rather than per-connector in the host.

**`searchAliases` is the vocabulary of the work, not the brand.** A connector used to be reachable in the plugin catalog only by its provider type and wire prefix, so "file a ticket" matched no plugin and "what did she say in the channel" matched no plugin. A run whose visible tool list holds no connector tools reads that as the capability being absent — the recorded failure this catalog wording exists to prevent — so each descriptor lists the words a request would actually use, and the host adds the provider type and prefix so no descriptor has to repeat its own name. A descriptor's `description` ends with the sentence naming when to load it, for the same reason.

**A refusal names what the connection *can* do.** `connectorCapabilityRefused` is the single shape for "this credential does not carry that tool" — every connector including Google — and it returns as `available` the capabilities of this plugin's **tools** intersected with the grant, alongside a `capability_not_granted` reason. Tool capabilities, not raw grants: a connection carries control-plane capabilities that back no tool at all (`slack.agent`, `slack.notifications.write`), and answering "what can I do instead?" with something the model cannot call is worse than the bare refusal. The bare form named only the missing capability, which is the one fact the model already had; it could not tell whether to retry, rephrase, or stop. This discloses nothing a run could not already see in its own tool list, and it is the pattern to copy for any other deterministic refusal — per [`agent-tools.md`](agent-tools.md#5-errors-are-opaque-only-across-a-trust-boundary-actionable-everywhere-else), the remedy has to be in `output`, because `summary` never reaches the model.

### Agent activation acknowledgement

Messaging-agent and native-agent adapters share `ConnectorAgentAdapter`. An adapter may implement `activationAcknowledgement(invocation)` to produce a fixed provider command; `acknowledgeConnectorAgentActivation` executes that command through the adapter after durable admission and authorization, but before context gathering, model calls, or tools. This is host control-plane behavior and is never left to model output. A retry must converge on the same provider state.

The hook is deliberately optional. Slack uses an `eyes` reaction on the exact triggering message and treats Slack's `already_reacted` result as success. Its operational host logs provider-side reaction failures and continues the admitted request so a supplemental acknowledgement cannot discard user work. Linear uses a `👀` reaction only when the current activation includes a source comment. A future message-oriented Teams, Discord, or GitHub agent can opt in when it has an unambiguous source object and a lightweight reaction API. Email, file, calendar, database, and ordinary resource-webhook connectors should not acknowledge activation: they have no conversational source message, and manufacturing a reply or mutation would be noisy or misleading.

### External result delivery

An external conversation, issue, or comment thread is a projection of Rally's
durable transcript, never a live model-output surface. A connector may show a
fixed acknowledgement, status label, or reaction while work is running, but it
must not start a provider response stream, append model deltas, or construct
reply prose from an in-memory accumulator. Slack, a future Microsoft Teams
agent, and a future Linear comment-back path all follow the same rule.

The terminal delivery boundary receives the final transcript turn identity and
reloads that exact canonical turn from the owning work-stream object. A
`needs_input` outcome instead prefers the oldest open elicitation's canonical
turn, because its prompt is saved in structured turn content rather than the
text column. Only text rendered from one of those hydrated turns may become an
external message or comment. If no saved turn can be read, the adapter may
clear status and apply an outcome reaction, but it sends no result body. A
named-but-missing turn is retained as a settlement diagnostic rather than
retrying provider status forever; transcript persistence is awaited before
terminalization, so a null exact read is not a late-write race. Provider
idempotency keys remain required because the saved projection can be retried
after an ambiguous network response.

Automation destinations obey the same content rule. An absent or whitespace-only
saved result performs no external write, but each frozen target still receives
a durable `skipped` / `delivery_suppressed` receipt so suppression cannot be
confused with a settlement path that never ran.

This boundary is intentionally above individual adapters. Adding another
message-oriented connector means branching after the exact saved-turn read,
not adding a second path from streaming checkpoints or terminal error objects.

### Google

Google identity and connector authorization are separate. Connector authorization uses the web-server code flow, PKCE, offline access, and incremental scopes. Settings presents two product-facing presets, but both create ordinary `google` connections backed by the same adapter, credential lifecycle, OAuth callback, and tool registry. They are authorization bundles, not separate backend connector types, and a user may connect either or both.

| Settings preset | Requested Rally capabilities |
| --- | --- |
| **Google Mail + Calendar** | `gmail.read`, `gmail.draft`, `gmail.send`, `calendar.read`, `calendar.write` |
| **Google Drive + Docs + Sheets** | `drive.read`, `docs.read`, `docs.write`, `sheets.read`, `sheets.write` |

The capability check is enforced for every tool invocation. The current Google tools are:

Every Google tool parses its arguments with a strict schema, so an undeclared key is an error naming the key rather than a silently dropped intent, and every list-shaped result returns `items` with an optional `nextPageToken` so one tool's shape generalizes to the rest. Header hydration degrades per hit: a message that cannot be fetched — deleted or refused — keeps its identifiers and reports `headersUnavailable`, so one rate-limited hit in a fan-out of up to fifty costs that row rather than the whole search. A revoked grant is the exception and is raised, because reporting it per row would read as an empty mailbox rather than a connection to reconnect. Address headers are truncated at the end of the last address that fits, never mid-address, because a fragment cut inside a domain still parses as an address and would be reported as a real correspondent.

- Gmail: `google_gmail_read_profile`, `google_gmail_search`, `google_gmail_find_contacts`, `google_gmail_read_thread`, `google_gmail_read_message`, `google_gmail_create_draft`, and `google_gmail_send`. `google_gmail_read_profile` answers which account is connected — the address it sends from, which is also what `me` matches in a search operator, with its message and thread totals. It exists so the account holder's own address is read rather than inferred from a signature or a From header, which are somebody's claim about the account rather than the account. It needs no scope beyond the existing Gmail read grant. Search returns each hit's sender, recipients, subject, date, labels, snippet, and RFC `Message-ID` by hydrating the metadata headers behind the bare identifiers Gmail's list endpoint returns, so a result is answerable without a read per hit. Drafts and sends take an explicit new/reply message, described below. `google_gmail_find_contacts` resolves a person's name to ranked candidate addresses by scanning the address headers of prior correspondence, excluding Spam and Trash so a spoofed message cannot become a sourced address, each returned with the message it was drawn from; it needs no People API scope, excludes the authorized mailbox's own address, and returns an empty list rather than a guess when nothing matches — carrying a `reason` of `no_messages_matched` or `no_address_matched_name` and a `hint` in its output, since a tool result's `summary` never reaches the model. Gmail message and thread identifiers are both bare hex and cannot be told apart at the schema boundary, so `google_gmail_read_message` and `google_gmail_read_thread` translate the provider's 404 into a `wrong_id_family` failure that names which of a search hit's two identifiers belongs where. `google_gmail_create_draft` returns a `webUrl` alongside its id. A draft or message body is delivered as `text/plain` exactly as written — `serializeEmail` builds no alternative part — so the descriptor's system message, the capability-gated Google presentation, and the `body` parameter's own description all say to write plain text rather than Markdown, which would otherwise reach the recipient as `#` and `**`.
  Both Gmail writes accept one `message` object, with two complete shapes:

  | Intent | Arguments |
  | --- | --- |
  | New conversation | `{ "message": { "kind": "new", "to": ["dana@example.com"], "subject": "Renewal", "body": "Hello Dana." } }` |
  | Reply to a message | `{ "message": { "kind": "reply", "messageId": "id-from-a-search-hit", "to": ["dana@example.com"], "body": "Thank you." } }` |

  Gmail drafts additionally accept `attachmentResourceIds` beside `message`,
  containing PDF resource IDs from the conversation's resource tools. The host
  resolves current conversation visibility under the execution principal, reads
  the original stored file, verifies its hash and PDF type, and sends its bytes
  as a base64 MIME attachment. No file bytes or storage keys enter model input
  or output. A missing, inaccessible, or non-PDF resource stops before creating
  the draft; repeated IDs attach once. `gmail.send` does not accept this field.

  `cc` is optional in either shape; omitted, `null`, and `[]` all mean none.
  Recipients remain explicit, including for replies: the adapter does not infer
  reply-all recipients or copy the original's recipient list. A new message has
  no message id or threading fields. A reply accepts a Gmail **message id** from
  the same connection's search/read result, and has no caller-supplied subject,
  `threadId`, `inReplyTo`, or `references`.

  Before either reply write, the adapter checks `gmail.read` and reads that
  message's metadata from the same account. Its subject, thread id, and validated
  RFC Message-ID determine the outgoing MIME and Gmail request together. Valid
  ancestor Message-IDs from References are preserved and deduplicated in linear
  time, with the parent Message-ID once at the end; malformed or oversized
  ancestor tokens are ignored. Both `References` and `In-Reply-To` are folded
  between complete IDs, targeting 78 bytes per physical line. An indivisible ID
  may exceed that target, but must fit within the 998-byte line maximum including
  a continuation's leading space: at most 997 UTF-8 bytes per ID. These are the
  [email format's line limits](https://www.rfc-editor.org/rfc/rfc6532.html#section-3.4),
  with the folding target conservatively measured in bytes. Valid ancestry is
  retained without a count cap; the existing metadata response bound still
  bounds the input. A
  missing or invalid parent Message-ID, missing thread id, or unreadable message
  stops before the write. It never falls back to sending a new conversation.
  New messages need only the existing send/draft capability and perform no read.
  Resolving a reply adds one metadata request and depends on that message still
  being readable at execution time.

  Short ASCII subjects stay plain. Longer or non-ASCII subjects use UTF-8
  encoded-words split at complete Unicode characters, including when a reply's
  inherited subject exceeds the new-message input limit. Each encoded-word is
  at most 75 characters and each physical line containing them at most 76,
  including the `Subject:` prefix or continuation space, per
  [RFC 2047 §2](https://www.rfc-editor.org/rfc/rfc2047.html#section-2).
  Folding whitespace between encoded-words does not change the decoded subject;
  original spaces stay inside the encoded text. Input CR/LF is neutralized
  before serialization.

  `EmailArgsSchema` supplies both runtime validation and the advertised schema
  through `z.toJSONSchema(..., { io: "input" })`. Its new/reply union is nested
  under `message` so the root remains an object across providers. Unknown fields
  are rejected in both branches by execution, including old flat arguments.
  Bind's `toolWireDefinition` sanitizes even `rawJsonSchema` before Rally's root
  repair. Its xAI compatibility pass removes `additionalProperties: false`.
  Gmail therefore also expresses each closed object as a complete required-key
  set with `maxProperties` equal to that set's size. Optional `cc` has absent
  and present variants inside `message`. A draft's optional root
  `attachmentResourceIds` uses `propertyNames` to allow only that key and
  `message`: root unions are repaired away by the harness for provider
  compatibility, so a union there would silently admit undeclared fields. These constraints survive Bind without changing its
  treatment of other tools or relaxing execution. Ignoring
  undeclared write options could change intent, such as turning an invented
  `preview: true` into an actual send. The regression test captures the real
  harness HTTP request and uses Ajv to check declared-field constraints and
  unknown-key rejection against execution; Zod's JSON Schema importer does not
  enforce `maxProperties` and cannot prove this boundary. The selected
  plugin's worked examples show both kinds for each granted write capability,
  with replies shown only when read access is granted. Callers using older flat arguments need the refreshed tool definition
  before retrying.

- Calendar: `google_calendar_list_calendars`, `google_calendar_query_availability`, `google_calendar_list_events`, `google_calendar_read_event`, `google_calendar_create_event`, and `google_calendar_update_event`. Event tools accept a calendar ID, `primary`, or a calendar's **name**, which is resolved against the account's calendar list — a name matching two calendars is an `ambiguous_calendar_name` failure listing both rather than a guess — and otherwise use the configured calendar, which defaults to primary. An event ID that looks like a calendar address is rejected as `wrong_id_family` at the boundary. Scheduled activity polling still follows the configured calendar.

  `google_calendar_query_availability` checks known calendar IDs or verified email addresses through Google's free/busy endpoint using the existing `calendar.read` capability and `calendar.readonly` scope; calendar-list membership is not an access boundary. Errors and missing or malformed results mean `unknown`, never free, with a fixed explanation and next step alongside the diagnostic code. The tool does not resolve groups or display names, and reads no event details.

  A relative change carries each existing guest across whole rather than rebuilding them from an address, so `responseStatus`, `optional`, `displayName`, and a room's `resource` flag survive an addition; re-sending bare addresses would reset every RSVP and re-invite everyone. The read is uncapped and an `attendeesOmitted` response is refused rather than patched from, because `maxAttendees` returns only the participant past its cap rather than a prefix — a capped read is how a large event loses its guest list. Resolving a calendar by name needs the connection's calendar read capability, and says so rather than failing as an opaque provider error.

  Attendee changes are stated relatively. Google's event PATCH replaces the whole `attendees` array, so `google_calendar_update_event` takes `addAttendeeEmails` and `removeAttendeeEmails`, which it applies to the event's current guest list after reading it, and `replaceAllAttendeeEmails` for the rare case of setting the list outright. Empty attendee arrays are treated as omitted, so an empty replacement never clears the list; to remove everyone, name them in `removeAttendeeEmails`, or use Google Calendar if the guest list is incomplete. The create-shaped `attendeeEmails` is deliberately absent from the update schema: reaching for it fails the strict parse instead of silently deleting everyone who was already invited. Any attendee change emails everyone remaining on the event, and creating an event with attendees sends real invitations — both tools say so in their descriptions.
- Drive: `google_drive_search`, `google_drive_get_metadata`, `google_drive_download`, and `google_drive_export`. Search matches a plain-text `query` against file **names and indexed contents** — it is not a Drive query expression, so an operator written into it is matched literally — and narrows through its own `fileType` (named as a person would: `document`, `spreadsheet`, `pdf`, …), `modifiedAfter`, and `orderBy` parameters rather than through query syntax. A name-only search made a request for what a document *says* come back empty, which the plugin message then licensed reporting as the content not existing.
- Docs: `google_docs_read_document`, `google_docs_create_document`, `google_docs_append_text`, and `google_docs_replace_text`.
- Sheets: `google_sheets_read_spreadsheet`, `google_sheets_read_values`, `google_sheets_create_spreadsheet`, `google_sheets_update_values`, and `google_sheets_append_values`.

Every tool that returns something a person can open returns it as **`webUrl`** — Gmail threads and drafts, calendar events, Drive files, and created Docs and Sheets alike — rather than the four provider-shaped names those surfaces use natively. A Workspace file id is the same shape whatever it addresses, so any Docs or Sheets call the provider refuses — reads and writes alike, not only the two document readers — is re-checked against Drive's MIME type and, where they disagree, fails as `wrong_id_family` naming the canonical tool that does accept it; the check needs the connection's Drive read capability and is skipped without it, and never replaces the original failure with one of its own. `google_sheets_read_values` returns what the sheet displays by default and accepts `valueRenderOption: "UNFORMATTED_VALUE"` for numbers and serial dates that can be computed with.

`google_drive_download` also reads Word, Excel, PowerPoint and PDF files stored in Drive, through the registry's document reader (see [Reading provider files](#reading-provider-files)). `fileType` accepts `word`, `excel`, and `powerpoint`, and a Docs or Sheets tool handed one of those ids fails as `wrong_id_family` naming `drive.download`.

Docs and Sheets operations use their native provider APIs. Docs reads return bounded document structure and text; writes create a document, append plain text, or replace exact text. Sheets reads return bounded spreadsheet metadata or formatted values from an explicit A1 range; writes create a spreadsheet or update/append bounded row values. Drive download/export remains available for file-oriented retrieval, but it does not replace the native Docs and Sheets operations.

The production-approved Google scope set uses `drive.readonly` for Drive discovery and native Docs/Sheets reads, and `drive.file` for native writes. Newly created Docs and Sheets can be edited. An existing file is writable only after it has been explicitly opened with Rally under Google's per-file authorization model; an arbitrary existing file discovered through Drive search remains read-only. Drive search and metadata results expose `isAppAuthorized`, `canEdit`, and the derived `writableByRally`; Docs/Sheets update tools preflight the same metadata and fail without attempting a mutation when the user cannot edit the file. When the user can edit but `isAppAuthorized` is false, the failure also carries the generic `connector_resource_authorization` recovery descriptor. The desktop opens the provider's resource-grant flow, and a successful callback appends an ordinary user-authored `Document “<name>” was authorized.` message. That visible message, not hidden tool replay, starts the continuation run. The generic host contract contains connection, capability, operation, resource, and conversation identity; the connector adapter alone owns provider URL construction and post-callback verification. Google is the first adapter and uses its one-file Picker flow. The preflight is a fail-closed model-guidance and user-experience guard, not the security boundary: Google enforces the current authorization again when it receives the mutation.

Google activity ingestion is polling-only. Gmail, Calendar, and Drive are independent named activity streams under one connection. Each commits its own provider-native high-watermark—Gmail history IDs, Calendar sync/completion tokens, or Drive change page tokens—only after its canonical activities are persisted. A transient failure in one stream preserves that stream's checkpoint without forcing successful sibling streams to replay; the scheduler uses the earliest backlog or retry deadline. Gmail and Calendar are digestible streams and Drive is not: a change feed reports a save, so a document written over an afternoon is one piece of news and dozens of events. `email.received`, `calendar.event_changed`, and `calendar.event_completed` are the digestible activity types; `email.updated` is a label or read-state change on mail already seen. Drive change polling classifies Google Workspace MIME types into `docs.document_changed` and `sheets.spreadsheet_changed`; other files produce `drive.file_changed`. Consequently `drive.read` is included in the Drive + Docs + Sheets preset and is the event source for Docs and Sheets changes. Operators can follow each normalized poll result into WorkspaceDO at `connector_event_authority_ingested`, before its Queue processing begins. Rally does not currently register Gmail Pub/Sub watches, Calendar notification channels, Drive push notifications, or any other Google webhook. Rally resource watches route the normalized polled activity and must not be confused with provider push delivery. Calendar change polling expands recurring events into instances, so one edit to a series returns every instance Google holds for it. An instance is therefore reported against its series rather than on its own: one `calendar.event_changed` activity per edit, carrying `seriesChange: true`, built from the series master — read once per changed series per poll with `events.get` — and keyed on the master's id together with the master's own `updated`. Because the content is the master's, the activity carries the series' real start and end, its link, its location, its `recurrence` rule (in `metadata`), and each guest's series-level RSVP. An instance whose `updated` is after the master's was edited on its own and is reported as that occurrence, with that occurrence's times, keyed on its own etag; an instance whose `updated` is at or before the master's belongs to the edit the master records, or to an older one it has since superseded, and either way is reported against the master as it now stands. A burst is larger than the 150 items one poll fetches, so the same identity is re-emitted on later polls and the workspace's dedupe absorbs the repeats. Two rules follow from that, and both are load-bearing. An instance is classified by comparing its own `updated` to the master's, never by how many of its siblings landed in the same chunk, or the same edit would be reported differently depending on where the page boundary fell. And the activity's content must be identical in every chunk, because a repeated identity whose payload hash differs is refused at ingest — which is exactly what building it from the master, and nothing from the instances, guarantees: the master for a given `updated` is one fixed record. When the master cannot be read (a purged series, or a body that is not the master asked for) the series is reported from a representative instance keyed on the instances' `updated`, and then carries only what every instance agrees on: no start or end, no link, no overriding location, and each guest without the per-occurrence `responseStatus`. Each Google activity type declares the attached resource its events are *about* — `sheets.spreadsheet_changed` a `google_sheet`, `docs.document_changed` a `google_doc`, `drive.file_changed` a `drive_file`, and both mail events a `gmail_thread` — because the registration reconciler builds an evaluator set from those relationships and a type that declares none routes nothing, however many watches exist. The relationship names the watched entity itself rather than a container it sits in, which is why `file` and `thread` exist beside Notion's `page` in `ConnectorResourceRelationshipSchema`.

A revoked refresh grant marks the connection `needs_reconnect`. Production smoke tests should create a Gmail draft rather than send unsolicited mail. A personal Gmail send tool is available only to its owner; if an administrator creates a workspace-scoped Gmail connection through the backend, its granted send capability rolls down to every work stream like every other workspace capability.

The two records are isolated by Rally capability checks, not by separate Google OAuth principals. Because both presets use one OAuth client with incremental authorization, Google may return a token containing scopes previously granted to that account; Rally still exposes only the capabilities recorded on the particular connection. Disconnect is local when another Google connection for that account remains. Operators must not describe the presets as provider-level credential isolation.

Calendar change and completion polls carry sanitized `metadata.attachments`
entries (`fileId`, `fileUrl`, `title`, and `mimeType`), using the same reader as
event tools. An attachment-only edit therefore changes the activity content.
Recurring-series activities use the master's attachments; when the master is
unavailable, a representative instance's attachments are omitted to keep the
series identity stable across pages and avoid attributing one occurrence's
transcript to the whole series.

The `reading-google-meeting-notes` skill carries the reusable lookup procedure
and a sourced storage/access reference. It is offered only with an eligible
Google read connection, once even when Calendar and Drive are separate presets.
It distinguishes Meet transcripts, Gemini notes, and manual Docs that may never
be attached to Calendar. Folder names are hints rather than search requirements.

The skill owns the attached-Doc-first procedure and Drive fallback. Connector
presentations point to it rather than duplicating the lookup instructions.
A Gmail-only connection does not offer it. Calendar attachment visibility does
not establish permission to read the referenced Doc.

### GitHub App

The agent can list and search repositories, list directories or bounded recursive
trees, list commits, read files, inspect and create/update issues and comments,
inspect and create/review pull requests, and read Actions and check runs.
Repository listing stays inside the App installation instead of using GitHub's
global search surface. It scans at most 1,000 authorized repositories, merges
the installation owner's six profile pins when GraphQL makes them available,
sorts pins first and then by the newer of `pushed_at` and `updated_at`, and
returns `totalCount`, `page`, `perPage`, `hasMore`, and an honest `truncated` /
`totalCountIsExact` signal. Search matches `name` and `full_name` locally over
that same authorized set. `hasMore` means another page can be returned from the
bounded local result; `truncated` separately says that GitHub has additional
entries outside that bound. A recursive tree with a path resolves that subtree
segment by segment before requesting recursion, so narrowing the path also
narrows the provider response rather than merely filtering a full-repository
download. The Contents API has no truncation flag, so a directory response at
GitHub's 1,000-entry ceiling is conservatively marked truncated and inexact and
the model can switch to tree mode. Directory/tree `offset` and `limit`, like
every numeric tool field, inherit the exact numeric-string normalization in
[`agent-tools.md`](agent-tools.md).

Every GitHub list tool answers in that same envelope: the named collection
(`pullRequests`, `issues`, `commits`, `files`, `reviews`, `workflowRuns`,
`checkRuns`), `count`, `page`, `perPage`, `hasMore`, and — where the tool takes
filters — an `appliedFilters` echo of exactly what narrowed the query. The echo
is the load-bearing part. GitHub's `head` filter wants `owner:branch` and
answers anything else with HTTP 200 and an empty array, so a bare `[]` cannot be
told apart from a repository with nothing in it, and a run that hit that
reported twenty-five open pull requests as none. `hasMore` is a full page, read
conservatively: a page that comes back exactly full may or may not be the last
one, and saying `true` costs one empty page where saying `false` loses whatever
followed it. Do not try to sharpen it by asking GitHub for one item past the
page — `page` is indexed in units of the `per_page` actually sent, so requesting
31 to show 30 makes page 2 begin at item 32 and drops item 31 on every boundary.
The `Link` header answers it exactly without moving the boundaries, at the cost
of threading response headers through every request in this adapter, and is the
move if something ever needs `hasMore` exact. The two endpoints that answer with
GitHub's own `total_count` — `actions.list_workflow_runs` and
`checks.list_for_ref` — are the exception, and take `hasMore` from that total
exactly; when the total is missing they fall back to the same conservative
reading rather than standing the page's own length in for it, which would report
`hasMore: false` for an exactly-full first page, and they omit `totalCount`
rather than inventing one a caller cannot tell from a real total.
`issues.list` pages on what GitHub served rather than what survives its
pull-request filter, or a repository whose issue numbers are mostly pull
requests ends its list early. Parameter descriptions are principle 13 in
[`agent-tools.md`](agent-tools.md), and
`apps/api/test/tool-schema-descriptions.test.ts` holds them.

**Inside that envelope, every row is declared rather than passed through.** Each
list names the fields it carries in a `FieldProjection` beside the tool, applied
by `projectFields` before the adapter's character, array and depth clamps see
it. GitHub's objects are not rows: a pull request embeds `head.repo` and
`base.repo`, two complete repository records with about thirty URL templates
each, and a workflow run embeds `repository` and `head_repository` the same way,
which measured 24.5 KB and 21.3 KB per row against roughly 400 bytes of answer.
Note that no count-based bound was near its limit while that was true — a row is
wide, not long — which is why the fix is a declaration rather than a smaller
page. Rows keep GitHub's own field spelling (`html_url`, `head.ref`) while the
envelope around them keeps this adapter's; each tool description says what its
row holds and names the `get` that returns the rest, because a model reads an
absent field as an empty one. The contract and the four rules that decide what a
row may drop are principle 8 in [`agent-tools.md`](agent-tools.md).

The single reads are declared the same way, as the matching list row plus what
the read was for: `issues.get` adds the body and the milestone title,
`pull_requests.get` adds those plus `merged`, `mergeable`, `mergeable_state`,
`merge_commit_sha`, `merged_by.login`, `head.repo.full_name` and the counts that
describe the change — comments, review comments, commits, additions, deletions
and changed files — `actions.get_workflow_run` adds the workflow file path, the head commit
and the two actors that differ on a re-run, and `repository.get` adds
visibility, topics, licence, homepage and the counts. Composing them from the
list rows rather than declaring them separately is deliberate: a field that
earns a place on the list row cannot silently lose it on the read. The write
tools that echo what they wrote — `issues.create`, `issues.update`,
`pull_requests.create`, `issue_comments.create`, `pull_requests.create_review` —
return the same records, so the shape of a created issue matches the shape of
that issue read back one call later.

Three rows carry a field that looks like an obvious cut and is not.
`pull_requests.list_files` keeps `patch`, which is the answer the caller came
for, under its own 12,000-character budget. `checks.list_for_ref` keeps
`output.text`, the widest field on any row here, because this plugin has no
check-run get, no annotations tool and no job-log tool, and `details_url` is the
reporting app's own page rather than anything this connector can fetch — without
it a run can say a check failed and not say why. `repositories.list` keeps
`name` and `owner.login` beside `full_name`, because those are the two
parameters every other tool in the plugin takes. Every string is bounded with a
visible marker, so a cut is legible to the model instead of arriving later as a
wrong answer.

The GitHub plugin prompt treats metadata and code evidence as different things.
When a repository is not named, the model searches the authorized set and
chooses the best match from the request, work-stream context, pinned status,
and recent activity rather than handing repository selection back to the
participant or taking an arbitrary first result. It may say that verification was
incomplete without a readable code file, but it may not conclude that there are
no discrepancies until `contents.get` has successfully returned at least one
code file in that run. Repository, tree, commit, issue, and pull-request reads do
not satisfy that evidence condition.

An active GitHub connection advertises a connector-specific **GitHub** child
page immediately below Connections in Settings. A personal connection is
configurable by its owner; a workspace connection is configurable by an admin.
The versioned policy either permits every App-installation repository with a
default access level or only named immutable repository IDs, with per-repository
overrides. Repository list/search results return the effective `access` so the
model can plan before acting. `read_only` is a remote boundary: it still permits
Terminal file changes and local commits, while its repository token cannot push
or mutate GitHub. `full_access` supplies the Terminal sandbox a short-lived,
single-repository App token for ordinary `git` and `gh` writes. Rally prepares
a stable word-based work-stream branch first and the plugin prompt directs the
model to push only that branch. Full access does not broaden the GitHub App's
installed permission ceiling, but GitHub does not technically scope that token
to the prepared branch.

A connection with no stored repository policy deliberately begins as **all
repositories / full access**. This is the requested rollout compatibility mode,
and means enabling this Terminal release immediately makes native remote
`git`/`gh` writes available across that connection's existing App installation;
an administrator can change the default or select individual repositories on
the GitHub Settings child page. A present but malformed policy does not receive
that compatibility default and fails closed.

**A GitHub delivery is answered before it is routed.** The Global receiver
(`GitHubRoutingService.ingestGitHub`) verifies the signature once, over the
exact request bytes, drops `ping` and what `isDiscardedGitHubDelivery`
discards, enqueues a `github_webhook_delivery_v1` message on the Global
`ACTIVITY_QUEUE`, and answers `202` — with no D1 read, R2 write or GitHub call
for a body that fits in a message. The body rides inline when it fits under
`MAX_CONNECTOR_EVENT_QUEUE_BYTES` (the Queue's 128 KB limit less the envelope)
and is staged in `PAYLOADS` under
`<region>/github-ingress/<delivery id>/<body hash>.json` otherwise, because
GitHub sends payloads of up to 25 MB; a staged body whose message could not be
sent is deleted again before the receiver fails. The consumer
(`GitHubRoutingService.consumeDelivery`) looks up the installation's regions in
`github_installation_routes`, hands each region the verified bytes —
`ProviderWebhookService.ingestVerifiedGitHub` in-process, or the bridge's
`ingestVerifiedGitHub` — disables the routes after `installation.deleted`,
and deletes a staged body. Connection matching, the personal-connection GitHub
calls, and every regional write happen there. Nothing after the receiver
verifies the signature again (see [Invariants](#invariants)). The delivery id
is the idempotency key: a region's processed `provider_webhook_receipts` row
answers a redelivery, from the Queue or from GitHub, as a duplicate, and a
pending one — an earlier attempt threw after the receipt committed — re-runs
the delivery's effects, each keyed to it: resource upserts, connector events
whose ids derive from the delivery and connection, and lifecycle updates
ordered by `connector_ingress_routes.lifecycle_at` so a retried older
`installation` event cannot overwrite a newer one. A throw retries the message
with the activity consumer's backoff, or a GitHub rate limit's Retry-After when
longer, and `max_retries` sends it to the dead-letter queue; an installation no
region has connected — every `installation.created` that beats the setup
redirect — is acknowledged and logged as `unrouted`, not retried. The
non-shared host's `/ingest/github` still ingests synchronously through
`ProviderWebhookService.ingestGitHub`, which verifies once and shares the
same verified path. Webhooks also discover durable
repository, commit, file, issue, pull-request, release, workflow-run, and
check-run resources so people and agents can attach provider objects directly
to work streams without copying their content into Rally. Issue-dependency and
sub-issue deliveries add both sides of the relationship, including
cross-repository issues, while retaining one normalized activity per delivery.

### Linear

Linear is a composable connector with both `resource` and `native_agent` surfaces. One public OAuth app supports two identities through PKCE: personal connections use `actor=user` and remain private to their Rally owner; workspace connections use `actor=app` and roll their tools down to every member. The native surface is bound explicitly to the workspace-only, non-tool `linear.agent` capability. It grants `app:assignable` and `app:mentionable` for activation plus `write` for the deterministic source-comment acknowledgement; resource tools independently grant `read`, `issues:create`, `comments:create`, and `write`. The resource agent can search/read issues and projects, list teams and workflow states, create/update issues, and create comments.

`search_issues` matches a term against issue titles **and descriptions**, so an issue is findable by what it is about rather than only by what it was called. `list_workflow_states` exists because `stateId` had no discovery path: the only way to learn a valid state was to read an unrelated issue in the same team and copy the id out of it, which is a lookup dance a model does not invent and frequently gets wrong. Every argument schema on this connector is strict, and `create_issue` accepts every issue field `update_issue` accepts — the two go together, because a family whose members take different fields plus a non-strict parse is the silent-drop trap in [`agent-tools.md`](agent-tools.md#1-fail-loud-never-silently-ignore-an-input): a model that learned `dueDate` on update sent it to create, it vanished, and the tool reported success.

Linear's one public webhook is timestamp/signature verified at a dedicated smart ingress, routed by organization to the owning configured deployment connections, verified again, normalized, deduplicated by `Linear-Delivery`, and queued regionally. Workspace app connections receive matching resource events directly. A personal connection receives a delivery only after its own token proves access to the signed resource or a signed parent in one bounded GraphQL probe; its normalized activity remains personal and targets only its Rally owner. Authorization loss marks that connection `needs_reconnect`, and lifecycle/native-agent events never fan out to personal connections. Agent-session events are represented explicitly rather than being flattened into ordinary resource updates.

The native-agent surface is a control-plane protocol, not a model-callable tool. `ConnectorAdapter.nativeAgent` supplies the typed invocation and outbound protocol facet; the manifest separately records `runtimeStatus`. Linear is currently `protocol_only`: the provider schemas and GraphQL operations exist, but the coordinating session-to-workstream runtime is deliberately not advertised as operational. Its descriptor records preview maturity, delegation/mention/follow-up invocation, authored activity kinds, cancellation, links, plans, proactive sessions, Linear's five-second webhook response deadline, and the ten-second first-activity deadline.

Native sessions are additionally matched by organization, granted `linear.agent` capability, and the signed event's `appUserId`; a resource-only connection never receives a delegation. Desktop authorization requests `linear.agent` only when `VITE_LINEAR_NATIVE_AGENT_ENABLED=true`, and the API independently requires both `LINEAR_NATIVE_AGENT_ENABLED=true` and an `operational` connector runtime. Keep the flags off and the runtime `protocol_only` until the fast durable inbox, unique native-session ownership, session/run mapping, cancellation coordinator, durable activity outbox, and timing acceptance suite are complete.

### Notion

Notion has two intentionally different Rally connection modes. A personal
connection authorizes the official hosted Notion MCP server with OAuth discovery,
dynamic client registration, and PKCE. It is owned by one Rally member, acts
with that member's Notion authorization, and exposes whatever tools Notion
returns from live `tools/list` when the plugin activates.

A workspace connection remains the public integration path. A Rally owner or administrator starts the public OAuth flow and chooses the pages to share in Notion's page picker. Notion still requires `owner=user` on that public OAuth request: that identifies the human approving the installation, not Rally's execution principal. Rally stores the returned authorization as a workspace connection with no Rally user owner, and stores the authorizing Notion user only inside the encrypted credential metadata. The installed integration bot is the provider identity used for API calls, so edits and comments are attributed to Rally in Notion rather than to the person who approved the connection.

Every member's ad-hoc work stream can use the granted Notion tools through the workspace principal; workspace automations still require an explicit binding. The agent can search and retrieve pages/data sources, query data sources, create pages, update or append Markdown, and read/create comments. Only pages explicitly shared during installation are visible. Notion webhook activity is normalized at workspace scope with no target user, because the event belongs to the shared bot grant rather than to its authorizer.

Migration `0072_notion_connection_scope_split.sql` converts legacy personal
Notion rows from the former public-integration shape into workspace connections
and clears their Rally user owner. It identifies that credential dialect by
the absence of `notion.personal.mcp`; new hosted-MCP rows retain personal scope.
Historical workspace-bot routes were already registered when those grants were
created, so the migration changes authorization semantics without rebuilding
provider credentials or sending content across regions.

Notion's search matches **titles only** — a provider limitation, not a gap Rally can close from this side. That makes an empty result the most misleading thing this connector can return, so the plugin message states the limit and names the two ways past it: query the data source that would hold the record, or retrieve a page found by title and read its content. Compare Drive and Linear, where searching contents was possible and is now the default.

Notion's one-time webhook verification token is accepted through a guarded
setup URL, encrypted in the owning WorkspaceDO connection row, and then used to
verify every later webhook signature before normalization and queueing. Unlike
every other connector here, Notion's OAuth callback and webhook are not
regional: one public connection issues one redirect URI and one webhook URL for
configured deployments, so both arrive at a Global ingress that routes them to the owning
region — see [`notion-ingress.md`](notion-ingress.md).

### Ashby

Ashby has independent personal and workspace modes. **Connect for me** uses
Ashby's hosted MCP service, with the personal `ashby.personal.mcp` grant and
owner authorization. It has a prerequisite Rally cannot check and the OAuth
redirect cannot explain: **the Ashby organization must have opted into Ashby
MCP, and the account signing in must be eligible for it.** Without that, the
authorization fails provider-side with nothing naming the cause. The personal
**Connect for me** tooltip says so, and
<https://rallywith.ai/help/connecting-your-tools/ashby/> is the setup walkthrough.

Tool names and schemas come from live discovery; all retain conservative write
execution and receipts without individual tool confirmations.
**Connect for workspace** requires a Rally administrator and an Ashby API key
with webhook management access. Its model-visible workspace catalogue explicitly describes an event-only
connection and directs recruiting queries or updates to a personal connection;
it exposes no recruiting read or write tools. New setup subscribes automatically
to all 27 documented business event types in `packages/contracts/src/ashby-events.ts`
(application, candidate, interview, job, posting, offer, opening, HRIS, survey,
signature, take-home and email-change notifications). These are operational, not
digest news. `ping` is transport-only. Existing explicit subsets remain bounded.
Normalization retains regional payload references and extracts only documented
application/candidate/job identity fields. The email beta renews its watermark on
retry: only that signal excludes delivery-specific raw hash/reference from the
canonical comparison, retaining candidate identity and every raw R2 delivery.
No email fetching is added. Administrator-authorized workspace events use the
existing workspace audience and deterministic automation matching. Personal MCP
permissions remain separate. Live provider behavior is unverified without an
Ashby test organization; that does not disable workspace automation.

The dedicated `ashby.rallywith.ai` Worker forwards unchanged signed bytes to the
owning regional API. Credentials, signature verification, payload persistence,
and canonical event admission remain regional. [Provider app registrations](provider-apps.md)
owns the OAuth/API prerequisites; [installation lifecycle](connector-installation-lifecycle.md)
owns registration state and recovery.

### Workspace installation management

`ConnectorAdapter.installationManagement` declares the provider's reviewed event
set, grouping, configuration version, supported operations and manual recovery.
Ashby and Granola use the shared lifecycle service for setup, repair and removal.
It reserves workspace identity before creating provider registrations, records
uncertain outcomes, and separates ordinary authorization from exact-ID cleanup
credentials. Health checks and inventory reads never repair an installation.
Explicit **Test** adopts legacy Granola state, then requests lifecycle repair and
checks health. Granola has no second adapter repair/revoke mutation path.

The request/response contracts are shared with the desktop in
`@rally/contracts`. Installation changes invalidate both the connection list and
open installation details through the workspace connection notification. A
personal OAuth failure cannot disable a separately authorized workspace install.

### Fireflies

Fireflies has two independent connection modes, like Granola's. A **personal**
connection uses Fireflies' hosted MCP server at `https://api.fireflies.ai/mcp`
over browser OAuth with PKCE and dynamic client registration, origin-pinned to
that host. It exposes the server's live tool surface — including Fireflies' own
sharing, retitling, moving and soundbite actions — under the pass-through's
confirmed-write treatment, and is available only to its Rally owner. Fireflies'
authorization server publishes exactly the `profile` and `email` scopes, so
Rally asks for no `offline_access`; if no refresh token comes back, the
connection reports itself as needing reconnection when its access expires
rather than pretending it can renew itself.

A **workspace** connection is no longer offered: Fireflies declares
`connectableScopes: ["personal"]`, the desktop catalog offers only **Connect for
me**, the setup route is gone, and `createWorkspaceInstallation` refuses the
scope with `connector_scope_not_connectable`. What is described in the rest of
this section is what a connection made before that still does — the adapter
keeps serving it, because a workspace that pasted a key keeps its meetings
rather than losing them to a product decision. Such a connection uses one
administrator-pasted Fireflies API key,
validated against the provider's `user` query before anything is stored, and
exposes three fixed read tools over checked-in GraphQL documents: search
meetings, read a meeting's AI summary, read its transcript pages. The model
never writes GraphQL. Every provider-controlled string and array in those
outputs is capped and the cut reported through a `truncated` flag, and a
transcript document over the 2 MB response cap fails as `payload_too_large`
pointing at the summary instead. Fireflies reports application errors in a GraphQL
`errors` array, and **not always with a 200** — a rejected API key comes back
as HTTP 500 carrying that array, checked before the query is parsed (observed
live 2026-09-13; the documentation describes the body and is silent on the
status). The adapter therefore reads the body first and maps `errors[].code`,
falling back to the status only for a response that carries no code at all.
Going through the shared `providerJson` helper, which throws on a non-2xx
before the body is read, made a revoked key look like a transient outage and
left the connection reporting healthy. So: `auth_failed` becomes the `unauthorized` that marks the connection
`needs_reconnect`, `too_many_requests` carries a wait derived from the
provider's own reset time, and the rest resolve to correct-and-retry,
not-found, forbidden, or retry-once-then-continue.

What the key can read is the connected Fireflies account's own access, and
every workspace member can read whatever the key can. That is why no new one is
made: team-wide visibility needs Fireflies Enterprise with Super Admin, and
Fireflies publishes no field that reports whether it is enabled, so Rally could
not state the blast radius even to the administrator pasting the key.

Activity is webhook-only at `POST /ingest/fireflies/:id`. A delivery carries an
event name, a millisecond timestamp and a meeting id and nothing else, so the
normalized activity names the meeting and `hydrateResource` reads it over
GraphQL after admission — keeping a provider round trip out of Fireflies'
ten-second acknowledgement window and off a delivery that turns out to be a
duplicate. `meeting.summarized` is digestible; `meeting.transcribed` is
operational, because they are the same meeting minutes apart. The two keep
distinct dedupe keys so the earlier one cannot swallow the later. Verification
is HMAC-SHA256 over the exact bytes against `X-Hub-Signature`, then a freshness
window on the in-body timestamp — the only replay anchor Fireflies signs — then
an ingress receipt keyed on the hash of those bytes, since Fireflies sends no
delivery id. A post failing any of it is rejected with no row written anywhere.
A verified delivery of `meeting.bot_joined`, or of anything else this connector
does not handle, is refused before the receipt. The one exception is the
dashboard's **Send test event**, an undocumented `event: "test"` delivery
observed live: signed and timestamped like a meeting but naming a placeholder,
it is answered `200 { ping: true }` with no receipt, payload, or activity
written, and it counts as the registration's verifying delivery.

Registration is the customer's: Fireflies exposes no webhook API at all, so the
adapter declares create, update, remove and rotate manual and inspect and
reconcile unsupported, Rally generated the signing secret and showed it once at
setup, and the first verified delivery — the dashboard's test event, or the
first meeting — is what makes the installation current. Nothing now reaches
that setup, and an existing installation has no **Manage events** window
either; a workspace that wants rid of one deletes the connection.
[Installation lifecycle](connector-installation-lifecycle.md) owns that path.
Both scopes are gated region by region on the non-secret
`FIREFLIES_CONNECTOR_ENABLED` variable; unset, the type is absent from the
catalog and creation is refused, while existing rows are retained and inert.

### Granola

A Granola organization connection's row offers no **Manage events** window:
Granola registers, inspects, updates and removes its own webhooks, so the
installation settles without anybody watching it.
[Installation lifecycle](connector-installation-lifecycle.md#who-gets-a-window)
owns which providers get one and what a provider loses with it.

Granola has two intentionally separate connection modes. A personal connection uses Granola's hosted Streamable HTTP MCP server and browser OAuth with PKCE and dynamic client registration. It follows the member's currently active Granola workspace and exposes the server's live tool surface rather than a code-authored snapshot. A personal connection remains available only to its Rally owner.

A workspace connection uses one administrator-created Granola Workspace API key. It exposes bounded read operations for listing notes, reading a note with an optional transcript, and listing folders. Rally creates the Granola webhook endpoint during installation with Granola's required `workspace` scope and note access/edit/generation events — the three events Granola's API defines; a regenerated summary arrives as `note.edited`, and a verified delivery naming any other event is refused with 400 `unsupported_webhook_event`. This admits notes visible through that Workspace API key. Deliveries are verified against their untouched raw body using the endpoint's Standard Webhooks signing secret before storage, deduplication, normalization, and queueing. Granola's delivery is a change signal, so Rally hydrates the current note through `GET /v1/notes/{note_id}` before opportunity admission. Disconnecting immediately disables local access and queues removal of the exact recorded remote endpoint. Pending cleanup retains separate encrypted removal authority; repeated disconnect does not erase it. Test and disconnect adopt an existing connection without changing its subscription, destination or signing secret. A workspace connection whose webhook endpoint was never registered, no longer exists, or is disabled reports healthy with a warning naming the condition, because its read tools work; delivery is restored only through Test and the installation lifecycle, never by the health check.

Granola sends `note.generated` only when a note's first summary is written while the workspace endpoint can already read the note, and a workspace endpoint reads public workspace notes and spaces with API access turned on. A note generated in a person's own space and moved into a shared folder afterwards — the ordinary way a note reaches one, because a note cannot be started inside a team space — arrives as `note.access_granted` instead, and Granola never sends the other. So the ingress asks Granola for the note before storing anything: when its summary exists, a `note.generated` activity is stored beside the share, from the same delivery and payload with its own dedupe key and `derivedFrom` naming the share, and a Sidekick whose trigger is "Transcript added" runs for it. Both that derived event and the `note.generated` Granola sends itself carry an occurrence key naming the note — `occurrenceKey`, a field of the normalized activity that adapter code sets and namespaces by provider and connection, which the workspace store lifts onto the delivery as its own field and never from provider metadata, so no payload can plant one — and a Sidekick admits an external event under that key when one is present, so a note reported twice — shared before its summary existed, or moved between two shared folders — runs once. A share of a note whose summary does not exist yet derives nothing, because Granola will send `note.generated` when the summary is written; a note the workspace key cannot read (401, 403 or 404) derives nothing either and is logged as `connector_webhook_derive_refused` with the status; and a share Granola will not answer about — a timeout, a 5xx, a note shape this connector does not recognise — is reported anyway, marked `summaryVerified: false` in its metadata and logged as `connector_webhook_derive_unverified` with the failure code, but under its own delivery's identity rather than the note's key, so the `note.generated` Granola may still send for it is not turned into a replay. Every outcome that stores nothing has its own word in the wrapper's log (`pending_summary`, `unreadable`, `credential_unavailable`, `not_applicable`). Rally sets no deadline of its own on that read: `WEBHOOK_DERIVE_TIMEOUT_MS` is open until the team sets it, and Granola allows fifteen seconds for the whole delivery and retries one that overruns it. `note.access_granted` remains a trigger of its own, labelled "Note shared", for a person who asks for every share.

The workspace key and webhook signing secret are encrypted in the owning
WorkspaceDO connector row with AES-GCM and connection-ID additional
authenticated data. The plaintext key is accepted only by the admin-only setup
request, is never stored in routing metadata, provider identifiers, or audit
data, and is never returned to the desktop. One active Granola workspace
connection is allowed per Rally workspace; one active personal Granola
connection is allowed per member and workspace.

### X

X is a workspace-only, read-only public-data connector backed by Rally's regional TwitterAPI.io account; it is not an X OAuth connection and does not represent an authorized X user. It provides public user timelines, thread context, replies, and List timelines. All four tools return one provider page at a time and expose the returned cursor for explicit pagination. Thread reads include the original post even when it is absent from the initial thread page.

Its health check verifies reachability and authentication and deliberately reads no balance. TwitterAPI.io bills against more than one — its dashboard shows recharge and bonus credits separately, both spendable — while its published schema for `/oapi/my/info` documents only `recharge_credits`. Reading that single field reported an account holding roughly ten thousand usable bonus credits as having none, which failed every `plugin_x` load in the workspace. Whether a call can be funded is the provider's judgement, made per call, and it makes it: an unfundable tool call fails with the provider's own error, which is accurate and current in a way a balance sampled at activation could never be.

### Web discovery

The loadable `rally:web` plugin exposes `web_search` and `web_fetch` through Firecrawl. Search returns bounded ranked links; fetch accepts only safe public HTTP(S) URLs and returns bounded clean Markdown. The plugin is omitted entirely when the regional `FIRECRAWL_API_KEY` secret is absent.

### Generic webhook

Each connection receives a unique secret and URL. Send compact JSON with a Unix timestamp and signature header:

```text
X-Rally-Signature: t=<seconds>,v1=<hex HMAC-SHA256 of "<seconds>.<raw body>">
```

Rally validates time, signature, replay receipt, body schema, scope, and dedupe key before normalizing an activity. Transcript providers can use this connector, but the product must not label it a native Granola integration.

Settings exposes personal and administrator-only workspace webhook creation. Creation accepts an idempotency key so a retried response returns the same endpoint and still-current one-time secret. The regional API lets the owner of a personal webhook rotate its secret and requires an administrator for a workspace webhook; desktop Settings deliberately narrows every visible Refresh action to workspace administrators. Rotation keeps the endpoint stable and invalidates the old secret immediately, so Settings cannot let its confirmation dialog close while the replacement secret is still being requested.

The request body must be a JSON object no larger than the regional provider-webhook limit. The supported fields are:

- `provider_event_id` or `id`: stable source delivery identity, up to 500 characters. If both are absent, Rally derives an identity from the normalized signature.
- `event_type`: source event name, up to 500 characters. Omission becomes `webhook.received`; a connection configured with allowed event types rejects names outside that allowlist.
- `resource_type` and `provider_resource_id`: optional stable source resource identity.
- `occurred_at`: optional ISO 8601 timestamp with an explicit offset.
- `title`, `summary`, and `text` or `text_snippet`: bounded human-readable evidence. Only the compact normalized snippet enters activity metadata; the exact signed body remains in regional payload storage.
- `actor` and `subject`: optional JSON objects describing the source actor and object.
- `entity_keys`: up to 100 stable correlation keys; `dedupe_key`: an optional stable idempotency key.
- `target_user_ids`: for workspace connections only, up to 100 active members of that same Rally workspace. Personal connections always target their owner and ignore supplied targets.
- `external_people`: up to 10,000 distinct external-person references after deduplication. Generic-webhook claims remain unverified source evidence and can never create a reusable verified identity mapping.
- `metadata`: optional provider-specific JSON metadata.

Rally verifies the HMAC over the exact received bytes before UTF-8 decoding or JSON parsing. Invalid signatures return `401`, malformed or schema-invalid bodies return `400`, disallowed events or non-member targets return `422`, identity/dedupe collisions return `409`, oversized bodies return `413`, and new deliveries return `202` (`200` when the same delivery is already known). Senders should retry network failures and `5xx` responses with exponential backoff using the same identity and exact body; they must not reuse an identity or dedupe key with changed content.

### Unsigned webhook subscription handshakes

Use Notion's setup flow as the reference pattern when a provider sends an
**unsigned setup challenge whose plaintext becomes the secret for later webhook
verification**, especially when the provider's dashboard requires an operator to
paste that plaintext back. This is narrower than ordinary webhook verification:
GitHub and Linear start with developer-configured signing secrets, Slack starts
with its app signing secret, Granola returns a Standard Webhooks signing secret
while Rally creates the endpoint, and generic webhooks are created by Rally.
Those connectors do not need this handshake.

For a provider that does match the pattern:

1. Generate a cryptographically random, short-lived setup nonce and put it in the
   one setup URL. Store only its hash and expiry. Never put a reusable setup
   credential in the query string: edge and platform observability may capture the
   complete URL before application logging or redaction runs.
2. Consume the nonce atomically with the first challenge, binding it to a hash of
   the delivered verification secret. Make the encrypted active-secret write
   conditional on that setup generation still being current, closing the race
   between claiming and storage. A retry of the same pair is idempotent; a
   different secret, an expired or already consumed nonce, and an older pair
   superseded by a newer setup are rejected.
3. Encrypt the delivered secret immediately and never log it or return it from a
   public API. If an operator must paste it into the provider UI, supply a local
   command that reads the ciphertext through authenticated infrastructure
   administration access,
   decrypts with the region's existing connector key and version, and writes the
   plaintext directly to the clipboard without printing or persisting it.
4. In a multi-region single-ingress design, authorize and capture the challenge at
   the public ingress, then forward the plaintext only over the authenticated
   internal regional binding so every region can encrypt its own copy. Do not ask
   the provider to repeat a one-time challenge to each region.

The setup runbook must preserve that order: prepare the one-time URL, create or
rotate the provider subscription, retrieve the captured secret locally if the UI
requires it, then verify delivery. Keep provider-specific storage and commands in
the provider's module document; extract shared code only when a second connector
actually needs the pattern. Notion's implementation, retry rules, regional fan-out,
and operator commands are documented in [`notion-ingress.md`](notion-ingress.md).

Gmail person evidence is deduplicated by role and address across From, To and
Cc, with sender first. The shared `ExternalPeopleSchema` enforces the
user-selected 10,000-person limit after deduplication; 10,001 distinct people
are rejected explicitly, never silently truncated. A role and provider tenant
remain part of identity, and email matching is case insensitive. There is no
per-header cutoff. Each evidence item holds its matched address rather than a
copy of the entire recipient header. Terminal poll failures retain the safe,
field-specific diagnostic code in the connection's `error_json` and message,
including across Workflow retries and replay. Provider response text is never
copied into the stored diagnosis.

WorkspaceDO migration 122 creates `workspace_connector_event_people`, one
ordered row per person, without rewriting retained events at startup. Legacy
bounded JSON rosters remain readable until replacement or normal retention. Positions are
constrained to 0–9,999 and the event foreign key cascades deletion. New events
keep the compatibility JSON cell empty and insert people in the same transaction
as their event; reads and claims reconstruct the full ordered list. Restoring a
late repeat copies its people too. This avoids the old 262,144-character cell
constraint and Cloudflare's 2 MB row limit without widening historical DDL.

Suggested Work retains that complete list in sources and provenance. Its single
bounded model view reports shown and total counts without changing the canonical
source; see [`suggested-work.md`](suggested-work.md).

### Activity ingestion

WorkspaceDO discovery upserts write only when type, title, effective canonical
URL, or merged resource metadata changes. A missing URL retains the stored URL;
metadata keeps JSON merge-patch semantics, including explicit-null deletion.
`discoveredDeliveryId` and `discoveredEventType` alone do not count as resource
changes: those fields and `updated_at` describe the last meaningful discovery
change, not a last-seen heartbeat. Real workerd coverage lives in `resource-update-cost.test.ts`.

Connectors expose one of two provider-facing activity facets while sharing the same normalized activity, persistence, queue, identity, and opportunity pipeline:

- `webhookActivity.verify` verifies exact raw bytes and returns a provider-neutral delivery envelope; `normalize` applies connection scope and provider-specific semantics. Ashby, GitHub, Granola, Linear, Notion, and generic webhook use this facet.
- `pollingActivity` declares named streams and polls each from an opaque provider-native high-watermark. Its required `normalizeHighWatermark` hook canonicalizes sequences, dates, cursors, legacy values, or composite provider state both when checkpoints are loaded and before they are committed. The shared checkpoint runner bounds retries and backlog scheduling while leaving provider hooks in control of checkpoint semantics, pagination, reset/reconciliation rules, and activity normalization. Google currently supplies Gmail, Calendar, and Drive streams.

**A connector that will no longer take a *credential* in one of its scopes says
so in `connectableScopes`,** read through `connectorScopeIsConnectable`. It is
deliberately not `supportedScopes`: narrowing that would take the tools, the
events and the webhook ingress away from the connections a workspace already
made, which is a data migration rather than a product decision. This one closes
the door and leaves what is behind it working. Fireflies declares
`["personal"]`; every other connector omits it and inherits `supportedScopes`.

The line it draws is **a new grant, not a new request**, and four places in
`ConnectionService` enforce it, all answering `connector_scope_not_connectable`:
`beginProvider` and `completeProvider` refuse a *creating* authorization —
one carrying no `connectionId`, since a state minted before the scope closed
must not land a connection after it — `createWorkspaceInstallation` refuses a
new installation, and `replaceInstallationApiKey` refuses a new provider key
for an existing one, because a replacement key is a different administrator's
account as easily as the same one's. Reauthorizing a connection that exists is
allowed, as is every path that reads, repairs with the credential already
stored, or disconnects: `replaceConnectorInstallationCredentials` is the only
writer of a new provider credential, so that boundary is the whole of it.

**A connector whose events reach Rally in only some connection scopes says so
in `activityConnectionScopes`,** which narrows `manifest.supportedScopes` for
activity the way `capabilityConnectionScopes` narrows it for a capability, and
is read through `connectorActivitySupportsScope`. Granola, Fireflies and Ashby
declare `["workspace"]`: their webhook belongs to the workspace install, and
each `normalize` throws `unauthorized` for any other connection. Nothing in a
manifest says which side of an install a provider's webhook lives on, so this
is declared rather than inferred, and an adapter that narrows activity it does
not produce is refused at registry construction. What reads it is the drafting
catalog, in
[`automation-lifecycle.md`](automation-lifecycle.md#drafting-in-the-conversation).

#### Declaring what a digest may read

**Nothing reads this declaration today.** The digest lists what is unread in a
person's Activity tab (mentions, additions, thread and breakout starts, finished
runs), and none of those are connector events, so connector activity does not
reach the digest. The declaration is still required and still written to the
log, kept for a future surface that tells somebody about connector activity;
the rules below are what that surface would read.

**Every activity type a connector declares must say whether a person should be told about it in a digest, and there is no default.** `ConnectorActivityTriggerDescriptor` carries a required `digestible`, and `defineConnectorActivityTriggers` takes the event types as two lists rather than one:

```ts
activityTriggers: defineConnectorActivityTriggers("GitHub", {
  digestible: ["github.pull_request.merged", "github.pull_request_review.submitted", …],
  operational: ["github.workflow_run.completed", "github.push", …],
})
```

The shape is the point. There is no list meaning "I did not think about this", so adding an event type is adding it to a list, and an event type in both is refused where it is written rather than resolved silently. Ask it this way: **would a person who was away for a day want this read back to them?** A pull request opened, yes. The eleven check runs it started, no.

`operational` is not a rejected event. It is verified or polled, normalized,
routed, matched against automations and watches, considered for Suggested Work,
and written to the activity log exactly like a digestible one — every surface
except the one that interrupts somebody on a schedule. Answer the digest
question when classifying an event type, and nothing else. Most of what a
provider emits belongs here, and that is the normal case rather than a failure:
the GitHub manifest declares eighty-seven activity types and thirty of them are
digestible. Every current connector's classification, one row per activity type
with the reason, is in [`connector-digestibility.md`](connector-digestibility.md).

A **polling activity stream** declares `digestible` too, and it is required for the same reason: a stream is the granularity a connector author actually thinks in — Gmail is somebody's day, Drive's change feed is a file watcher — and a stream added later has to state which it is. **A stream can only ever withhold.** An activity is digestible when its event type says so *and* the stream that produced it agrees, so the two declarations cannot contradict each other into somebody's inbox, and a stream saying yes grants nothing on its own. `pollCheckpointedActivityStreams` stamps the withholding onto every activity a non-digestible stream returns, at the one place all polled activity passes through, so an adapter can neither forget to mark its output nor grant itself a digest it was not given.

The manifest is read when the activity log is written, in `activityIsDigestible`, keyed on the event type — the one thing an activity carries all the way from the provider to the log. **Everything unknown is withheld**: a connector this region does not register, an event type a manifest has dropped, an activity older than the declaration. None of those are somebody confirming that a person wants this in their inbox, and being wrong costs one way only. The answer is stored in `workspace_activity_events.digestible`, which nothing reads today; [`digests.md`](digests.md#digestible-what-a-person-should-be-told) owns it.

#### Dropping events that say nothing new

Two filters run before an event costs anything, and both drop rather than withhold: a dropped event is not stored, routed, matched against automations or watches, or offered to Suggested Work.

**GitHub continuous integration is discarded at ingress.** `isDiscardedGitHubDelivery` drops every `check_run` delivery and every `workflow_run` action except `completed`, at the Global receiver (`GitHubRoutingService.ingestGitHub`, beside `ping`) and again on the regional path, before any payload is written to R2 or any resource is inventoried. The manifest no longer declares those types, so a Sidekick cannot be drafted against a trigger that never fires. Suggested Work keeps its `github.check_run.` exclusion as a named retired prefix, because check runs stored before this change can still drain. A check run's result is still readable on demand through the Actions tools.

**A new identity that repeats its resource's latest content is that event again.** `ingestConnectorEvent` fingerprints the whole event except the fields that name or time a delivery (`id`, `receivedAt`, `occurredAt`, `providerEventId`, `dedupeKey`, `payloadRef`) and keeps the latest fingerprint per connection, event type and provider resource in `workspace_connector_event_latest_content`. A new event whose fingerprint equals that one is receipted against the earlier event and answered as a `duplicate` carrying `unchangedContent: true`. The Queue consumer then enqueues nothing, whatever state the earlier event is in: a pending or failed event's processing belongs to its own admission, and waking or retrying it on every re-stamp would turn the flood into work. A Queue redelivery of the repeat is answered from its receipt the same way, recognised because a content match is the only receipt whose event shares neither the delivery's provider identity nor its dedupe key. A latest event that has `failed` is never matched: its content was never delivered, so a repeat of it is stored as a new event with a retry budget of its own and becomes the latest. Only the latest is compared: a change and its reversal are both news.

**Order is `occurredAt`, not arrival.** A Queue batch admits events concurrently, so a change and its reversal can reach WorkspaceDO in either order. The latest-content row keeps the newest `occurredAt` it stands for, and a repeat is dropped only when it is no older than that. When one is dropped, its identity (event id, payload hash, provider identity, dedupe key, times, payload reference) is kept on the row in `dropped_json`. An event older than the row is always stored and never becomes the latest. If it differs from the latest content and a repeat was dropped after it, that repeat was the state it changed back from, so it is restored: stored as its own event, copied from the event whose content it repeated, under its dropped identity, and it becomes the latest. The late event's ingress receipt records it in `restored_event_id`, and the ingest answer carries `restoredEventId`, so the consumer enqueues its processing on the first delivery and again on any redelivery while it is still pending; once claimed, its own processing owns any retry. Nothing else would wake it, because its own delivery was dropped. An event with no provider resource is never compared. The ingest log carries `unchanged_content: true` for a dropped repeat.

This puts a duty on adapters: **the content must carry the change.** An adapter whose only change marker is a timestamp or an identity must also put that marker in its metadata, or its genuine repeats are dropped. Drive does so with `modifiedTime` and `md5Checksum`, because a Google-native file has no checksum and two edits would otherwise read the same; a change that moves neither, such as sharing, is dropped. Every verified webhook path is unaffected, because each carries a hash of its raw body, which differs per delivery. Calendar deliberately carries no `updated` or `etag` in its content: Google re-stamps events with nothing visible changed, and that is the flood this filter exists for. A Calendar edit to a field the adapter does not fetch (description, conference link) is therefore dropped too; it was invisible to every reader before.

Manifests and facets are cross-validated at registry construction: a connector that declares provider activity cannot claim webhook or polling support without the corresponding implementation. Slack keeps its dedicated signature-verified Agent ingress, but that ingress may normalize a bounded event into the shared activity pipeline when an exact active automation source is listening; it does not create a general Slack feed. X remains an on-demand read connector because a connection does not yet select a monitored user, list, or stream rule from which a safe feed could be constructed.

1. The provider-facing Worker verifies a webhook or a poll Workflow reads the provider. Large raw bodies remain in regional R2.
2. Resolve every authorized connector installation. A single raw provider delivery may fan out to multiple workspaces only when that account is independently installed in each one; normalization produces a separate event for every connection/workspace target.
3. Normalize the bounded event for one workspace target and retain any large raw body in regional R2.
4. Enqueue the region, normalized event, ingress UUID, and canonical
   content hash on that region's Cloudflare Queue. Events above the existing
   120,000-byte envelope budget are stored intact in R2 and sent as
   `connector_queue_payload` references; the consumer verifies their region,
   body hash and message type before ordinary admission. Raw provider bytes
   remain separate behind `payloadRef`; the Queue message is independently parseable and
   does not need a D1 activity-body lookup.
5. The Queue consumer resolves the workspace's jurisdiction and placement affinity and calls `WorkspaceDO.ingestConnectorEvent`. Provider identity and dedupe uniqueness are enforced inside that object's transaction, and an ingress receipt makes Queue/provider replay idempotent.
6. After the object commits, the consumer sends an ID-only
   `connector_event_process` pointer to the same regional `ACTIVITY_QUEUE` and
   acknowledges ingress. The pointer carries a generated processing-owner UUID
   that remains stable across native Queue retries; it is not derived from or
   formatted as an external platform identifier.
7. A later Queue delivery claims and loads the event from WorkspaceDO over typed
   RPC. WorkspaceDO issues a fresh, 15-minute processing lease for each acquisition.
   A duplicate returns `busy` with the lease's exact expiry; a delivery after
   expiry can recover interrupted processing, and settlement is fenced by the
   returned lease token so the expired handler cannot overwrite its successor.
8. Under that lease the consumer first calls
   `matchExternalEventDestinations`. That is the **only** automation and watch
   fan-out: WorkspaceDO selects active registrations by
   connection, connector type, event type, and activation boundary, applies the
   audience rule, evaluates each one's typed DNF predicate with no model
   inference, and inserts one delivery row per match. A durable `claimed`
   witness remains true after those delivery rows settle, so processing retries
   cannot mistake handled work for an unmatched event. An event whose
   `metadata.externalConversationPath` resolves to an external conversation
   binding is claimed too, with no delivery row, because the binding's own
   ingress already delivered it. Only an unclaimed event
   enters WorkspaceDO's Suggested Work batch tables; activity-log projection is
   unconditional. There is no semantic route into an existing work stream.
   Admission and ranking are separate fenced Workflows whose durable product
   results, including provenance and per-user resolutions, commit in the same
   WorkspaceDO. The evaluator grammar is deliberately closed and deterministic,
   and [`automation-lifecycle.md`](automation-lifecycle.md) owns it. The Queue
   consumer then settles the authoritative event as processed or failed. A
   transient failure calls per-message `retry()` and an exhausted message enters
   the existing regional activities DLQ.
9. Each match becomes its own message on the same regional Queue, carrying the registration, the destination, and the event inline or with a canonical-event reference for oversized context. No snippet or metadata is discarded to fit the Queue. The consumer calls `AutomationDO.admitExternalEvent` or `SubstreamAgent.appendWatchedResourceEvent`; the destination re-checks its own lifecycle and activation boundary and admits at most one occurrence per canonical event, keyed on the event id, so there is no delivery ledger and no lease to settle.
10. WorkspaceDO deletes a `processed` event 90 days after it was received, on its alarm's `connector_event_reap` phase; pending, processing and failed events never age out. The retention and its arithmetic are in [`workstream-durable-object.md`](workstream-durable-object.md). Legacy D1 `activities` rows are imported and scrubbed before the route opens; live events never create a D1 body handoff.

When it enqueues a delivery (step 4), provider webhook ingestion (GitHub,
Linear, Notion, through `services/provider-webhook-service.ts`) tells the
workspace socket what moved. `connector_connections` and `resources` go, per workspace, to the
audience of the connections the delivery matched: everybody when any of them
there is Organization-scope, otherwise only the owners of the personal ones,
since a personal connection's resources are its owner's alone. `activity` goes
to the whole Organization.

**Processing carries only IDs; oversized ingress commits before queueing IDs.**
Storage-field validation mirrors the existing SQLite constraints before enqueue,
so an oversized metadata, actor, subject, or summary fails with its field name
rather than accepting an event that can only retry into the DLQ.
Small first-stage events travel inline. An event above the existing 120,000-byte
Queue envelope budget calls the same typed WorkspaceDO admission primitive
directly, then queues the processing IDs after its canonical commit. A failed
send replays idempotent admission before retrying the wake-up. Processing always
reloads canonical state from WorkspaceDO.

Oversized matched deliveries keep registration, destination, and event identity
in the Queue envelope and reload `textSnippet` and `metadata` through the
canonical event's context projection. They create no second copy in R2, so
canonical event retention also owns their context. Hydration failures retry
separately from destination processing, whose existing acknowledgment policy
applies unchanged.

Google normalization rollouts accept a legacy payload and its enriched replay
under one event identity. Missing Calendar attachments, the historical 100-person
prefix, and compact Gmail address evidence are compared in their legacy shape;
the richer roster and attachment metadata replace canonical context atomically,
without changing processing status or firing another occurrence. Other content
changes, including conflicting nonempty attachment lists, still fail identity
validation. The compatibility check rechecks the canonical hash after its async
comparison before committing enrichment.

Every durable boundary above emits a structured outcome rather than leaving a
Queue acknowledgement to stand in for downstream success. Follow one event by
`workspace_id`, `connection_id`, `connector_event_id`, `ingress_id`, and
`processing_owner_id`: `connector_event_enqueued`,
`connector_event_authority_ingested`, `connector_event_queue_terminal`, the
`connector_event_process_*` events, and
`connector_event_authority_terminal` distinguish enqueue, authoritative
acceptance, claim, retry/defer, and final settlement. Legacy
`connector_event_workflow_*` logs identify only instances created before the
cutover. `connector_poll_terminal` records the connector, successful
activity count, per-stream error codes, cursor commit, and next scheduled poll.
Provider content and credentials remain excluded; opaque provider and Rally IDs
are correlation fields and should be logged.

The canonical event remains the automation trigger's evidence after admission.
Prompt construction and between-turn authorization revalidation load it from
WorkspaceDO. Suggested Work admission also loads that authority rather than a
scrubbed D1 `activities` row.

One normalized event is never sent to two WorkspaceDOs and is never shared
between workspaces. Fan-out happens before normalization at the raw provider
delivery boundary. Each target gets its own event identity, authorization,
visibility, dedupe receipt, processing owner, and workspace-local durable row.
A provider account installed twice in one workspace may likewise produce two
connection-scoped events; collapsing those requires an explicit workspace-level
product rule rather than an accidental cross-connection dedupe.

The removed semantic route into an existing work stream is recorded in
[`contextual-routing.md`](contextual-routing.md). It is not a dormant step in
this pipeline: current processing has no classifier, card, or feedback endpoint.

A routed watch activity names the resources it matched. Their titles are in the
message text a participant reads, so the person who sees the notification can
tell which attached document went stale; their ids and aliases ride in the same
message's structured content for a surface that wants to link them, which
nothing does yet. The re-fetch that turns a stale snapshot into history is the
right rail's own action on the resource, not something this message performs:
the notification marks staleness and nothing more, which is the line between a
watch and continuous synchronization.

An explicit resource watch may move content only into an audience no broader
than the activity's. Workspace-visible activity may enter any watched work
stream. Restricted activity requires a private target whose complete
active-participant audience is contained in the activity's permitted user
set; one overlapping reader is not enough, and a workspace target is refused.

Native GitHub, Linear, and Notion deliveries use the same compact Queue envelope
and routing pipeline. Their exact signed raw payload is retained regionally in
R2. D1 may store an idempotent global provider-delivery receipt needed before a
workspace is known; WorkspaceDO is the credential, workspace-handoff, and
normalized-event authority.

#### Suggested work admission

Eligible connector activity is grouped into bounded per-member personal batch windows before the suggested-work admission agent decides whether to ignore it or create/update a work opportunity. A workspace-visible event is copied into one window per active member; the event remains workspace-visible while each inference sees only that member's authorized directory context. The model-facing JSON Schema deliberately uses only the portable structural subset: object and array shapes, primitive types, required fields, enums, and `additionalProperties: false`. Do not add string formats, string-length bounds, numeric bounds, or array-length bounds to that provider schema. Nested limits such as `linkedUsers.maxItems` can make the schema's constrained-decoding state space too large for otherwise supported Gemini structured-output endpoints, causing every admission request to fail before inference.

The stricter `AdmissionResultSchema` remains authoritative after generation. It enforces UUIDs, string lengths, offsets, source counts, linked-user counts, and the four-decision cap before any result reaches persistence. This separation is intentional: the provider schema guides portable constrained generation, while Zod is Rally's trust boundary. Keep regression coverage asserting both halves whenever the admission response changes. The repository ESLint rule `avalon/provider-json-schema-complexity` statically follows schemas passed through a `jsonSchema` property and rejects excessive schema depth, node count, detailed constraints, or nested bounded-array expansion; a dynamic or imported schema that the rule cannot resolve still needs an explicit unit test.

Admission failures are retried through new batch windows only while an event's attempt count is below three. Once that limit is reached the event remains failed; deploying a schema or model fix does not replay it automatically. Operators must verify the corrected admission path first, then use an explicit, bounded replay rather than resetting every activity indiscriminately.

A connector's normalized `title`/`summary` is not independently bounded to the API contract's resource limits (`ResourceSchema` in `packages/contracts`, 300 characters for `title`). Each connector truncates to its own cap before writing `activities` — GitHub's webhook titles cap at 500 — which is wider than what the response schema accepts. `WorkstreamService`/`SubstreamAgent` defensively truncate at every read and write site that surfaces this data, but a new connector should not rely on that alone: keep any new title/summary truncation at or under 300/2,000 characters at the connector layer too, so a work stream never depends solely on a downstream guard to stay openable.

Slack is a composable `resource` and `messaging_agent` connector. Workspace installations host the Agent, App Home, interactive surfaces, activity triggers, and deterministic automation delivery; the bot is in a conversation only where it was invited, which links the room to a Space, or where a Sidekick's Slack source names it (see [`external-conversation-bindings.md`](external-conversation-bindings.md)). Accepted DM and mention prompts receive an immediate `eyes` reaction through the shared activation hook before processing. Optional personal authorizations use Slack's hosted MCP server and its live `tools/list` surface rather than Rally's historical snapshot. Slack delivers bounded message, reaction, file-share, channel, and membership events. Agent-thread events follow the existing conversational path; events matching an exact active automation source are normalized into the shared regional activity pipeline. Unmatched activity is discarded before durable queueing and is never turned into a general Slack feed or mirrored corpus. See `docs/slack-integration.md` for the product and data flow and `docs/slack-permissions.md` for the complete OAuth scope inventory.

### Product measurement

Connector setup intent records only connector, personal/workspace scope, setup
method, and bounded capability count. The regional service owns terminal OAuth
outcomes and successful direct connection creation. Test, reconnect, disconnect,
and webhook-secret rotation report previous/applied health and result; a distinct
health transition is emitted only when health actually changes. Activity ingest
reports canonical connector/activity type, bounded item count, and
accepted/duplicate/filtered/failed result after admission. Connection IDs are
allowed only on resource-lifecycle events that require a stable join. OAuth
state, capabilities themselves, scopes returned by a provider, account/tenant
IDs, webhook bodies, activity content, error text, and credentials remain outside
telemetry. The established OAuth operation pair remains available to correlate a
desktop request with denial/failure while richer connection events describe the
configuration that was actually established.

## Invariants

Every rule below was learned from a defect in production or in review, and each names the failure that produced it. A new adapter is expected to satisfy all of them; several are enforced by the compiler or by `apps/api/test/connector-credential-freshness.test.ts`, which enumerates the registry so a connector is enrolled by existing rather than by someone remembering it.

**A pagination cursor says what to send when there is none, and spells that value `anyOf`.** Every cursor names the result field it is copied from, states that it is opaque and never constructed, and declares `anyOf: [{string, minLength: 1}, {null}]`, the spelling that says so without depending on the sanitizer; since `@juno-ai/bind` 14 the flat `type: ["string", "null"]` reaches the model as the same union, and `apps/api/test/tool-schema-sanitization.test.ts` asserts the delivered null branch for every property of every tool rather than only the cursors. Both halves are enforced by `apps/api/test/tool-argument-empty-strings.test.ts` and `apps/api/test/tool-schema-sanitization.test.ts`, which enumerate the registry through `apps/api/test/helpers/connector-cursors.ts` so a connector is enrolled by existing; a cursor named outside `CURSOR_PARAMETERS` is the one case still enrolled by someone remembering. *A run told to read a shared Drive folder invented `"/"`, `"1"`, and `"next"` for `pageToken` across eight calls, each rejected whole by Google, and then answered from public web search instead; the description added first did not stop it, because `minLength: 1` reads as a floor to clear when nothing says absence is expressible.*

**An event a connection cannot receive is never advertised to it.** A connector whose `normalize` refuses a connection scope declares that scope out of `activityConnectionScopes`, so no surface offers it a trigger on that connection. *A personal Granola connection advertised its four triggers, and the Sidekick drafted on one applied, activated, and never fired; nothing in the product distinguished that from a Sidekick that had nothing to do yet.*

**Never refuse an incoming request because a stored status says the connection is unhealthy.** Gate on `disabled` — a person's decision — and on nothing else; see [Stored status is a belief, not a gate](#stored-status-is-a-belief-not-a-gate). *A Slack installation refused sixteen hours of events, unfurls, identity links and automation deliveries without once asking Slack whether the grant still worked, and overwrote the accurate diagnosis of its own failure while doing so.*

**Never reach a provider with a credential nobody refreshed.** Enforced structurally: provider-calling entry points take `AuthorizedConnectorConnection`, which only the credential door can mint. *A Granola personal connection became unloadable minutes after it was connected, reporting `plugin_not_authorized` while the connections screen showed it healthy, because `load_plugin` revalidation health-checked it without refreshing first.*

**A refusal marked safe to retry came before any write.** `connectorResourceAccessRefused` tells the host it may run the same call on the run's next connection of that connector, so an adapter builds one only where nothing can have changed: a preflight that runs before the mutation, or a refused read. A refusal of the mutation request itself is never marked, and only an adapter that implements `probeResourceAccess` may build one at all. *A member's personal Google account could not see a Sheet that the Organization's could edit; the agent tried the personal one, got `403`, and asked them to fix a permission they did not need.*

**A health check must not write.** Provider state that needs restoring goes through installation management (or adapter `repair` for a provider without that lifecycle), which only an explicit connection test invokes. *Granola re-enabled its webhook endpoint with a `PATCH` inside `healthCheck`, which reauthorization ran on every plugin activation.*

**An unsigned setup challenge is not a logging channel.** When the delivered
plaintext will verify future webhooks, authorize the challenge with an expiring,
single-use, token-bound nonce, encrypt the plaintext immediately, and retrieve it
only through a local operator handoff. *Notion required its delivered
`verification_token` to be pasted back into its dashboard, but Cloudflare records
full request URLs before Worker redaction, making either a reusable query secret
or a log-based handoff a persistent credential in observability.*

**A health check answers reachability and authorization, never capacity.** Do not read balances, quotas, or credit counts to predict whether a later call will succeed; the provider decides that per call and will say so. *X read `recharge_credits` alone and reported an account holding ~10,000 spendable bonus credits as having none, failing every `plugin_x` load in the workspace.*

**A health check takes the caller's signal.** Reauthorization runs inside a Workflow step, and an `AbortSignal.timeout` created inside an adapter is not disposable — it holds the invocation open after the check returns.

**Say whether the provider refused you, or whether you could not tell.** `reconnectRequired` carries that distinction, and the host maps it to `denied` versus `indeterminate`. A verdict must never be derived from a swallowed exception: failing to verify an authorization is not a denial, and reporting it as one sends a run off to explain a permission problem that may not exist. *A bare `catch { return false }` turned every provider hiccup into a revoked grant.*

**A refresh that fails states a verdict.** When the grant itself is gone the failure carries `reconnectRequired: true`; when the failure was Rally's own — an `invalid_client`, a malformed request — it carries `reconnectRequired: false`. The adapter is the only thing that can answer this, because the vocabulary is the provider's own: *Slack answers a refused refresh with HTTP 200 and `{ok: false, error: "token_revoked"}`, and GitHub with HTTP 200 and `{error}`, neither of which any status test can see.* Stating nothing is not neutral — the host then classifies the failure itself, from `details.providerError` and the status, and an unclassifiable refusal marks. *Requiring the flag and defaulting to silence is what stranded Slack and Granola connections: a revoked grant left the row `healthy` forever, every run dropped the plugin, no member was ever prompted, and only somebody happening to press Test recovered it.* A connection reporting healthy while every call fails is the worse of the two ways to be wrong, so the default is the loud one; an adapter that knows better overrides it by saying so.

**Classify a token-endpoint failure by the provider's error code, not its HTTP status.** OAuth reports a dead grant and a malformed request of ours with the same 400. *Linear and Notion marked members' healthy connections `needs_reconnect` for any 400 or 403, demanding a reconnect that would fix nothing.* The classification has three answers, not two: a code naming a dead grant marks, a code naming Rally's own fault does not whatever the status, and anything else — an unfamiliar code or none at all — defers to the status. An unfamiliar word is not evidence, and treating it as a denial would invert the safe default: the two mistakes are not symmetric, and only leaving a dead connection reporting healthy is silent.

**Say when a healthy connection is degraded.** A health result carries `warning` for provider-side state that has drifted without making the connection unusable, and the host logs it. *Moving Granola's webhook repair out of the health check removed a repeated write and replaced it with nothing: delivery stopped silently and stayed stopped until somebody happened to press Test, because the one place that knew dropped the message.* Removing an automatic repair means leaving an automatic signal in its place.

**Recover once from a mid-call refusal, then believe it.** Route authenticated calls through `withProviderReauthorization` rather than carrying a private retry. A first rejection may be a stale token; a second is the real answer.

**Every rotation goes through the host, proactive and reactive alike.** A rotating refresh token is single-use, so two calls that refresh at the same moment leave the loser marking a connection `needs_reconnect` that its sibling had just rotated successfully. Use `withProviderReauthorization` on the rejection route and `refreshExpiringCredentials` on the near-expiry route; neither redeems a token beside the coordinator.

**Say where the things you produce live.** A work stream that exists because of a place in a connected tool attaches that place, and the connector is the only thing that knows what the place is. Every adapter gets this for its activities without writing code — `connectorOriginFromActivity` reads the object normalization already recorded — so implement `ConnectorAdapter.origin` only for a place no activity describes, such as a provider-hosted agent session, or when the activity's own object is not the place a person would want to be sent back to. A described `resourceType` must be one the manifest declares in `resourceTypes`, and `describeConnectorOrigin` refuses one that is not: a typo there forks the resource identity for every work stream started from that place afterwards, and nothing downstream would notice. See [work-stream origin attachments](workstream-origin-attachments.md).

**A work stream started from a conversation is that conversation's, not one member's.** Its visibility is the conversation's own — public for a public channel, private for anything else, including anything the connector could not classify — and a private one's participants are that conversation's members. Anybody in the conversation may continue it, and a member who arrives later is seated by their own message. *A Slack thread used to belong to whichever member happened to be linked first, and every other person in the channel — the workspace owner included — was answered with "this thread is already running with another Rally member's personal authority", in a public channel, in front of everyone.*

**Authority is resolved per message, and only an account link grants it.** A run spends personal connectors, memory, and approvals made in somebody's name, so it may run as a member only where that member has authenticated to Rally and bound their provider identity to it. A `verified_email` match credits and seats somebody; it never authorizes a run as them, and a connector must not promote it to one because it makes a thread work more smoothly.

**The exception: input bound to a Sidekick run follows the run, not the sender.** A reply in a provider thread bound to a Sidekick run child continues that run with its run-as user's connectors, whoever sent it, including a sender who is not a Rally member. The reply is framed to the model as labelled evidence from its sender, never as a member request, and only the Sidekick's config conversation can add the conversations a run reads or posts to. A connector opts a send into this by returning `externalConversation: { installationId, path }` on its `ConnectorToolResult`; the host binds the thread only for a run child, in the tool receipt's own transaction, and a binding already held elsewhere wins. See [`external-conversation-bindings.md`](external-conversation-bindings.md).

**Do not spend a provider round trip on something Rally already knows.** Revalidation between model turns is answered from WorkspaceDO connector state plus current D1 membership; only an activation goes to the provider. *Eight model iterations against a workspace Granola connection made roughly twenty-four provider calls per run purely to re-establish authority already recorded locally.*

Each installed credential has two deliberately separate plugin identities. The opaque canonical ID, `connection:<uuid>`, is the only identity used for authorization, durable activation, receipts, and credential access. A database-backed workspace-local ID is the model-facing name: the first active credential of a provider receives `plugin_<provider>`, and simultaneous additional credentials receive the lowest numeric suffix (`plugin_google_2`, `plugin_google_3`, and so on). Disabled connections do not reserve names, so removing and later re-adding a provider reclaims the clean base instead of accumulating random characters. A partial unique database index enforces uniqueness across the active connection list.

The model sees only these stable IDs in plugin catalogs, active-plugin instructions, and `load_plugin` arguments. Rally resolves them back to canonical IDs before scope checks or persistence. Model-facing IDs are presentation and routing aliases, never security principals. Connector tool definitions use prefix-free names local to their plugin; the runtime adds the connection's stable short name when rendering model-facing tools. For example, canonical `drive.search` becomes `google_drive_search`, or `google_2_drive_search` for a second Google credential.

A static connector tool whose Zod input schema has `.refine()` or
`.superRefine()` implements `ConnectorAdapter.validateToolInput` with that same
schema. The provider-facing JSON Schema cannot represent callbacks; this pure
classifier lets the harness preserve their actionable messages when an executor
throws, without moving enforcement out of `executeTool`. Dynamic hosted-MCP
tools do not use a static connector validator because their live provider schema
is the only input contract Rally owns.

**An event type that declares no `resourceRelationships` cannot be narrowed to a
resource, and the containers it would have named cannot be found.** Declaring
the relationship is what makes a resource type reachable: the registration
reconciler builds a watch's evaluator set from it, the accept-side validator
admits a rule's `resourceId` only against it, and `resources_search`
offers only the types some trigger declares — everything else is a refusal
acceptance is certain to reach, so offering it is worse than omitting it. Name
the container an event happens *inside* (a repository, channel, project, page,
folder, file, thread), never the thing the event produced. *A repository was two
rows among the eighty thousand files, commits and check runs its own events had
materialized, all matching its name and all fresher than it; the drafting agent
searched, found no repository, and saved a pull-request Sidekick with no event
trigger at all.*

**A GitHub signature is verified once, at the receiver, and nothing downstream verifies it.** The Global receiver's HMAC over the exact request bytes is the only check; the `github_webhook_delivery_v1` Queue message and the regional bridge's `ingestVerifiedGitHub` are the only two ways verified bytes travel on, neither carries a signature, and `parseGitHubWebhook` is the parse without a check. Anything that can put bytes on that Queue or call that bridge is therefore inside the trust boundary, and a new path that hands on GitHub bytes must go through one of the two, not add a third. *Verifying at the receiver and again in the region cost two more passes over bodies of up to 25 MB while GitHub waited, and bought nothing: nothing could reach the region without passing the first.*

## Boundary

This document owns the connector registry and the contract every adapter meets:
authorization, credential freshness, health semantics, actor identity, discovery,
refusals, activation acknowledgement, and the deterministic half of activity
ingestion (steps 1 through 7, plus the manifest vocabulary step 8's typed
evaluators are validated against). The
adapter owns provider protocol details; Rally
owns tenancy, execution principals, persistence, retries, schedules, and audit.

It does not own:

| For | Read |
| --- | --- |
| The retired Suggested context feature | [`contextual-routing.md`](contextual-routing.md) |
| Which unclaimed activity becomes a home-screen suggestion | [`suggested-work.md`](suggested-work.md) |
| One row per declared activity type, with the reason | [`connector-digestibility.md`](connector-digestibility.md) |
| What `digestible` is kept for, now that nothing reads it | [`digests.md`](digests.md#digestible-what-a-person-should-be-told) |
| The registrations, secrets, and the zero-copy definition | [`provider-apps.md`](provider-apps.md) |
| Slack's product surface and its scope inventory | [`slack-integration.md`](slack-integration.md), [`slack-permissions.md`](slack-permissions.md) |
| Linear's protocol and native-agent gate | [`linear-integration.md`](linear-integration.md) |
| The single Notion ingress | [`notion-ingress.md`](notion-ingress.md) |
| How a tool is *designed* so a small model uses it right | [`agent-tools.md`](agent-tools.md) |
| How a run holds and narrows connector authority | [`agent-harness.md`](agent-harness.md) |
| Why an automation sends its own results, and the one destination that is not the run's | [`automation-lifecycle.md`](automation-lifecycle.md) |

Adding a personal delivery surface touches registries only, and only the
digest's: `AutomationDeliveryTargetTypeSchema` (the name is historical; digests
and delivery receipts share it), `PERSONAL_IDENTITY_LINKS` if the surface needs
a link, `FROZEN_IDENTITY_RESOLVERS`, and `CONNECTOR_DELIVERIES` in
`digest-delivery-service.ts`. Automations no longer have a delivery path to
register with: a run sends its result through whatever connector tools it
holds, so a new surface reaches automations the moment its connector ships a
send tool. Nothing about which providers can deliver is written into the API
or the client.

The one thing to be careful with is where the identity-link table lives: a new
one (`teams_user_links`, say) is a WorkspaceDO table, so any read of it from a
Durable Object goes through `withWorkspaceRuntimeDatabase` (inside WorkspaceDO,
its own storage via `localWorkspaceEnv`), never `this.env.DB`.
Written against the regional binding it names a table regional D1 does not have,
which reaches the person as "An unexpected error occurred" rather than as
anything naming the boundary. That defect was found on the automation delivery
path this section used to describe. `rally/durable-object-workspace-table-routing`
now guards it.

## Failure modes and limits

- **A first provider rejection buys one refresh and one repeat; a second is the
  real answer.** What counts as a refusal is each adapter's own vocabulary through
  `isProviderCredentialRejection`, never the `unauthorized` code alone — adapters
  raise that for policy and configuration failures that never reached the provider,
  and spending a single-use refresh token on one buys a retry that fails
  identically.
- **A token-endpoint failure has three answers, not two.** A code naming a dead
  grant marks; a code naming Rally's own fault does not, whatever the status; an
  unfamiliar code or none at all defers to the status. An unfamiliar word is not
  evidence, and the two mistakes are not symmetric — only leaving a dead connection
  reporting healthy is silent.
- **A mark records the first, most specific diagnosis.** The writes that set
  `needs_reconnect` still filter on `status = 'healthy'`, so a row already marked
  keeps the verdict that explains why; re-marking on every later attempt is what
  replaced a precise scope failure with a bare `unauthorized`.
- **A job classified non-retryable on authorization needs something to lift the
  ceiling.** `redriveReauthorizedIngress` re-queues a job whose connection has been
  written since it last failed, which is self-limiting because a job that fails
  again stamps itself newer than the connection. Without it an outage becomes
  permanent for every request that arrived during it.
- **A repair never fails a connection test**, and its outcome is reported either
  way — a connection whose delivery is still broken must not read the same as one
  that was fixed.
- **A health check reports a degraded connection with `warning` rather than
  failing.** Failing would take a usable connection out of every run to describe a
  problem only the test can fix.
- **Admission failures are retried through new batch windows only while an event's
  attempt count is below three.** Once that limit is reached the event remains
  failed; deploying a schema or model fix does not replay it. Operators verify the
  corrected path first, then use an explicit, bounded replay rather than resetting
  every activity indiscriminately.
- **Connector-event processing uses the shared Queue's six deliveries.** The
  process pointer keeps one processing-owner UUID while Cloudflare's delivery
  count remains transport telemetry; it does not advance or saturate the
  compatibility-era 0–5 processing attempt. Each WorkspaceDO acquisition gets a
  fresh 15-minute lease, active duplicates retry at its exact expiry, and
  settlement is lease-fenced. A caught processing failure settles the event
  `failed` before requesting an individual retry; an exhausted delivery remains
  failed and enters the regional activities DLQ.
- **Everything unknown is marked not digestible** — a connector this region does
  not register, an event type a manifest has dropped, an activity older than the
  declaration. Nothing reads the mark today, but a future reader inherits it. None of those are somebody confirming a person wants this in their
  inbox, and being wrong costs one way only.
- **A stream can only ever withhold.** An activity is digestible when its event type
  says so *and* its stream agrees; a stream saying yes grants nothing on its own.
- **The model-facing provider JSON Schema stays in the portable structural
  subset** — object and array shapes, primitive types, required fields, enums,
  `additionalProperties: false`. No string formats, string-length bounds, numeric
  bounds, or array-length bounds: a nested limit such as `linkedUsers.maxItems` can
  make the constrained-decoding state space too large for otherwise supported Gemini
  structured-output endpoints, failing every admission request before inference.
  `AdmissionResultSchema` remains authoritative afterwards and is Rally's trust
  boundary.
- **A connector truncates its own `title`/`summary` before writing `activities`.**
  Connector caps are wider than the API contract's (GitHub's webhook titles cap at
  500 against the contract's 300), and while `WorkstreamService` and
  `SubstreamAgent` truncate defensively at every read and write site, a new
  connector should keep its own truncation at or under 300/2,000 characters so a
  work stream never depends solely on a downstream guard to stay openable.
- **Generic-webhook responses are specified**: `401` invalid signature, `400`
  malformed or schema-invalid, `422` disallowed event or non-member target, `409`
  identity or dedupe collision, `413` oversized, `202` new delivery, `200` a
  delivery already known. Senders retry network failures and `5xx` with exponential
  backoff using the same identity and exact body, and must not reuse an identity or
  dedupe key with changed content.
- **A GitHub delivery that fails in the consumer is not redelivered by GitHub.**
  The receiver already answered `202`, so the Queue's retries — backed off by
  attempt, or by a rate limit's Retry-After — are the only ones, and after them
  the message is in the dead-letter queue carrying the verified bytes or a
  `payloadRef`. A retry re-runs a pending receipt's effects; each is keyed to
  the delivery, and a lifecycle update older than the connection's watermark
  is skipped. The runbook's
  [GitHub delivery dead letters](runbook.md#github-delivery-dead-letters)
  covers replaying one.
- **X remains an on-demand read connector.** A connection does not yet select a
  monitored user, list, or stream rule from which a safe feed could be constructed.

## Testing

`apps/api/test-workers/resource-update-cost.test.ts` covers no-op discovery, each
independent change condition, mixed batches, and URL/metadata merge behavior.

| Suite | Covers |
| --- | --- |
| `apps/desktop/src/renderer/lib/connector-connection-card.test.ts`, `apps/desktop/src/renderer/lib/transcript.test.ts`, `apps/desktop/src/renderer/components/connector-mentions.test.tsx`, `apps/desktop/src/renderer/components/workstream-blocks.test.tsx` | Display compatibility, adjacent card deduplication, hidden-work visibility, known-provider fallback, guest visibility, and update/reload actions with live progress. |
| `apps/api/test/connector-credential-freshness.test.ts` | Both halves of the freshness contract. Its conformance half **enumerates the registry rather than a hand-written list**, so a connector added later is enrolled by existing: for every adapter that can refresh a credential, a provider that rejects the token must be answered with a refresh and a retry. An adapter whose health check does not present the connection's expiring credential — Notion introspects a token in the request body under the integration's own client credentials — declares that in the fixture table, so the exemption is a reviewable fact rather than a silent pass. |
| `apps/api/test/connector-credential-refresh.test.ts` | The lease, the serialized rotation, the adopt-don't-redeem path, and that a successful refresh heals the row. |
| `apps/api/test/connector-oauth-error.test.ts` | `isRevokedGrantError` and the three-answer classification. |
| `apps/api/test/connector-actor-identity.test.ts` | The three tiers, the monotonic write, and that only `verified_email` is recorded. |
| `apps/api/test/connector-catalog-discovery.test.ts` | `searchAliases`, the catalog wording, and the load sentence. |
| `apps/api/test/connector-tool-selection.test.ts` | Capability intersection, capability-gated Gmail new/reply examples, attached-transcript-first guidance and valid Docs examples across Calendar-only, files-only, and combined grants, and the `connectorCapabilityRefused` shape. |
| `packages/connectors/src/index.test.ts`, `apps/api/test/tool-schema-sanitization.test.ts` | Gmail new/reply MIME and request bodies, metadata/read-capability failures before writes, and equivalent acceptance of valid and invalid arguments in the authored/provider schema and executor. Gmail HTTP is the capability double; no email is sent by these tests. |
| `packages/connectors/src/index.test.ts` | Calendar change, completion, and recurring-master attachments survive provider field masks and lead directly to a Docs read; unreadable-master fallback never attributes an occurrence attachment to the series. Google HTTP is doubled because the provider cannot run locally. |
| `apps/api/test/connector-poll-reliability.test.ts` | `normalizeHighWatermark` on both load and commit, the bounded retries, and backlog scheduling. |
| `apps/api/test/connector-event-authority.test.ts` | WorkspaceDO event admission/replay and frozen pre-cutover activity rows ignored once object authority is open. |
| `apps/api/test-workers/durable-object-runtime.test.ts` | Real-workerd WorkspaceDO schema, Queue/provider replay dedupe, Queue claim fencing and recovery, terminal settlement, and the alarm aging processed events out at 90 days while keeping every event still in flight. |
| `apps/api/test-workers/workspace-connections.test.ts` | The typed OAuth attempt lifecycle across the real RPC boundary — settlement witnesses, replay convergence, the member-scoped lazy expiry, the succeeded-over-expiry override — plus webhook receipt claims, their same-transaction expired-receipt sweep, and the generic port's refusal of `webhook_receipts`. |
| `apps/api/test/connector-oauth-handoff.test.ts`, `apps/api/test/connector-outcome-telemetry.test.ts`, `apps/api/test/granola-connector.test.ts` | The connection service over a real `WorkspaceDO` via `test/helpers/workspace-object-rpcs.ts` — attempt expiry/reconciliation through the service, single-emission outcome telemetry, and that no plaintext credential crosses the recorded RPC boundary during webhook ingestion. |
| `apps/api/test/connection-tool-count.test.ts` | `GET /connections` tool counts over the migrated regional database and a real `WorkspaceDO` schema, through the service and through the route: a fixed surface counted from grants with its generated page tools and no provider call, `connector_unavailable` for a connector the region does not register, a discovered count stored by creation, a policy save, the custom-MCP tools read and the released per-row endpoint, `null` (never zero) with its reason and a named log when discovery has not succeeded, the list's failed discovery attempted once across two lists, two concurrent lists starting one discovery, a failed discovery (a 5xx, a name collision) clearing the stored count and publishing it, and a discovery that finishes after a policy change or a reconnect dropped by the write fence. It also pins that the list reads owner names and the Slack identity links for `userDelivery` concurrently rather than one after the other, and lists both. Background work is awaited with `drainWaitUntil` from the Node `cloudflare:workers` stand-in rather than slept on. `apps/api/test/tool-pagination.test.ts` pins that `paginatedToolNames` and the expansion name the same tools. |
| `apps/api/test-workers/github-delivery-queue.test.ts` | That an inline GitHub delivery survives a real Queue: the body the consumer receives passes `GitHubDeliveryQueueMessageSchema` and routes the exact signed bytes. |
| `apps/api/test/github-routing.test.ts` | The GitHub receiver and its Queue consumer: one signature check across both, no D1 read before the reply, staging and removing a large body (including when the enqueue fails), the retry backoff and a rate limit's Retry-After, and `unrouted` acknowledged. Its regional-data-plane block runs the consumer into a real `ProviderWebhookService` over the migrated regional database and a real `WorkspaceDO` — a delivery whose first attempt failed after its receipt committed finishes on redelivery, a retried older lifecycle event does not overwrite a newer one — and once across the real `GitHubRegionalBridge`, with the argument structured-cloned as a service binding would. Nothing in it verifies a signature downstream of the receiver, because nothing in production does. |
| `packages/connectors/src/digestibility-doc.test.ts` | That every declared activity type has a row in [`connector-digestibility.md`](connector-digestibility.md). |
| `packages/connectors/src/agent-plugin.test.ts` | That each descriptor's provider type and tool order match its manifest. |
| `packages/connectors/src/observability.test.ts` | The shared adapter and provider-request log layers, level selection, identifier retention, content exclusion, and fail-open observer contract. |
| `apps/api/test-workers/message-to-output-pipeline.test.ts`, `apps/api/test/slack-workspace-assignment.test.ts` | A completed composite-id transcript turn is reloaded before terminal side effects settle; Slack never opens or appends a response stream, posts only the complete saved turn, and emits no result message when no saved turn exists. |

Run one with
`pnpm --filter @rally/api exec vitest run test/connector-credential-freshness.test.ts`
— the path is package-relative.

The trap worth stating: several of these suites enumerate the registry on purpose,
so a new connector is enrolled without anyone remembering to add it. Do not narrow
one to a fixture list to make a new adapter pass — declare the exemption in the
fixture table instead, where it is reviewable.

Guest-triggered conversational runs also recheck exact conversation admission at
run-authority boundaries. The connector executor uses the invocation
authorization decision through credential preparation and adapter execution;
see [Agent harness](agent-harness.md). Remaining an
active workspace guest is insufficient after the addressed share is revoked.
Workspace-principal automation runs retain their separate lifecycle authority.

## Changelog

### 2026-10-19 — Connection state and reauthorization remain separate

**What changed:** Cards now keep a Reconnect action beside current connection
state, using the existing connection row even when it remains healthy. A cached
success only bridges loading; it no longer hides later revocation. Pending OAuth
is cleared by its outcome rather than by the old healthy grant, so reauthorizing
a connected account cannot immediately enable another attempt. Account selection
is explicit when several connections match, and OAuth topic updates reconcile
completion without requiring another focus event.

**Why:** A card could say Connected while the agent asked the person to reconnect,
leaving no action to take. The action must target the intended account and stop
waiting when its authorization completes.

### 2026-10-19 — Unknown connector requests offer a client update

**What changed:** A completed connection-card request for a newer connector now
renders a generic update card, including when agent work is hidden. Consecutive
requests for the same connector and scope collapse to one card. Desktop uses the
existing updater with live progress, and browser reloads the client. Guests see
no update prompt because they cannot connect accounts.

**Why:** A 1.627.0 client displayed Apollo's successful connection-card request
as a raw tool row because its bundled catalog predated Apollo. The agent then
claimed a card was visible with no action the person could take.

**Rejected:** Widening the execution schema to accept unknown providers, or
depending on a raw tool row to explain the mismatch. Only display recognition is
forward-compatible; authorization still requires the trusted local catalog.
Unknown IDs or scopes require structured input/output rather than a second parser for
summary-only recovery; known summary recovery remains shared with the writer.

**Respect:** Keep the card tool's wire identity and envelope stable. This helps
clients containing the fallback; it cannot retrofit already-installed clients.
Release a desktop build supporting a connector before enabling it on the Worker,
as with the wire-name sequencing constraint documented on
`isConnectorConnectionCardWireName`, so an available update can resolve the card.

### 2026-10-19 — Google polling preserves people, diagnostics, and attached documents

**What changed:** Polling admits up to 10,000 deduplicated people, retains safe
field-specific terminal errors, and exposes Calendar attachment references.
Terminal logs retain their stable `connector_poll_failed` or
`connector_poll_timeout` event name; `error_code` carries the specific cause.
Legacy Google payloads converge on their enriched canonical event without
reprocessing. Oversized ingress commits directly through canonical admission;
large matched deliveries reload canonical context. The meeting-notes skill owns
lookup guidance. [`agent-attachments.md`](agent-attachments.md) owns Gmail PDF
authorization, [`workstream-durable-object.md`](workstream-durable-object.md)
owns roster storage, and [`suggested-work.md`](suggested-work.md) owns admission.

**Why:** Real recipient lists exceeded the old schema and the displayed error
lost the cause. Calendar polling omitted attached transcript Docs that event
reads already exposed, leaving follow-up workflows without their best source.

**Considered and rejected:** Raising only a schema cap moves failure to Queue
or SQLite limits. Truncation loses recipients. R2 transport copies would outlive
canonical event retention and require another cleanup protocol; canonical
admission and context reads reuse the existing authority instead.

**Consequences:** The 10,000-person limit applies after deduplication; larger
lists fail explicitly. Queue messages preserve full event context through the
canonical owner, and rollout enrichment preserves identity and processing state.
Read access to an attached Doc remains the connected account's responsibility.


### 2026-10-19: Polling failure is not a reconnect verdict

**What changed:** Model and UI use one authorization-status mapping. Historical card success bridges loading only; live revocation or disable wins over the latch. Generic errors remain usable. Cursor-fenced poll success recovers only polling errors; poll failure preserves disabled connections and authorization diagnoses. Provider refusals across resource hydration, notifications, agent calls, and webhook access probes can promote an operational error to a reconnect verdict; GitHub suspension records authorization unavailability directly.

**Why:** Gmail successfully fetched six activities forty-two seconds before the state tool demanded a reconnect. A retained polling error was mapped to reconnect by the model tool and Connected by the UI, repeatedly blocking usable accounts across connectors.

**Rejected:** Clearing every error after refresh or polling would erase missing-scope diagnoses that those operations cannot disprove. A Google-only fix would leave the shared failure in every other adapter.

**Consequences:** Background health and authorization availability are distinct. No migration or manual reconnect is needed for stale polling errors; the state tool permits use immediately and the next successful committed poll clears its own diagnosis.

### 2026-10-19: Empty attendee changes are omitted

**What changed:** Calendar event updates normalize empty add, remove, and replacement attendee arrays to omitted values before validation and execution.

The private pre-pagination receipt recipe retains the original attendee-field descriptions, so the new model-facing guidance does not change historical tool-surface hashes.

**Why:** A production guest invitation repeatedly failed because the agent supplied an empty replacement array alongside an addition. Presence-based exclusivity made the unused field block a valid change.

**Rejected:** Merely relaxing the conflict check would leave an empty replacement able to clear the guest list during execution. Normalizing once in the shared argument schema gives preflight validation and execution the same meaning.

**Consequences:** Nonempty replacement and relative changes remain exclusive. Clearing every guest requires explicit removals, with at most 50 addresses per call; if the guest list is incomplete, clearing guests requires Google Calendar. An update with only empty attendee arrays is refused as having no change.

### 2026-10-19: Availability queries reach calendars outside the account's list

**What changed:** Google gained `calendar.query_availability`, a read-only free/busy query by calendar ID or verified email, using the existing calendar read grant. Calendar-list discovery now describes list membership accurately. Results distinguish free, busy, and unknown per calendar, and every per-calendar error carries a fixed explanation and next step alongside its diagnostic code.

**Why:** Fixed explanations and recovery steps were explicitly requested so models can interpret every per-calendar error without inferring remedies from provider codes; no model evaluation has established a need for them. A scheduling response treated an account's calendar list as all calendars it could access and asked attendees to confirm manually. Shared free/busy or public calendars may be accessible by known ID without appearing in that list. Listing events cannot replace a free/busy query when only availability is shared.

**Considered and rejected:** Requiring attendees to connect their own accounts or subscribe to each other's calendars, which adds setup Google does not require for already accessible availability. Treating missing/error results as an empty busy list, which would report unavailable data as free time.

**Consequences:** Google remains the access authority. A calendar error never implies availability, and unknown reason text or provider messages cannot enter the result. The tool does not expand groups or read event details; callers supply known calendar identities directly.

### 2026-10-15: A connection that cannot reach a resource hands the call to one that can

**What changed:** Adapters gain an optional `probeResourceAccess(connection, reference, signal)`, which answers how far one connection reaches a resource named by a URL or provider id (`edit`, `read`, `none`, `unrecognized`) without writing. Google implements it from Drive metadata and reads Docs, Sheets and Drive links. The new core tool `check_resource_access` asks every connection of one connector in the run, in parallel, using only the capabilities the run froze, and names the first plugin that can edit and the first that can read. `executeAuthorizedConnectorTool` now catches a refusal built with `connectorResourceAccessRefused` and runs the same call on the run's other connections of that connector, in run order (attached, the person's own, the Organization's), returning the first success with `servedThrough` on its output. When none serves it, the refusal reported is the first that carries a grant request, with `resourceAuthorizationConnectionId` naming the connection it belongs to, so the Allow editing card asks about the account that can edit rather than the one the model picked. The person's own connections are tried before the Organization's, and once a grant request is in hand the Organization's are not tried at all: one click to authorize the person's account is preferred over an edit recorded in the file's history under the Organization. Google marks its pre-write metadata refusal and its `403`/`404` refusals on Docs, Sheets and Drive (`get_metadata`, `download`, `export`) reads; the marked read keeps its code, message and payload.

**Why:** A person's own Google account and the Organization's are different accounts that see different files, and the model picks one plugin per call. On 2026-10-14 the Thread `Creator content intake` created a Sheet through one account, then tried every write through another, which could not reach it. Each failure was reported to the member as a permission they had to grant.

**Considered and rejected:** Retrying any failed call on another connection, which could land a write twice after an ambiguous failure. Probing every connection before every call, which adds a provider round trip to the common case where the chosen connection works. A per-connection `check_access` tool in each connector plugin, which would make the model call one per account to answer one question.

**Consequences:** The guard against a double write is what the retry keys on, not a timeout or a count: a new adapter that marks a refusal raised after its mutation was sent breaks that guarantee. Fallback skips provider-authored (MCP) tools, whose surface can differ between two accounts. The receipt keeps the connection the model chose; Canva's cleanup reads `connection_id` from receipts, which is why the retry is limited to adapters that opt in.

### 2026-10-10: Connectors read provider files through the attachment converter

**What changed:** `packages/connectors/src/documents.ts` adds `ConnectorDocumentReader` and `readConnectorDocument`, and `createConnectorRegistry` takes a `documents` reader and hands it to adapters. The API's reader wraps the attachment converter. Google's `drive.download` and `drive_file` hydration now return text for Word, Excel, PowerPoint and PDF files (scanned ones through OCR) stored in Drive, and Slack's `read_file` does the same for shared files, where it used to answer `binary_file`. `drive.search`'s `fileType` gained `word`, `excel`, and `powerpoint`, and the family check knows them, so `sheets.read_spreadsheet` on an `.xlsx` id fails as `wrong_id_family` naming `drive.download` rather than a bare `provider_error` 400. The `drive_file` hydration branch now goes through `readDriveTextContent`, like the Doc and Sheet branches.

**Why:** On 2026-10-02 an investor's portfolio folder held only Office files. The agent found `Investment Memo.docx` and `Cap Table.xlsx` but could read neither: download said "Binary and unsupported Drive content", and the Sheets reader returned `Google API failed (400)`. The same files uploaded as attachments already read correctly. Slack threads and Linear comments carry the same kinds of files, so the fix is a contract every adapter shares, not a Drive feature.

**Considered and rejected:** A parser inside the connectors package: a second converter to keep in step ([`agent-attachments.md`](agent-attachments.md#changelog) has why it was also impractical). A reader passed per call on `ConnectorToolContext`, which `hydrateResource` does not receive. Refusing text over the budget instead of cutting it, which would turn away the large workbooks this is for.

**Consequences:** An adapter that reads a provider file takes `documents` and calls `readConnectorDocument`; it never parses a format. The source ceiling is the attachment converter's (`ATTACHMENT_MAX_SOURCE_BYTES`), not a per-connector number. `prePaginationTool` in `integrations.ts` restores `drive.search`'s old `fileType` enum and description, so receipts recorded before pagination still match their hash. A later change to a pre-pagination tool's schema needs an entry there too, which `connector-tool-selection.test.ts` enforces.

Shipped in #1185.

### 2026-09-28: The GitHub delivery message is sent as `v8`

**What changed:** The receiver now sends `github_webhook_delivery_v1` with `contentType: "v8"`. A new workerd test, `test-workers/github-delivery-queue.test.ts`, sends a delivery through a real Queue and parses what the consumer receives.

**Why:** The Queue's default content type is `json`. JSON turns the inline body's `ArrayBuffer` into `{}`, so from the previous entry's deploy the consumer rejected every inline delivery as `github_delivery_message_invalid` (`body.bytes`, `custom`). That was 324 in the first 45 minutes. The Node suite's queue double hands the consumer the sender's own object, so it could not see this.

**Rejected:** Carrying the body as a JSON string. GitHub sends UTF-8, so it would work, but escaping the nested JSON's quotes grows the message by 10 to 20%. That pushes an inline body near the 120,000-byte threshold past the Queue's 128 KB message limit. The threshold would have to drop, and the exact-byte round trip would then depend on the body being valid UTF-8.

**What a future change must respect:** A `v8` message can only be read by a Worker consumer, and the dashboard shows it as base64. A pull consumer on `ACTIVITY_QUEUE` would need a different encoding for this message. Any other Queue message that carries binary data needs `v8` too, and a test that runs it through a real Queue.

### 2026-09-28: GitHub deliveries are answered first and routed from the Queue

**What changed:** The Global GitHub receiver now verifies the signature, applies the discard checks, enqueues the delivery on the Global `ACTIVITY_QUEUE` and answers `202`. Route lookup, regional connection matching, GitHub API calls and every regional write moved to the consumer. The signature is checked once, over the exact bytes at the receiver; the receiver's second check (`verifyGitHubWebhook` after the exact-byte HMAC) and the region's third are gone, and the regional bridge's `ingestGitHub(rawBody, headers)` became `ingestVerifiedGitHub`, which takes no signature. The three per-delivery D1 statements against `github_ingress_pending_deliveries` — the expired-row sweep, the replay read and the `dispatched_at` update — and the replay on setup were removed. A delivery for an installation with no route is now acknowledged and logged rather than answered `503`. Because the Queue's retries are now the only ones a delivery gets, they back off and honour a rate limit's Retry-After, a pending receipt re-runs its keyed effects instead of reading the dropped D1 `activities` table, and migration 116 adds `connector_ingress_routes.lifecycle_at` so a retried older lifecycle event cannot overwrite a newer one.

**Why:** Measured in production on 2026-09-27, a GitHub delivery took a median of 3 s and a p95 of 7 s to answer, against GitHub's 10 s timeout, and was the most CPU-hungry route: every regional write and the personal-connection GitHub calls ran while GitHub waited. The pending table was never written outside a test double — its replay machinery had no producer — so its reads were pure latency. The repeated HMACs were three passes over bodies of up to 25 MB. A `503` for an unrouted installation was never retried by anything: GitHub does not redeliver on its own, and nothing wrote the pending row the replay would have read.

**Rejected:** Keeping the route lookup at the edge and enqueueing to each region's own queue would cost one D1 read before the reply and was not needed while Global is the only deployment. Retrying an unrouted delivery into the dead-letter queue would put every new installation's `installation.created` there and bury real failures. Always staging the body in R2 would add a write before every reply; it is paid only when the body exceeds a Queue message. Ordering lifecycle updates by the WorkspaceDO's own `updated_at` would drop a real suspension whenever a credential refresh or poll touched the row after the delivery arrived; a column on the connection needed a WorkspaceDO schema migration, so the watermark sits on the regional route row, at the cost of the claim and the write being in two stores. The pending table is not dropped here: the Worker before this one reads it on every delivery, so the drop must deploy Worker-first, and the deploy allows only a Worker-first migration pending alone — it follows in its own change.

**What a future change must respect:** Nothing downstream of the receiver may verify a GitHub signature or be reachable with bytes that did not pass it — the Queue message and the bridge are the only ways in, and neither carries a signature. The delivery id stays the idempotency key, so every regional side effect must be safe to re-run for a pending receipt — keyed to the delivery, or ordered by the lifecycle watermark. While Global is the only deployment the Queue and staged bodies are in-region; adding a deployment puts that deployment's delivery bytes in Global's queue until the consumer routes them, which [`regionalization.md`](regionalization.md) has to allow before that ships.

### 2026-09-27 — Input bound to a Sidekick run follows the run, not the sender

`ConnectorToolResult` gained `externalConversation`, a bound event counts as
claimed, and the per-message authority invariant gained its one exception,
stated above under Invariants. The why, the alternatives and the consequences
are recorded in [`external-conversation-bindings.md`](external-conversation-bindings.md#changelog).

Shipped in #1006. Design: `docs/PRDs/2026-09-23_external-conversation-bindings/`.

### 2026-09-27: Ingest drops CI noise and events that repeat themselves

**What changed:** GitHub `check_run` deliveries, and every `workflow_run` action but `completed`, are discarded at ingress and no longer declared. WorkspaceDO ingest drops a new event whose content matches its resource's latest event (migration 80). A repeat of a pending event wakes nothing, one of a failed event is stored with a fresh retry budget, and a repeat dropped before an older, different event arrives is restored. Drive metadata now carries `modifiedTime` and `md5Checksum`, and the dev synthetic route a per-delivery `rawContentHash`, so their genuine repeats still count.

**Why:** A production read on 2026-09-27 found Juno Labs holding 255,000 connector events, 32,000 stuck `pending` and 2,400 `failed` with "Durable Object is overloaded". 136,000 were CI: about fifteen check runs a commit, each reported twice, plus three events per workflow run. 77,000 were `calendar.event_changed`, about 14 per meeting: Google re-stamped an ended recurring series twice a day for each attendee with nothing changed, and the series identity is its `updated` stamp, so each touch was a new event. Forward Search had 45,000 of the same. No Sidekick in any workspace triggered on a CI or Calendar change event, so nothing depended on the noise.

**Rejected:** Keying Calendar identity on content inside the adapter would fix one connector; the ingest filter covers any adapter that re-stamps unchanged content. Comparing against all history instead of the latest event would drop a reversal, which is news. Ordering the comparison by `occurredAt` alone was not enough: by the time an older event arrives, the newer repeat it makes news has already been dropped, so the drop keeps its identity and is restored instead. A column and index on `workspace_connector_events` would have built an index over 255,000 rows in the migration, where the new table starts empty.

**What a future change must respect:** An adapter's content must change when the thing it reports changes; a change marker carried only in `occurredAt` or the identity is dropped as a repeat. A dropped repeat must never wake or retry the earlier event's processing. Arrival order is not event order: anything that compares against the latest content has to go by `occurredAt`, and a drop has to stay recoverable until an older event can no longer arrive. Keeping a CI type again means removing it from `isDiscardedGitHubDelivery` and declaring it in the manifest together.

### 2026-09-26 — Tool counts ride the connection list

**What changed:** `GET /connections` returns each connection's tool count. A
fixed tool surface is counted in the handler from the catalog and grants; a
live-discovered surface reports `discovered_tool_count`, a WorkspaceDO column
written whenever a discovery already runs (authorization, Test, the custom-MCP
tools read and policy save, the released per-row endpoint) and once, in the
background, for a row the list finds never discovered — recorded in
`tool_count_backfill_attempted_at` before it runs, so it is spent once per
connection even when it fails. A failed discovery, other than an authorization
refusal, clears the stored count. A fixed surface is counted with the page
tools activation generates, from `paginatedToolNames`, the rule the expansion
itself now builds from. A row with no count carries `toolCountMissing`, and the
desktop's dash says which reason it is. The desktop dropped its
per-row `connection-tool-count` queries and reads the list.

**Why:** Opening Connections cost the list plus one `tool-count` request per
row, and the per-row requests could not start until the list answered — a
waterfall of 1 + N requests, some of which called a third-party MCP server
live on every open and on every window focus. No socket topic covered those
queries, so the count was either refetched on focus or stale anyway. A count
is a property of the connection; carrying it on the row makes the tab one
request and moves provider calls to the moments something could have changed
the answer.

**Considered and rejected:** Keeping the per-row requests but starting them in
parallel with the list (still N provider calls per open). Caching the live
count with a TTL or a periodic refresh (a staleness limit whose number is the
team's, not this change's, and a timer spending provider calls nobody is
looking at). Retrying the list's background discovery until it succeeds (for a
broken connection that is a live provider call behind every list, the same
per-open traffic this change removes, only hidden). Deriving the custom-MCP count separately from the activation path
(the 2026-09-11 rule stands: the count is the agent tool surface, so discovery
reuses `validateDynamicConnectorTools`). Keeping the previous count when a
discovery fails and relying on the status badge (only an authorization refusal
moves the status; a timeout, a 5xx or a refused catalog left an old number
beside a healthy badge while `load_plugin` offered none of those tools).
Counting authored definitions (the per-row endpoint did, and it undercounted
every paginated tool the agent is actually offered). A second copy of the
pagination rule in the count (the two would drift the first time the expansion
changed). Logging an unregistered connector on every list (static configuration
repeated per open; the row now says it).

**Consequences:** A discovered count is "as of the last successful discovery",
not live: a server that changes its catalog with no Rally-side event shows the
old number until the next Test, reconnect or tools-pane read. A discovery that
fails for any reason but an authorization refusal clears the count, so the
"never stale" half of the earlier rule holds, now as a dash with a reason
rather than "Unavailable". Writers must keep the grant/config/account fence and
the `IS NOT` guard, on a clear as on a count, or late discoveries overwrite
newer policy and every no-op refresh republishes the list. A change to how
activation expands a tool changes `paginatedToolNames`, never a count beside
it. A connection whose one list-triggered discovery failed shows a dash
(`not_counted`) until an authorization, a passing Test, or a tools-pane read
counts it; the marker is not re-armed by anything else, deliberately. The
per-row endpoint must stay until released desktops no longer call it.

### 2026-09-22 — Resource grants became a connector primitive

**What changed:** A failed connector write may now carry one participant-safe
resource-authorization recovery descriptor. The desktop renders it as a reusable
card, the connector adapter owns the provider grant, and completion writes a
normal user message that starts the continuation. Google Drive's one-file Picker
is the first implementation.

**Why:** A Drive identity could be an editor while Rally's OAuth client still
lacked `drive.file` authority for that exact file. The old failure could only tell
the model to ask for manual sharing, even though Google supplies a targeted grant
flow. Making the recovery Google-specific would repeat that limitation for the
next provider with resource-scoped authorization.

**Considered and rejected:** Replaying the failed tool directly from the OAuth
callback. That creates a second execution path with hidden model state and write
retry semantics. The visible user-authored authorization message lets the normal
conversation loop resume from its durable transcript.

**Consequences:** The callback's sealed state establishes a short-lived
`resource_authorization` principal for ordinary message admission; the room
re-checks current membership because a browser callback has no login session.
The start endpoint reads the failed-tool recovery from the room rather than
trusting a client echo, and the room reserves continuation-message IDs for that
principal. Desktop attempt status is per card so concurrent grants do not occupy
the ordinary connection-setup slot.
Only editable resources whose adapter can prove a missing app
grant receive the CTA. Read-only resources and disabled connections keep their
existing failures. Future providers implement the adapter hook rather than adding
desktop or transcript special cases.

### 2026-09-19 — Personal Canva and explicit design observation

The Canva adapter discovers the live MCP catalog and uses backend-held
OAuth credentials. Only explicit named-design watches poll; connecting is not
consent to account-wide monitoring. Design revisions and new discussion IDs are
newsworthy and digestible under ordinary Rally permissions. Complete comment and reply scans
replace a sorted top-ID watermark because a reply does not advance its parent's
timestamp. Canva is available to every member without a feature flag, with
desktop loopback login until server callback approval. [Canva integration](canva-integration.md) owns the lifecycle details.

### 2026-09-19 — Every connector card is one sentence, and nothing else

**What changed:** The Connections grid renders one paragraph per card: the
sentence that says what the connector gives you. The three conditional
paragraphs under the Ashby and Fireflies cards are gone — the "Personal account
/ Workspace events" status line, the Ashby MCP opt-in sentence, and the Ashby
setup guide link. Granola, Linear, Notion, Custom MCP, the inbound webhook, X,
Slack and both Google cards had descriptions that ran to two sentences, two
clauses, or a different grammatical shape than their neighbours; each is now a
single noun phrase in the shape GitHub's already had. Ashby's opt-in
prerequisite moved to the personal **Connect for me** tooltip and to the Ashby
section above.

**Why:** The 2026-09-18 entry below shortened the Ashby and Fireflies
descriptions and the rows still came out uneven, because a card's height is the
height of its content: those two cards each carried a second paragraph, and one
of them a third, and the grid stretches a row to its tallest card. Fewer words
in one paragraph could not offset a whole extra paragraph. The status line also
duplicated what the installed-connections list above the grid already shows,
and the setup guide link sent a person out of the app before they had tried the
button underneath it.

**Considered and rejected:** Blaming `flex: 1` on `.provider-card > p` and
scoping it to the first paragraph. This entry said that in its first draft and
it is wrong — `flex` distributes a card's *slack* space among its paragraphs
and does not set the card's height. Measured in a real window with a deep-link
guidance paragraph rendered: the card is 286px with that paragraph at `flex: 1`
and 286px at `flex: none`, and 208px — the row's height — with it hidden. Only
removing content shortens a card. Also rejected: giving Ashby's personal scope
a setup modal of its own, the way the workspace scope has one. The prerequisite
is one sentence and the button it qualifies already composes tooltip text, so a
modal would be a screen built to hold a sentence.

**Consequences:** A card is a mark, a name, a status word, one sentence and its
buttons. One paragraph may still join them: the `settings-search-guidance`
`<p>` a settings deep-link renders into the targeted card, which does make that
row taller for as long as the target is selected. That is a deliberate,
transient status message, and no `flex` rule can make it free — a paragraph
costs its own height. Anything a provider needs to explain — an opt-in, an
eligibility rule, a setup walkthrough — belongs in that provider's connect
tooltip, its setup modal, or this document, not in the grid; a prerequisite
that lives only in the card is one deletion away from existing nowhere, which
is what nearly happened to Ashby's. Adding a paragraph back to a card re-breaks
the row.


### 2026-09-19 — The GitHub single reads are declared too

**What changed:** `repository.get`, `issues.get`, `pull_requests.get`,
`actions.get_workflow_run` and the five write tools that echo what they wrote
project onto declared records, composed as the matching list row plus the
content and state the read was for.

**Why:** Declaring the list rows left the reads as pass-through on the reasoning
that one deliberate object per call was affordable. It is, for one call. A run
lists thirty pull requests and opens six of them, and each `pull_requests.get`
carried the `head.repo` and `base.repo` the list had just dropped, handing most
of the saving back within the same run.

**Considered and rejected:** Declaring each read independently of its list row,
which lets the two drift and a field earn its place on one and lose it on the
other. Leaving the write echoes alone, which would have made a created issue and
the same issue read back a call later two different shapes.

**What a future change has to respect:** The records compose from the list rows,
so a field added to a list row appears on its read as well, and what a read adds
over its row is what a caller opened it to see.

PR follow-up to [#842](https://github.com/juno-ai-labs/avalon/pull/842).

### 2026-09-19 — GitHub list rows are declared, not passed through

**What changed:** Every GitHub list tool now returns a declared set of fields
rather than the object GitHub sent, via `projectFields` in
`packages/connectors/src/provider-utils.ts`. The envelope, the paging, and the
`appliedFilters` echo are unchanged. `truncateTextWithMarker` replaces the silent
string cuts `boundGitHubValue` was making by discarding `truncateText`'s
`truncated` flag.

**Why:** A substream measurement found five GitHub list calls holding 5.1 MB of
the 5.2 MB of model-facing payload it stored, at 24.5 KB per pull request and
21.3 KB per workflow run. Nothing was unbounded: `perPage`, the character clamp,
the array and depth clamps were all inside their limits, because every one of
them bounds a row's length and the problem was its width.

**Considered and rejected:** A smaller `perPage`, which leaves the bytes per
useful fact unchanged and buys the same waste in more round trips. A byte
ceiling on the result, which truncates the useful tail of a page to keep its
useless head, and whose number is the team's rather than an implementer's per
[`adding-security-defensive-and-other-limits.md`](adding-security-defensive-and-other-limits.md).
Dropping `checks.list_for_ref`'s `output.text` on width grounds, which review
caught: it is the only failure diagnostic this plugin can read.

**What a future change has to respect:** A row that drops an identifier another
tool documents as copied from it is a broken tool, not a smaller one, and a row
that drops a field with no other read path takes a capability with it. The
adapter's repository access policy resolves GitHub's numeric repository id
against the raw response before projection, so removing `id` from the
model-facing row does not touch immutable-id authorization.

PR [#842](https://github.com/juno-ai-labs/avalon/pull/842).

### 2026-09-18 — The connector card is sized to its row, and a pasted key is told what is wrong with it

**What changed:** The Ashby and Fireflies cards keep only the sentence that says
what the connector gives you — "Hiring, candidates, interviews, applicant
tracking, and pipelines." and "Meeting transcripts, summaries, and the action
items they name." Where an API key is pasted, the link now opens the provider
page that issues the key, the field shows the documented shape as its
placeholder, and a paste that cannot be that provider's key says so under the
field. Issuing page and documented format are declared once per provider in
`packages/contracts/src/connector-api-keys.ts`, which the API's request schema,
the Granola adapter's own check and the desktop field all now read.

**Why:** Both card descriptions had been written for engineers — "its beta MCP
server", "personal recruiting queries", "independently authorized workspace
application events" — and were three to four lines where every other card is
two. The grid stretches a row to its tallest card, so those two rows padded
their neighbours with empty space, and the words that were left told a person
nothing they could act on. Separately, the Granola key pattern existed three
times in the tree, and the desktop copy of it only disabled the button: someone
pasting a personal token instead of a workspace key saw a dead Connect and no
reason for it.

**Considered and rejected:** Inventing a prefix for Ashby and Fireflies so every
provider could be checked the same way. Neither documents one, and a guessed
pattern rejects a valid key at the one step this change exists to smooth — so
those entries declare no format and the field only requires a non-empty paste.
Also rejected: a second regex in the renderer, which is how the three Granola
copies happened.

**Consequences:** A connector added with an API key declares its issuing page
and, only if the provider documents one, its format — and gets the link, the
placeholder and the mismatch message from that. The card description is the
plain sentence naming what the connector gives you; the scope story belongs in
the setup modal, which has room for it.


### 2026-09-17 — A Granola event tells the run which note it is about

**What changed:** Every Granola activity carries `noteId` in its metadata, and
the trigger vocabulary lists it as a filter field. The derived transcript from
a shared note carries it too.

**Why:** The first run the shared-note fix produced completed in one turn with
no tool calls: "The event payload does not include a Granola note ID." A run
reads the event's title, type, time, and metadata; the note id was in the
subject and resource fields, which never reach it. The model refused to guess,
correctly, and no recap was sent — for a note generated in a shared space just
as for one shared afterwards.

**Considered and rejected:** Handing every event's subject to the run. What a
run may read is a decision per connector, and one field this connector's
instructions name is enough.

**Consequences:** A Sidekick on Transcript added can call `get_note` with the
id the event names. No re-activation needed.

### 2026-09-17 — A note shared into the workspace after it was generated is a transcript added

**What changed:** A Granola `note.access_granted` delivery on a workspace
connection now asks Granola for the note before any activity row exists. When
the note's summary exists, the ingress stores a `note.generated` activity beside
the share — same delivery, same payload, its own dedupe key, `derivedFrom`
naming the share — and a Sidekick whose trigger is "Transcript added" runs for
it. That derived event and the `note.generated` Granola sends itself both carry
an occurrence key naming the note, and a Sidekick admits an external event under
that key when one is present, so a note reported twice runs once. The key is a
field of the normalized activity that adapter code sets, namespaced by provider;
the workspace store drops a same-named key from provider metadata at ingest and
lifts only the activity's own onto the delivery, in a key space
(`occurrence:<key>`) an event id's (`external:<id>`) cannot reach. A transcript
reported on a read Granola did not answer carries no key, so the
`note.generated` Granola may still send is not turned into a replay. The
trigger descriptions say what each Granola event now means; `note.access_granted`
stays available, labelled "Note shared", for a person who asks for every share.
The webhook source interface gains an optional `derive` that answers with the
activities it decided and the outcome by name, honoured by every ingress that
persists through the workspace object, and the observability wrapper carries
it through: that wrapper is the only copy of a source the host ever sees, and
it rebuilt the source by naming `verify` and `normalize` — the first `derive`
existed in the adapter and nowhere the ingress could reach it.

**Why:** Granola sends `note.generated` only while the endpoint can read the
note. Notes start in a person's own space and are moved into a shared folder
after the meeting — a note cannot be started inside a team space — so the
workspace endpoint received `note.access_granted` for every one of them, and a
Sidekick built on "Transcript added" never ran. Nothing was broken and nothing
said so: the connection was healthy, the Sidekick was active, the event arrived,
matched no rule, and was dropped with a delivery count of zero in a log.

**Considered and rejected:** Subscribing "Transcript added" Sidekicks to both
events without asking Granola about the note. A note shared before its summary
exists then runs at the share, on a note with nothing to read, and the real
`note.generated` that follows is the same occurrence and admits as a replay —
one bad run in place of one good one. Also rejected: putting
`note.access_granted` into the transcript event family and relying on the
drafting model to pick the family. Sidekicks already active keep their single
event until re-drafted, and a person who says "when a note is generated" gets
exactly that and nothing for the notes they share. Also rejected: answering a
share Granola will not tell us about with nothing, which is the failure this
entry exists to end — and, on review, keying that unverified answer on the note,
which would have re-created the rejected first alternative through the error
path. Also rejected: reading the key out of the event's metadata, where the
generic webhook copies whatever a caller posted; a caller must not pick the key
a Sidekick dedupes on.

**Consequences:** Every `note.access_granted` on a workspace connection costs
one Granola read inside the delivery. `WEBHOOK_DERIVE_TIMEOUT_MS` is an open
limit handed to the team: Granola allows fifteen seconds for the whole delivery
and retries with backoff for four days, verification and the payload write are
spent before the read and the receipt claim, both persists and the queue sends
after it, and the trip stores the share, reports the transcript unverified, and
logs `timeout`. The activity log shows "Granola note generated" beside the
share. Sidekicks already active on "Transcript added" need no change; the two
in BetaBeta-demo that never fired will fire on the next note shared into the
workspace. Which note shape Granola returns is transcribed from its OpenAPI
document beside the parser, and a note with neither summary field is reported
and logged as `unexpected_shape` rather than passed off as a summary not yet
written.

PR [#807](https://github.com/juno-ai-labs/avalon/pull/807).

### 2026-09-17 — Seat connector audiences through scoped grants

After a workstream's Main participant handoff, connector audience admission
writes exact Main grants through WorkstreamDO and lets durable participant
projections publish roster changes. Each connector event has an immutable batch
receipt, preventing retries from restoring access removed after that event.
Ordinary active members can still join from a new source-conversation event;
guests need explicit sharing, and inherited grants remain inherited. The legacy
identity writer remains only for workstreams that have not transferred authority.
The existing identity admission RPC reports whether it still owns that writer;
ordinary connector turns never contact WorkstreamDO just to discover this.
Guest-triggered tool execution now repeats the canonical conversation check;
checking only workspace membership would let an already-running guest continue
using connectors after their specific share ended.
Keeping that writer after handoff would hit the source's write fence on every
new mapped speaker, while bypassing the fence would restore two roster owners.

Slack session assignment follows this boundary too. Main corrects creator
attribution without touching its transferred roster, then shared connector
reconciliation requests admission with a stable session/user identity. A retry
finishes admission after an attribution-only partial result, and an old accepted
assignment cannot recreate access removed later. Guests remain subject to
explicit sharing even when a connector identifies them as the original author.

### 2026-09-16 — A removed connection leaves the list, and Test says pass or fail

**What changed:** `GET /connections` no longer returns a disabled connection
whose installation is settled — every registration removed, or the cleanup
credential forgotten — or that never had one, so a removed connection leaves
the list as soon as its provider webhook is gone. A row whose installation is
still unsettled stays, because Manage events is reachable only from the row;
the object answers for every disabled candidate in one hop. The Manage events Test
result is a verdict box: green with "Connection test passed" when the check
passed, red with "Connection test failed" when it did not, the sentence beneath
either way. In the connections table the status dot and provider mark no longer
shrink when a long name wraps, and the healthy dot draws the new saturated
`success-vivid` step with a faint halo instead of the sage `success-base`
that read as grey at seven pixels.

**Why:** `disable` marks a row rather than deleting it, and the list returned
every row: an administrator who removed a connection watched it sit there,
badge reading "disabled", tools reading "—", a trash icon that did nothing more.
The Test result was one unstyled sentence at the same weight as the caption
above it, so "Granola authorization is healthy. Approved webhook configuration
is verified" read as more instructions and nobody could tell they were done.
And a two-line name squeezed the 7px status dot to a 3px sliver.

**Considered and rejected:** Hiding every disabled row. A disconnected
installation whose webhook Rally has not yet removed, or whose create outcome
was never learned, needs its Manage events window, and hiding it would leave a
live registration at the provider with no control to reach it. Also rejected:
keeping only the rows Rally itself can clean up, which was the first cut and
dropped exactly the rows where the administrator has to act. Also rejected:
filtering in the desktop only, which would have left the API's list, and every
count derived from it, saying otherwise.

**Consequences:** A row that lingers after removal means its installation is
not settled: a removal still queued or refused, a webhook only the administrator
can find, or a disconnect that did not complete. A settled removal or Forget
local cleanup credential makes it leave. A request that fails before the test
runs is a warning box headed "Couldn’t run the connection test", not a verdict.
Verified in a real window on the local stack: the removed Granola row gone, the
wrapped-name dot intact at 820px, and both Test verdicts.

Shipped in the pull request for this change.

### 2026-09-15 — Granola registers the three events its API defines

**What changed:** The webhook registration request, the installation facet's
declared events, and the delivery's admission read one list —
`note.access_granted`, `note.edited`, `note.generated` — and `note.regenerated`
is gone from all of them, from the setup and adoption paths, and from the
desktop labels. A verified delivery naming any other event is refused with 400
`unsupported_webhook_event`, as Fireflies' is, rather than failing schema
validation with a 500 that Standard Webhooks retries for four days. A workspace
connection whose webhook endpoint was never registered or no longer exists now
reports healthy with a warning and a reason code, the way a disabled endpoint
already did, instead of failing the health check. Test runs a managed repair
before the credential door and reloads the envelope after it, so a retried
create is checked against the endpoint it just registered, and it reports the
repair's reason when it could not repair.

**Why:** Granola's API defines three note events; a regenerated summary is
delivered as `note.edited`. Rally sent a fourth name, and the first workspace to
register a webhook ended with no endpoint, no signing secret, and a health check
saying only that the endpoint identity was missing. That failure reached plugin
activation as an authorization the host could not verify, so the Sidekick built
on the connection was told to retry after the authorization service recovered —
for a connection whose key worked and whose read tools worked.

**Considered and rejected:** Keeping the fourth event in the delivery schema in
case Granola adds one: a delivery Rally has never seen is refused by name where
it arrives, not normalized under a title nobody reviewed. Also
rejected: leaving the missing endpoint a health failure and teaching the host a
fourth verdict for it. The disabled-endpoint branch had already settled the
question — delivery state is a warning, not a verdict about authority.

**Consequences:** A missing or absent endpoint no longer blocks `load_plugin`;
it is visible in the health warning log, in the Test result, and in Manage
events, and only Test through the installation lifecycle restores delivery. The
one Granola workspace installation that existed never registered an endpoint;
it is disconnected and connected again, not reconciled.

PR [#779](https://github.com/juno-ai-labs/avalon/pull/779).

### 2026-09-15 — Gmail callers choose new or reply; the adapter owns threading

**What changed:** Gmail send and draft take a nested `message` union. New
messages supply recipients, subject, and body. Replies supply an existing
message id, recipients, and body, and the adapter fetches the original subject
and threading headers under the same connection. One Zod schema defines both
advertised inputs and runtime validation. Threading headers are deduplicated
with a Set and folded between IDs, with byte validation ensuring that even an
indivisible UTF-8 ID fits on one physical line. Long and Unicode subjects use
independently decodable, folded encoded-words. Generated complete-key variants
preserve Gmail's closed input shapes through Bind's compatibility sanitizer,
and wire tests now validate the actual request with Ajv rather than a schema
that has only passed Rally's root repair.

**Why:** Two fixes to examples and error wording still left a production run
making nine rejected sends. Nonempty reply placeholders satisfied the advertised
schema but failed the executor, and the model repeated the same invalid shape.
The 2026-09-14 new-email-example change below improved guidance but could not
remove that contradictory contract or the unnecessary threading work assigned
to the model.

Automatically copying ancestry also exposed the inherited serializer's repeated
array scans and single-line References join. Forty ordinary ancestor IDs already
produced a 1,032-byte line, beyond the protocol maximum; the old 50-ID input cap
did not guarantee a valid line either. Processing and folding the chain in linear
time preserves the history without making long conversations expensive to send.
Subject encoding had the same physical-line defect: 400 accented characters
became a 1,089-byte line, and one large encoded-word also violated RFC 2047.

The first regression check missed Bind's intermediate sanitizer. That pass
deliberately drops `additionalProperties: false` because xAI rejected nested
boolean schemas. Merely documenting that loss left an extra threading field
legal in the advertised schema and illegal at execution. The generated
required-key variants plus exact property counts express the same constraint
without the removed keyword. A real request-boundary test checks the formerly
accepted extra fields, with and without `cc`, at the root and inside `message`.

**Considered and rejected:** Another prompt/error repair or accepting more
placeholder spellings would keep that ambiguity. Separate new/reply tool names
would also separate the inputs, but the nested union does so within the existing
send/draft capabilities, tool names, and receipt policy. The shape follows
[OpenAI's function design guidance](https://developers.openai.com/api/docs/guides/function-calling#best-practices-for-defining-functions)
and resolves the coupled fields required by
[Gmail's threading contract](https://developers.google.com/workspace/gmail/api/guides/threads#adding_drafts_and_messages_to_threads)
in code.

An ancestor-count cap would discard valid history while still admitting an
oversized individual ID. Folding preserves the chain, and the existing metadata
response bound covers total input size.

Restoring `additionalProperties: false` globally would reinstate a documented
xAI request failure. Silently stripping unknown write fields would violate the
tool policy and risk discarding caller intent. The alternative is scoped to
these two Gmail tools and generated from their executor schema. `maxProperties`
is supported by [xAI's tool schema rules](https://docs.x.ai/developers/model-capabilities/text/structured-outputs#constraint-limits)
and [Google's schema definition](https://ai.google.dev/api/generate-content#Schema).
Strict structured-output restrictions are distinct from Rally's non-strict
Chat Completions tools, as OpenAI's
[function-calling documentation](https://developers.openai.com/api/docs/guides/function-calling#strict-mode)
explains. This does not enable strict generation or change
provider routing. Runtime validation remains necessary because a model can
still generate arguments that violate its advertised schema.

**Consequences:** Replies require read access and one metadata fetch before the
write. Recipients stay explicit; unreadable or unthreadable originals produce a
field-named error before any write. Existing flat inputs are deliberately
rejected, so callers need refreshed tool definitions. A parent Message-ID that
cannot fit on a continuation line is refused before the write; an oversized
ancestor is omitted without truncating any ID. The tests use synthetic messages
and inspect provider requests, including long duplicate-heavy chains and ASCII
and UTF-8 byte boundaries; they do not send live email. Required fields, kinds,
and declared-value constraints, including rejection of undeclared keys, are
checked after the real harness serialization path. The property counts are
derived from the required keys, not independently chosen defensive limits.
Adding another optional Gmail field requires deliberately extending the
generated variants; it must not leave an unused slot for an unknown key.

PR [#792](https://github.com/juno-ai-labs/avalon/pull/792).

### 2026-09-18 — Fireflies takes no new workspace connection

**What changed:** A connector may now declare `connectableScopes`, the scopes it
will still take a credential in, narrowing `supportedScopes` the way
`activityConnectionScopes` and `capabilityConnectionScopes` already narrow it
elsewhere. Fireflies declares `["personal"]`. Creating a connection, completing
an authorization that carries no connection, creating a workspace installation
and replacing an installation's API key are all refused for a closed scope;
reauthorizing an existing connection, repairing it and disconnecting it are
not. The desktop catalog offers only
**Connect for me** for it, `POST /connections/fireflies/workspace` and the
two-stage setup dialog behind it are deleted, and the **Manage events** window
is no longer offered for a connector whose workspace scope is closed. The
signing-key rotation guidance that window carried is deleted for every provider.

**Why:** A Fireflies workspace connection is one administrator's API key that
every member of the workspace reads through, so connecting it hands the whole
company every transcript that key can see — including calls whose participants
never agreed to that — and Fireflies publishes no field saying what the key
covers, so Rally cannot state the blast radius even to the person pasting it.
Rally is taking no new workspace connection of that shape until the
authorization model says who may read which meeting. The removed setup also
walked an administrator through ticking event subscriptions and rotating a
signing key, which is a webhook console rather than a product: the events a
connector needs are the connector's to know.

**Considered and rejected:** Narrowing `manifest.supportedScopes` to
`["personal"]`, which is where a reader looks first. The registry requires a
workspace scope for a connector with `installationManagement`, so that would
have meant deleting the webhook ingress, the read tools and the installation
along with it — and with them the meetings of any workspace that already pasted
a key, which turns a product decision into a data migration. A second rejected
option was leaving the route and refusing at the desktop, which leaves anything
holding the route connecting a scope the product has withdrawn.

**Consequences:** `supportedScopes` now answers "what can this adapter serve"
and `connectableScopes` answers "what will it still take a credential for", and
a surface that offers a connection has to read the second. Hiding a button is
not the boundary — the four service paths are, which is why a replacement API
key is refused there rather than only in the window that used to offer one. An
existing Fireflies workspace connection keeps its tools, its ingress and its
activity, and its row keeps **Delete**; it has no **Manage events** and no
**Refresh**. **It therefore keeps working until its key changes, and no
further**: rotating the key in Fireflies leaves a connection that reports
`needs_reconnect` with deletion as the only action, because giving it a new key
is the grant this closed. That is the decision, not a gap — a workspace whose
key must change is a workspace connecting Fireflies afresh, which is what is
being withheld. Reopening the scope is one line in
`fireflies.ts` plus the desktop catalog's `scopes`.

### 2026-09-15 — Fireflies' `keywords` is a list, whatever its schema page says

**What changed:** `SummaryRowSchema.summary.keywords` accepts a string or an
array of strings, and `meetingSummaryOutput` joins a list into the bounded
string the tool has always returned. The test fixture is corrected to the shape
a real workspace returns, and a case covers both.

**Why:** Every workspace `get_meeting_summary` call failed. Fireflies answered
HTTP 200 and this rejected the body, so the call surfaced as
`unexpected_error` — a `ZodError` is not a `ConnectorError` — and a Sidekick that
had finally received its `meeting.summarized` event ran, could not read the
meeting, and sent no recap.

Read against a real workspace key on 2026-09-15, `keywords` came back as six
strings. [Fireflies' schema page](https://docs.fireflies.ai/schema/summary)
declares it `String` and `topics_discussed` `[String]`. Both shapes are real:
the same page says a summary's fields are produced by "AI apps" an account can
customize, so this is configuration rather than a provider bug, and rejecting
either shape fails somebody's workspace.

The fixture is the reason this was invisible. It encoded `keywords` as a string
— the documented shape, never the returned one — so the suite was green while
every live call was rejected. That is the failure mode
[`testing.md`](testing.md#prove-the-test-can-fail) describes as asserting on a
fixture: the test proved the adapter agreed with the fixture, and the fixture
was written from the same wrong source as the schema.

**How it is proved:** `packages/connectors/src/fireflies.test.ts` drives
`get_meeting_summary` with each shape and asserts the same joined output.
Restoring `keywords: z.string().nullish()` fails both with
`ZodError: Invalid input: expected string, received array` — the production
rejection exactly.

**What a future change has to respect:** the output stays a bounded string.
Which shape arrives is the account's configuration, and a caller should not have
to branch on it; `topicsDiscussed` is already the field that carries a list.

**Considered and rejected:** changing `keywords` to `z.array(z.string())` to
match what was observed. That trades one account's configuration for another's
and would have failed for anyone whose summary app returns the documented
`String`. Also rejected: surfacing the list as a list, which changes the tool
output shape the model reads for a fix whose whole job is to stop a rejection.

Shipped in the pull request for this change.

### 2026-09-14 — A refused webhook delivery names the event it refused

**What changed:** All four `unsupported_webhook_event` refusals — Fireflies'
two, Granola's, and the generic webhook connector's — go through one
`unsupportedWebhookEvent` helper. It logs `connector_webhook_event_refused`
with the connector, connection and event type, and returns an `ApiError` whose
message names the provider and event and whose `details` carry both.

**Why:** The reason was always thrown; no operator could read it.
`request_failed` records a refusal's `detail_keys` and deliberately withholds
their values, and never records the message at all, so every one of these
landed in Workers Logs as a bare `request_failed 400 unsupported_webhook_event`
— you learn a delivery was refused and never which one. Recovering it meant
joining against whatever `connector_operation_finished` happened to share the
millisecond, which works only while traffic is thin enough for that to be
unambiguous, and not at all once two connectors deliver at once.

An event type is the provider's own vocabulary: it is in the connector manifest
and `connector_operation_finished` already logs it. It is not member data, so
it is named rather than withheld. The `details` carry it to the caller too,
because a provider dashboard replaying a delivery shows the response body, and
"Rally does not model the fireflies event meeting.bot_joined" is the whole
diagnosis without anyone opening a log.

**How it is proved:**
`apps/api/test-workers/connector-installation-fireflies.test.ts` already
delivered a verified `meeting.bot_joined` and asserted the 400; it now also
asserts the message contains the event type and that `details` name the
provider and event.

**What a future change has to respect:** a connector added later gets this for
free only if its refusal goes through the helper. A new
`new ApiError(400, "unsupported_webhook_event", …)` is the regression.

**Considered and rejected:** logging `details` values generically in
`errorHandler`. Those values are arbitrary across every route that raises an
`ApiError`, and the whole reason `detail_keys` exists is that they may be
member data. The event type is safe because of what it is, not because of where
it sits, so it is named at the site that knows that.

Shipped in the pull request for this change.

### 2026-09-14 — A connector declares which scopes its events can arrive in

**What changed:** `activityConnectionScopes` narrows a connector's supported
scopes for activity, beside the `capabilityConnectionScopes` that narrows them
for a capability, and Granola, Fireflies and Ashby declare `["workspace"]`.
`connectorActivitySupportsScope` is the one reader. Registry construction
refuses a declaration naming a scope the manifest does not support, and one on
an adapter with no activity at all.

**Why:** All three refuse a personal connection from `normalize`, because the
provider's webhook is created by the workspace install — a fact that appears
nowhere in a manifest, so every consumer that wanted it was inferring it or,
in the drafting catalog's case, not asking at all. Declared per connector
rather than derived from `webhookActivity`, because the asymmetry is the
provider's and not a property of the facet: GitHub, Linear, Notion and a
generic webhook all deliver to a personal connection through that same facet.

**Consequences:** A connector that starts delivering events to personal
connections drops the declaration in its adapter, and every surface that asks
this question follows. The eventless-adapter refusal exists so the field
cannot become a claim nothing reads: silence has to keep meaning "the
connector's own scopes", not "there is no activity here".

### 2026-09-14 — A new Gmail email is demonstrated, not only described

**What changed:** The non-threaded mail shape is present on every surface a
model reads before a Gmail write, rather than on one of them. `gmail.draft`
gains a worked example that starts a conversation — `to`, `subject`, `body`
and nothing else — shown before the threaded reply; the mail guidance gains
the matching sentence; and `inReplyTo` and `references` describe what omitting
them does and which tool produces their value, which only `threadId` did. The
reply example's identifiers are now the `…` the rest of the file uses, not
`<hit.threadId>` and `<hit.messageIdHeader>`.

**Why:** A run failed to draft a brand-new email twice, and reported the tool
as requiring reply fields. The threading rule was never the fault and the tool
descriptions had already been fixed to say so; the two surfaces that outrank a
description had not. The only `create_draft` call ever demonstrated was a
threaded reply, and the only guidance sentence about threading described
replying, so a model composing a new email had the reply as its sole model of
the call and filled in identifiers the conversation does not have. An example
is the strongest instruction here: the shape that is shown is the shape that
gets sent.

The placeholders are the second half of the same report — *"Google rejects the
resulting malformed request"*. `<hit.messageIdHeader>` satisfies
`RfcMessageIdSchema` exactly: angle-bracketed, no inner brackets, no
whitespace. Copied verbatim it passed the JSON Schema, the harness, the
cross-field rule and the connector's parse, and was refused only by Gmail —
which names no argument on a body field, so the model could not tell which of
its arguments was at fault and blamed the schema. A placeholder that fails
Rally's own parse is refused against the field to fill in instead.

**Considered and rejected:** Validating `threadId`'s id family at the boundary
per agent-tools principle 12. Gmail thread ids are bare hex in every example
Rally shows, but that alphabet is asserted nowhere and the adapter's own
fixtures use `thread-1`, so the check would have been a guess that rejects
valid replies. Relaxing the `threadId`-without-`inReplyTo` rule: it is correct,
and Gmail accepts that pair and files the mail where nobody is reading it.

**Consequences:** A Gmail write rejected by Google still fails without naming
an argument. `googleRejectedArgument` reads Google's `locationType:
"parameter"`, which covers the query-parameter rejections the paginated read
tools earn and not a body field like `threadId`, so `gmail.create_draft` and
`gmail.send` pass no mapping at all. Closing that needs an observed Google
rejection body for a bad draft `threadId`.

Only one of the two placeholders is caught by the boundary in the meantime, and
it is not the one that needs catching. `inReplyTo` is refused by
`RfcMessageIdSchema`; `threadId` is an unformatted `min(1)` string, so a
half-substituted reply — a real `inReplyTo` beside a `threadId` still reading
`…` — validates cleanly and reaches Gmail, which is the same nameless rejection
one field over. Both are therefore pinned as literals in
`connector-tool-selection.test.ts` rather than left to the validator, and that
test is the only thing stopping a later change from restoring realistic-looking
values. It also pins the other direction: the new-email example must validate.

### 2026-09-13 — Fireflies' test event verifies the installation

**What changed:** A signed Fireflies delivery whose event is `test` — what the
Webhooks V2 page's **Send test event** button sends — is answered
`200 { ping: true }` and recorded as the registration's verifying delivery,
with no receipt, payload, or activity written. Setup copy tells the
administrator to press that button.

**Why:** The connector shipped on research that found no test ping, so the
first real meeting was the only verification. Fireflies has one now, and the
first administrator to press it got `400 unsupported_webhook_event` back —
Fireflies' page reported the webhook as failing on a setup that was correct,
and Rally could not say otherwise until a meeting finished. The ping proves
what a meeting would: the URL reaches this connection and the secret matches.

**Considered and rejected:** Acknowledging the test with 2xx but leaving the
installation **Action required** until a meeting, which keeps Fireflies' page
green while Rally's Settings still says otherwise. Letting any verified but
unhandled event verify, which would let a `meeting.bot_joined` subscription
nobody asked for stand as evidence.

**Consequences:** The test event's shape is undocumented and asserted from one
live observation; `FIREFLIES_TEST_EVENT` is where a change in it shows up.
`lastReceivedAt` moves on a test event too, so a last-received time is
evidence of reachability, not of a meeting.

### 2026-09-13 — Fireflies connects a meeting record Rally cannot register itself

**What changed:** A `fireflies` connector with the two-scope shape Granola set:
an admin API key behind three fixed GraphQL read tools plus signed webhook
activity, and a hosted-MCP OAuth pass-through for a member's own account.
`meeting.summarized` is digestible and `meeting.transcribed` operational. Its
rollout is gated per region on `FIREFLIES_CONNECTOR_ENABLED`, and WorkspaceDO
migration 55 widens the connector vocabularies and adds its cardinality indexes.

**Why:** Fireflies' install base is larger than Granola's, and a prospect who
already pays for it will not move their meeting capture to Rally as a
precondition for evaluating Rally. Without this their meeting record is
invisible: the agent cannot answer what a customer objected to on Tuesday's
call, and members re-paste summaries by hand.

**Considered and rejected:** Pointing the workspace scope at Fireflies' own MCP
server with the API key, which it accepts — pass-through tools are all treated
as confirmed writes and so are unusable at automation time, several are marked
experimental and can change shape underneath us, and a fixed document keeps the
read authority reviewable field by field. A raw GraphQL tool, for the same
reason at greater cost. Requiring Enterprise with Super Admin so coverage could
be stated exactly, which would exclude most Fireflies customers for a purity the
product does not need. A checkpointed poll alongside the webhook, which the
installation lifecycle defers outright and which could never see a summary that
landed more than the poll's own window after its meeting, because Fireflies
filters on creation date alone.

**Consequences:** Fireflies is the first provider whose every registration
operation is the customer's, so setup hands the administrator an endpoint and a
signing secret and the installation stays **Action required** until a delivery
proves the registration — the one lifecycle extension this needed. A missed
delivery is made visible rather than compensated: Fireflies documents no retry,
so a last-received time that stops moving is the signal. Coverage is stated as
unknown because the provider exposes no way to know it.

PR #738. Design:
[Fireflies connector](PRDs/2026-08-14_fireflies-connector/prd.md).

### 2026-09-12 — Ashby and shared workspace installation ownership

**What changed:** Ashby adds personal hosted MCP and independent workspace event installation, automatically registering its documented 27-event catalog. Its email-change signal deduplicates renewed delivery watermarks while preserving raw regional evidence. Granola setup, explicit repair and removal now use the shared installation facet.

**Why:** Subscription management belongs to the connector while event choice belongs to automations. Personal tool consent cannot authorize organization event registration, and direct provider writes could lose the identity needed for recovery after uncertainty or disablement.

**Considered and rejected:** Adding recruiting REST tools to the workspace grant or retaining a parallel Granola repair/revoke path. Both would blur the authority the new lifecycle separates.

**Consequences:** Keep inventory and health read-only, preserve existing Granola subscriptions on adoption, and use the [installation lifecycle](connector-installation-lifecycle.md) for mutations. Ashby organization events use the workspace audience authorized by the connecting administrator; normalized fields remain limited to event metadata and IDs.

PR #737. Design: [connector installation lifecycle](PRDs/2026-09-12_connector-installation-lifecycle/prd.md).

### 2026-09-11 — Agent-presented connection cards reuse the one OAuth authority

**What changed:** An opted-in conversation-feed card can initiate or reconnect a trusted native
OAuth connector, including a personal Slack connection, while registering its
pending attempt in the application session. A paired agent tool reads durable
connection state, and the card follows workspace-socket connection changes
until it observes and latches **Connected**.

**Why:** Connector failures could identify a missing authorization but offered
no in-context recovery. Reusing the existing start, reconnect, callback, and
query-invalidation path keeps the card a new presentation of one authority,
not a second connection mechanism.

**Alternative rejected:** Storing an OAuth URL or capability list in the
agent-authored transcript. Either could become stale or hostile, and both
duplicate decisions already owned by the connector catalog and regional API.

**Consequences:** Shared non-UI catalog data owns card ids, provider/capability
discriminators, supported scopes, and stable icon names; the model-visible enum
and validation derive from it, while the desktop consumes its icon names and
remains responsible for translating those trusted entries into provider
requests. OAuth completion, denial, and failure continue through the existing
deep-link receipt and refresh every surface from the shared connection query.
The terminal transcript fact retains the safe card input, with an exact shared
summary fallback for interrupted-run recovery, so the presentation stays
visible; adjacent repeats collapse instead of double-stacking.

### 2026-09-11 — The collapsed null-branch backlog is retired by Bind 14

**What changed:** Nothing in the adapters. `@juno-ai/bind` 14 delivers a flat
`type: [T, "null"]` as a union, so the 28 parameters the entries below counted
as "still collapsed" (Linear 13, Granola 7, Slack 6, Notion 2) now reach the
model with their null branch, and the registry-wide assertion in
`apps/api/test/tool-schema-sanitization.test.ts` names the three Bind 14 still
collapses by design: the cell values of Google's `sheets.update_values` and
`sheets.append_values`, and the artifact query tool's `params`, each a
multi-type union with `null`.

**Why:** The backlog was left for per-parameter decisions about what `null`
means for an id or a filter, and the wire was forbidding the value regardless
of what the prose decided; one of the Slack six was `send_message.thread_ts`.
The [`agent-tools.md`](agent-tools.md) entry of the same date owns the
reasoning and the alternative that was rejected.

**Consequences:** a new connector cannot ship the collapsed shape, because the
guard covers every declaration, and a parameter in one of the shapes Bind 14
still collapses is reported by name. Descriptions still owe the reader what
`null` requests. And the wire is the only thing that changed:
`SlackTimestampSchema` still accepts any non-empty string, and the `pattern`
that refuses a non-timestamp before the provider call is phase 0 of
[the Sidekick delivery PRD](PRDs/2026-09-11_sidekick-delivery-reliability/prd.md),
not this change.

### 2026-09-11 — Connections report tool counts

Settings now counts the tools granted to each connection, including live MCP
inventory and its tool policy. Counting permission capabilities understated what
one connection exposes. Counts load separately from the connection list so a
provider outage cannot block Settings; an unreadable inventory remains unavailable
rather than being reported as zero. Future connectors must use their agent tool
surface for this count, not a separately maintained number. The shared validator
also rejects names that collide only after the connection prefix is added; counting
the adapter inventory alone would claim tools that activation refuses. Policy saves
invalidate counts even when navigation races the pending save.

### 2026-09-11 — Google, Slack, Linear, Notion, and Granola describe their parameters

**What changed:** The 150 undescribed parameters on the five remaining connector
surfaces gained one each, to the rule in
[principle 13](agent-tools.md#13-every-parameter-says-what-it-is-for-and-what-leaving-it-out-does):
what it selects with a worked value in the provider's own spelling, what
omitting it does, which tool produces the value when another one does, and what
a wrong value does wherever the provider answers wrong with silence. Slack's
conversation ids, user ids, and message timestamps each say what the id is
through one shared sentence rather than a copy per tool — the filter variants
differ from the target ones only in what absence means, and the hand-written
copy that preceded them had already drifted. Linear's and Notion's single-id
tools take their prose through the helper that builds those schemas.

**Why:** GitHub's `head` was the failure that produced the rule, and it is a
connector-shaped failure: the part of a tool a JSON Schema cannot express is the
provider's own grammar. An id family (`C…` against `U…` against `D…`), a
timestamp's unit, an A1 range naming a sheet, a label spelled exactly as the
repository defines it, a `threadId` that is not the `id` beside it in the same
search hit. Every one of those is answered with an empty result rather than an
error, on every provider here.

**Considered and rejected:** pointing at each provider's API reference from the
tool description. The model cannot follow a link, and what an unmatched filter
returns is usually the sentence the provider's own reference does not write
down.

**Consequences:** X was already complete, so every connector surface is now at 0
in `tool-schema-descriptions.test.ts` and a new connector tool fails `pnpm test`
until its parameters are described. The `null`-branch backlog the 2026-09-03
entries below count is untouched: those parameters now say in prose what absence
means, but the ones still spelled `type: ["string", "null"]` still cannot carry
it on the wire.

### 2026-09-11 — A declared relationship is what makes a container findable

**What changed:** The invariant above, and nothing in the adapters. A resource
type reaches a Sidekick's evaluator rules only where some activity trigger
declares a `resourceRelationships` entry for it, and as of
[`automation-lifecycle.md`](automation-lifecycle.md)'s entry of the same date
that set is also the whole of what the drafting search offers.

**Why:** Declaring the relationship used to decide one thing — whether a watch
routed events — and it now decides two, so an adapter that omits one makes the
container invisible to whoever is drafting as well as inert once drafted. It is
recorded here because the decision belongs to the adapter author, who has no
reason to read the Sidekick module's changelog, and because the tree already
carries one instance of the failure in the other direction: `granola_folder` is
declared and never written, which is a relationship pointing at nothing and an
empty search with no way to say why.

### 2026-09-10 — GitHub list tools answer in an envelope, and every parameter is described

**What changed:** All 112 GitHub tool parameters carry a `description`; the
adapter converts its schemas with `z.toJSONSchema(schema, { io: "input" })`; and
`pull_requests.list`, `issues.list`, `commits.list`, `pull_requests.list_files`,
`pull_requests.list_reviews`, `actions.list_workflow_runs`, and
`checks.list_for_ref` return the `repositories.list` envelope — the named
collection, `count`, `page`, `perPage`, `hasMore`, and `appliedFilters` — rather
than a bare array or a `{ totalCount, items }` pair.

**Why:** A recorded run (2026-09-10) reported `juno-ai-labs/avalon` as having no
open pull requests when it had twenty-five. The call carried an invented `head`
filter, which GitHub answers with HTTP 200 and `[]`; the connector returned that
array under the summary "Listed pull requests", and nothing in the result let
the model attribute the emptiness to its own argument. It repeated the call and
then abandoned the connector for a terminal credential and `git`. `head` was
undescribed, as every GitHub parameter was, and output-mode schema conversion
had advertised the five defaulted parameters beside it as required.

**Considered and rejected:** describing `head` and `base` alone and leaving the
bare array. The description stops the model sending a filter it did not mean;
it does not tell a model reading an empty page why the page is empty, and a
filter can be meant and still match nothing. Also rejected: asking GitHub for
one item past the page to make `hasMore` exact, which shipped into review and
was caught there — `page` counts in units of the `per_page` sent, so the
peeked-at item falls before the next page's first and is skipped rather than
returned. `hasMore` is the conservative full-page reading instead, and the exact
answer, if one is ever needed, is the `Link` header rather than a wider
request.

**Consequences:** Anything reading a GitHub list tool's `output` as an array now
reads the named collection on it. `head` and `base` are sent only when the
caller supplied them, which `github.test.ts` asserts directly — a default
quietly reintroduced there is the original failure again.

### 2026-09-08 — Skip unchanged discovered resources

**What changed:** Discovery upserts compare the effective merged values before
writing, excluding delivery provenance from that comparison.

**Why:** Repeated webhooks rediscover the same resources with new delivery IDs,
turning otherwise identical observations into resource writes and indexing work.

**Considered and rejected:** Comparing all metadata would still write on every
new delivery ID; discarding all metadata differences would lose real changes.

**Consequences:** No-op observations preserve resource timestamps and provenance.
Actual changes retain URL fallback and recursive JSON merge-patch behavior.
Unchanged rediscovery does not bump resources to the top of updated-time lists
or create phantom semantic versions.

PR: #611.

### 2026-09-08 — Resolve event relationships with indexed identity seeks

Connector event ingestion now resolves the primary provider resource ID and
entity keys as one deduplicated JSON set through the existing scoped resource
identity index. The former correlated OR scanned the connection's full inventory:
one production event read 495,339 rows for three resource identities. Exact seeks
returned the same identities with 18 reads. Workspace, connection, provider,
null handling, and sorted canonical IDs remain part of the resolver contract.

One bound parameter per key was rejected because a valid event can exceed the
runtime's SQL variable ceiling. Inventory pruning and event drops were rejected
because the lookup can preserve all admitted data without paying for unrelated
resources on every event.

### 2026-09-03 — Every other connector's cursor gets the repair Google's got

**What changed:** The cursor on Linear, Notion, Slack, Granola, and X is
declared `anyOf: [{string, minLength: 1}, {null}]` instead of the flat
`type: ["string", "null"]`, which is the spelling that survives Bind's
sanitizer. Linear's `after`, Notion's `startCursor`, and Slack's `cursor` also
gain the description they never had; Granola's and X's are rewritten to say that
`null` is the first-page value, because their old wording said "optional" beside
a schema that had just stopped permitting absence.

The guard added with Google's change is widened from its four cursors to every
cursor on every registered connector, matched on declared type as well as name
so Slack's numeric `search_messages.after` is not read as one. It is scoped to
the cursor property: the other collapsed branches on those same tools are the
backlog counted below and are not converted here.
`tool-argument-empty-strings.test.ts` gains the matching sweep for a cursor with
no description, reading it off the property rather than the string branch, since
under `anyOf` the description and the constraints sit on different nodes. Its
older sweep now demands a positive `minLength` rather than a declared one:
`minLength: 0` is a number, so "is it declared" accepted it, while the harness
only drops a blank at `>= 1`, and a cursor relaxed to `0` would have forwarded
`""` to the provider again with the suite still green. Both
sweeps read cursors through one shared helper, because two copies kept in step
by hand diverged on the first edit that touched only one of them.

Slack's `search` and `search_messages` now report a last page as
`next_cursor: null` rather than passing the provider's `""` through, which is
the repair `boundXPage` already makes for X. Without it those two tools would
carry a description whose stop condition the caller never sees: a blank cursor
reads as another page, cannot be sent back because the string branch rejects
it, and the caller either invents a token or sends `null` and re-fetches page
one forever. An earlier revision of this change instead described the last page
as "no `next_cursor`", on the reading that these tools leave the key absent.
They do not, and a description is not the place to record a provider's quirk
that a normalizer can remove.

X had the same gap in the other direction: `boundXPage` normalized a blank
cursor but returned a response that omitted the key untouched, and X reports
some last pages as `has_next_page: false` with no cursor at all. The key is now
always emitted. Every caller of that helper is one of the four paginated tools
whose description promises the `null`, so there is no unpaginated response it
adds a key to.

**Why:** The two Google cursor entries below fixed that connector's four and
recorded what remained:
46 authored null branches across five connectors, still collapsed to
`type: "string"` with the nullability moved into prose. 18 of those are the
cursors converted here. That is the
schema-forbids-what-the-prose-permits conflict those entries were written to
end, and the run they measured shows what a caller does with it: eight
`drive.search` attempts, a value invented every time, three of them one
character long, and the leaked reasoning *"Schema says min but omit should maybe
omit."*

Nothing in that mechanism is Google's. The five other connectors serving a
cursor were not in the incident because the run happened to reach for Drive, and
shipping the description half alone to them would have shipped the half that was
already measured not to work.

**Considered and rejected:** Describing the cursors without converting the
spelling, which is what the first draft of this change did. The entry below
establishes that a description alone did not survive contact with a caller that
had it in front of it four times, so that draft would have added prose to five
connectors and fixed none of them. Also rejected: converting all 46 collapsed
branches. Absence means something different for an id, a filter, and a cursor,
and each needs its own reasoning about what `null` requests; a cursor is the one
where absence has a single unambiguous meaning and a measured failure behind it.
An earlier revision of this change left Granola's description without a
producing field or a last-page signal, on the reading that its list response is
passed through unmodelled here so neither had been established. That was wrong:
`/v1/notes` and `/v1/folders` return `cursor` alongside `hasMore`, and this
adapter's own tests pin that shape. Granola names both, like the rest, and no
connector here carries an exception.

**Consequences:** 28 collapsed branches remain, on four connectors (Linear 13,
Granola 7, Slack 6, Notion 2), and they are ids and filters rather than cursors;
they stay declared as type arrays, and the widened assertion passes over them
because it filters to the cursor property, so converting them stays a deliberate
change rather than something this guard forces. That count comes from running
`droppedNullableBranches` over the registry, not from subtracting 18 from the
46 those entries recorded. A connector adding a
paginated tool now has two guards to satisfy rather than one, and both name the
connector, tool, and parameter when they fail. Slack keeps two cursor constants
because its two searches bound the string at 2,000 characters and its three
conversation reads never did; that absence is preserved rather than closed,
since the number would be the team's to set.

### 2026-09-03 — A connection can name a connector Rally did not ship

**What changed:** A `custom_mcp` connector type whose connections each carry
their own MCP endpoint, their own credential — configured request headers or an
OAuth grant — and, for a workspace connection, their own policy about how much
of that server's catalog Rally may call. `beginProvider` carries that
configuration through the sealed OAuth state to `completeProvider`, which writes
it into `config_json` and takes the person's own name as the connection's
display name rather than the usual `<Provider> · <account>`. WorkspaceDO
migration 31 widened the `connector_type` and `connector_oauth_attempts.provider`
vocabularies. The module document is
[`custom-mcp-connectors.md`](custom-mcp-connectors.md).

**Why:** Which providers Rally can reach was a property of Rally's release, so a
workspace with an internal MCP server, or any of the servers now published, had
no way in. The hosted-MCP module already owned the hard parts; what was missing
was a connection, rather than a declaration, being allowed to say which server it
meant.

**Considered and rejected:** Holding configured servers outside
`connector_connections`. It would have avoided a table rebuild and given up
credential refresh, plugin construction, the connections screen, receipts,
audit, and disable — every rule this document describes.

**Consequences:** `connector_type` is no longer a closed set of providers
somebody here wrote code for, and anything reading it must accept a value whose
behaviour is decided per connection. `provider_account_id` for such a row is the
server's own URL rather than an account at a provider, which is what a reconnect
is matched against. And a connector may now be registered in a region with no
credentials configured at all: the custom MCP adapter needs only a callback URI.

### 2026-09-03 — A Google cursor can be `null`, because omission is not a move

**What changed:** `pageToken` on `gmail.search`, `calendar.list_calendars`,
`calendar.list_events`, and `drive.search` is declared
`anyOf: [{string, minLength: 1}, {null}]` instead of a bare optional string,
and the executor parses `null` as absence. Sending `null` now runs the first
page. `apps/api/test/tool-argument-empty-strings.test.ts` descends into the
union so its cursor sweep still covers these four.

**Why:** The description added earlier the same day did not work, and the run
that proved it had that description in front of it four times over. In a work
stream created fresh after the deploy — no earlier calls to copy — a run made
eight `drive.search` attempts and put a value in `pageToken` every time:
`"x"`, `"null"` as a string, `"first"`, `" "`, `"undefined"`, `"/"` twice, and
once its own leaked reasoning followed by garbage text. Three of the eight were
exactly one character. Every call was rejected whole by Google, including the
first, which needed no cursor at all.

The leaked reasoning is the finding: *"here likely pageToken required? Schema
says min but omit should maybe omit. We sent empty invalid. Need redo."* It was
looking for a way to say "nothing". `minLength: 1` reads to a caller as a floor
it has to clear rather than a rule that only applies once the key is present,
and the two statements — prose saying *omit*, schema saying *at least one
character* — resolve in favour of the machine-readable one. That is the
reasonable reading, and no wording defeats it.

`null` ends the search by making absence expressible as a value. It is the
convention the strict structured-output dialects settle on for exactly this
reason: every property present, absence spelled out.

The declaration is `anyOf`, not the flat `type: ["string", "null"]` Slack's
cursors use, because Bind's `sanitizeToolSchema` collapses the flat form to
`type: "string"` and appends "Accepts string or null." to the description. That
hands a caller a schema forbidding the value and prose permitting it — the
conflict this change exists to end — so the flat form would have been inert.
The union passes through whole.

Measured across the whole registry with `droppedNullableBranches`, **46
authored null branches are collapsed this way** — Linear 17, Slack 11, Granola
9, Notion 5, X 4, of which 19 are cursors — so those callers cannot spell
absence either. Google's four are the only ones that survive. Converting the
rest is a change per connector and is not attempted here; the rule now lives in
[`agent-tools.md`](agent-tools.md), which owns tool authoring, and the
sanitization suite asserts over Google's four so a fifth paginated Google tool
joins the guard rather than quietly missing it.

**Considered and rejected:** Lowering or dropping `minLength`. It re-buys the
Linear `after: ""` failure of 2026-09-02 — the harness drops a blanked optional
argument only where the schema says the empty string is invalid, so relaxing it
sends `""` to the provider instead of `"x"`. Also rejected: wrapping each
issued token in a Rally-owned envelope and discarding anything unstamped. It
works, but it defends against invented values rather than removing the reason
for them, and it puts a second encoding between the caller and a cursor the
provider already documents as opaque. Also rejected: removing `pageToken` and
paging inside the tool. That is the cleanest shape and remains the fallback,
but it changes what the tool means and gives an unbounded search no ceiling; a
three-line schema change comes first, and 77 turns in a fortnight did echo a
real cursor back, so pagination is genuinely used.

**Consequences:** A caller may now send `null` for any of these four cursors and
get the first page. The blank-argument rule is unaffected — both union branches
reject the empty string, so `schemaRejectsEmptyString` still returns true and
the harness still drops `""`. The cursor sweep in the API tests had to learn the
union shape: read only at the top level it does not fail on this declaration, it
stops matching it, and a guard that silently covers nothing is worse than one
that fails. If a caller still invents a value after this, the answer is to stop
exposing the cursor rather than to describe it again.

### 2026-09-03 — A Google cursor says where it comes from, and a rejection names the argument

**What changed:** The `pageToken` parameter on `gmail.search`,
`calendar.list_calendars`, `calendar.list_events`, and `drive.search` carries a
description: echo back the exact `nextPageToken` a previous call returned,
holding that call's other arguments unchanged, never construct one, and stop when
`nextPageToken` is `null`. Separately, a Google rejection that names an argument
now reaches the caller as `field` on the structured failure, with the argument
named in the message, instead of a bare `Google API failed (400)`.

**Why:** Drive search failed for a work stream all afternoon and the agent
answered from public web search instead, having been told only that Google
returned a 400. Every `drive.search` call it made carried a `pageToken` it had
invented — `"/"`, then `"1"`, then `"next"`. Google rejects an unrecognized
cursor before it searches anything, so each call failed whole rather than
degrading. Ninety-three model turns hit this on 2026-09-03 and seventy-seven on
2026-08-28; no `drive.search` carrying an invented cursor has ever succeeded.

Two independent gaps produced it. The first is that `pageToken` was the only
parameter on those tools with no description, and in the failing run the model
got every described parameter right — a valid `fileType`, a valid `orderBy`, a
valid RFC 3339 `modifiedAfter` — while guessing the one that had none. A cursor
is the argument whose value cannot be reasoned out from its name and its bounds:
`maxResults` needs no prose because `minimum`/`maximum` on a field called "max
results" already say what it is, and nothing about `minLength`/`maxLength` says
that a token has to come from a previous result. Real tokens are opaque
provider state — a Drive one runs 464 characters behind a `~!!~` sentinel, a
Calendar one is base64 protobuf carrying a resume instant and record id, a Gmail
one is twenty digits with a significant leading zero — so no shape a model could
reasonably guess is a valid one.

The second gap is why one wrong guess cost eight round trips instead of one. The
adapter already captured Google's error body, which names the refused argument
in `error.errors[].location`, but forwarded it through `readStructuredFailure`,
whose allowlist Google's shape matches on no key. The model received
`{"code":"provider_error"}` and a status code, so it kept the invalid cursor and
varied everything around it until it gave up on the connector entirely. This
half is not specific to pagination, and it is the half that makes any future
wrong argument recoverable in one turn.

The last page is described as `nextPageToken: null` rather than as an absent
key, because `readString` returns `null` and that is the shape all four tools
emit — 1240 turns in a week's archive show it. Describing a key that is never
absent as "absent" would leave a caller to resolve the contradiction against
what it sees.

The name Google puts in `location` is its own *HTTP parameter*, which for most
of these is not the tool's argument: `drive.search` sends `maxResults` as
`pageSize`, and three tools send a `query` as `q`. Relayed as-is it would name
`q`, a key every one of these tools rejects outright, reproducing the same loop
one layer down — so each tool carries a map from Google's parameter back to its
own argument and a parameter with no entry is dropped. Drive's `q` is
deliberately absent, being composed from three arguments at once, and `orderBy`
belongs to Drive alone: `calendar.list_events` sends that parameter too, but
Rally fixes its value, so it is not the caller's to correct. The lookup only
ever yields one of Rally's own literals, so no provider text reaches a model
through this path and no bound on the provider's string is needed to keep it so.

The naming is gated on a 400. Drive reports a deleted, trashed, or unshared
file with the same `errors[]` shape and `location: "fileId"`; read as an
argument fault, a 404 would tell a caller its id was malformed when the file is
simply unreachable, and send it back to re-derive an id it had right.

**Considered and rejected:** Validating the token — rejecting one Rally did not
issue. Doing it properly means tracking issued cursors per run, which is durable
state for a stateless parameter, and doing it cheaply means guessing at the shape
of a value the provider documents as opaque. The observed lengths make the
cheap version actively wrong: a single floor cannot fit both a 20-character
Gmail cursor and a 464-character Drive one, and any "reject values that look
like numbers" rule rejects every valid Gmail cursor. Also rejected: dropping
`pageToken` from the model-facing schema. Google returned a real
`nextPageToken` in 1307 turns of the same archive, so pagination is genuinely
reachable and removing it would silently truncate large searches at
`maxResults`. Also rejected: putting the guidance in the plugin system message
or its worked examples, which are read when choosing a tool rather than when
filling an argument, and which would carry it for Drive alone.

One sentence covers all four tools rather than a per-tool list of the arguments
to hold. The list came first and was wrong on its second day: `orderBy` was
missed on `drive.search`, which is exactly the silent resume the clause exists
to prevent, and a reviewer caught it rather than the code. A rule that names
every argument cannot be short by one, and the machinery that assembled four
near-identical sentences was more than the difference was worth. The cost is
that a caller is told to hold `maxResults` steady too, where Google would in
fact allow it to vary between pages; steady is safe, and one sentence that is
slightly over-strict beats four that can each go stale.

**Consequences:** A new paginated Google tool that ships a bare `pageToken`
fails `index.test.ts`, which asserts the set of tools exposing one and that each
describes it; extending that set is a deliberate edit rather than an omission.
A tool that starts sending a new caller-controlled parameter has to add it to
`GOOGLE_TOOL_ARGUMENT_BY_PARAMETER` or a rejection of it goes unnamed — the
quiet direction, and the one chosen deliberately over naming a key the tool
would refuse. The mapping is per tool rather than adapter-wide precisely
because `orderBy` means different things across two of them.

`maxLength: 2_000` on these cursors is now a measured bound rather than an
arbitrary one, with roughly four times the longest observed token; if a provider
cursor ever exceeded it, Rally would reject a *valid* token as its own
validation error and paging would stop dead at that page.

The presentation defect found in the same investigation is deliberately not
fixed here: two Drive-capable Google connections render byte-identical plugin
descriptions, because `connectorPluginPresentation` derives them from granted
scopes and never reads the connection's own `display_name`, which already
carries the account. A model choosing between them is choosing blind, and in the
same run it picked one that could not see the requested folder and got a 404
before it ever reached the 400s. That is a different subsystem in
`apps/api/src/services/integrations.ts` and wants its own change.

### 2026-09-03 — A series activity is built from its master

**What changed:** `pollCalendarChanges` reads the series master once per
changed series per poll (`events.get`, the same field set as the sync page
plus `recurrence`) and builds the `calendar.event_changed` activity from it,
keyed `calendar:<calendarId>:<master id>:series:<master updated>`. The activity
now carries the series' real start and end, `htmlLink`, location, a
`metadata.recurrence` rule, and each guest's series-level `responseStatus`. An
instance is classified against the master: `updated` after the master's is an
occurrence edited on its own, reported as that occurrence with its real times
on its own etag; `updated` at or before the master's is reported against the
master as it now stands. A master that cannot be read — 404, 410, or a body
whose `id` is not the one asked for — falls back to the representative-instance
activity of the previous entry, keyed on the instances' `updated` and carrying
only what every instance agrees on.

**Why:** The previous entry could only carry the title. The same identity is
re-emitted from chunks that see different instances, and the workspace refuses
a repeated identity whose payload differs, so the payload could hold nothing an
instance decides. That left the feed, the digests, and Suggested Work with "a
recurring event changed" and no time, link, or place, and left a cancelled
series titled "Untitled event" because stripped instances carry no summary.
Reading the master makes the payload a pure function of the master for a given
`updated`, which is one fixed record however the burst is chunked, and the
master is where the series' times, rule, and RSVPs actually live.

**Considered and rejected:** Deriving a canonical schedule from any one
instance — its wall-clock time of day and duration — which needs no fetch. An
exception whose time was overridden and whose `updated` the master edit also
bumped would then differ from its siblings, and which instance a chunk led with
would decide the payload again. Rewriting an instance's `htmlLink` into the
master's by re-encoding its `eid`: the encoding is undocumented. Keying the
stale-chunk case on the instances' own `updated` with the newer master's
content: two chunks of one edit would then disagree once the master moved.

**Consequences:** One extra request per changed series per poll, against a
150-item page; the master reads for a poll are sequential and the cost is
bounded by the number of distinct series in the page, which is small. The
classification assumes what the production bursts showed — that a series-wide
edit stamps every instance with the master's `updated` — so an instance whose
`updated` runs ahead of the master's is taken to be an occurrence edit. If
Google ever stamps instances later than the master, a series edit would be
reported per instance again; the symptom is the same burst this and the
previous entry describe, and the check is the master's `updated` against its
instances' in the poll response. Nothing per-chunk may reach the payload,
exactly as before: the master is the only source for a series activity, and a
representative instance is used only when there is no master at all.

Shipped in #541.

### 2026-09-02 — One edit to a recurring series is one activity

**What changed:** `pollCalendarChanges` now accumulates a poll's raw Calendar
items and collapses them before normalizing. An instance of a recurring event
is reported against its series, as one `calendar.event_changed` activity per
edit, keyed `calendar:<calendarId>:<master id>:series:<updated>` and pointing
`providerResourceId`, the entity key, and `metadata.recurringEventId` at the
master. The activity declares `metadata.seriesChange`, which is also a new
filter field on the type, and carries no instance start, end, or `htmlLink`, no
overriding location, and each guest without the per-occurrence
`responseStatus`. A cancelled series arrives stripped of `recurringEventId`, so
the master is recovered from the instance id's `<master>_<instance start>`
shape — only for a cancelled item, because reading a series out of any id that
merely ends that way would invent one for a one-off event. An occurrence edited on its own carries its own `updated` and so gets
its own activity for that edit.

**Why:** One edit to a shared weekly meeting produced 730
`calendar.event_changed` rows per Google connection, because `singleEvents=true`
returns every expanded instance and `normalizeCalendarActivity` keyed identity
on the etag, which every instance has its own of. Three members with personal
connections on the same meetings made that 2,190 activities per edit, and eight
edits in a day produced 18,149; deleting one series produced 1,452 cancelled
instances per connection. The feed, the digests, and every consumer downstream
were reading a thousand copies of one piece of news.

**Considered and rejected:** Dropping `singleEvents` from the change-sync
request, so Google returns the master once per series edit. Google's own
guidance is that every parameter other than `syncToken` must match the request
that minted the token, so changing it puts every stored token into undefined
behaviour and needs a forced re-baseline of every Google connection to be safe —
a migration, to fix a normalization bug. It would also leave the change stream
holding a master's `DTSTART` rather than any real occurrence.

Also rejected: fetching the master event for each collapsed group to fill in a
real start, end, and link. That is one extra request per changed series per
poll, and it introduces a second failure path for a cancelled series whose
master is already gone. The fields it would recover are not read by anything
today; no consumer reads `subject.start` on this type, and the ranking and
digest surfaces read the title and summary.

**Consequences:** Two constraints hold this together, and a later change that
breaks either reintroduces a bug rather than a rough edge.

The first is that nothing may classify an instance by what else shared its poll.
An earlier revision collapsed only groups of two or more, which read as a
conservative guard and was not: a burst outruns one poll, so a series whose
instances arrive one to a chunk was reported per instance, and the same edit
came out differently depending on where the page boundary fell.

The second is that the activity's content must be identical in every chunk. The
same identity is re-emitted on later polls and WorkspaceDO refuses a repeated
identity whose payload hash differs
(`connector_event_identity_reused_with_different_content`), which sends the
affected chunk to the dead-letter queue after the cursor has already advanced.
So the payload carries only what is the same for every occurrence of one edit,
and a per-instance or per-batch value must never be added to it — not an
instance count, not the occurrence's own times or link, and not a guest's
`responseStatus`, which is per-occurrence and rides into `sourceText` whole.
The title is the one field taken from a representative instance that an
exception could in principle override; a canonical one would need a fetch of the
master per changed series per poll, which is a request per series against a
150-item page.

That constraint is also why an item without a usable `updated` stays an
individual activity: it has no timestamp a later poll would arrive at again. An
automation filtering on `recurringEventId` now sees series-level events and can
separate them with `seriesChange`.

### 2026-09-02 — Every connector declares which of its strings cannot be empty

**What changed:** Across all seven adapters, the string parameters whose empty
value is not a value — pagination cursors, identifiers, handles, and date
filters — declare `minLength: 1` in the `inputSchema` the model reads. Six
executor parses that did not enforce what they declared now do: Linear's
`after`, Granola's `cursor` on both `list_notes` and `list_folders`, Gmail's
`threadId`, `gmail.search`'s `query`, and `calendar.list_events`'s `query`.
Content parameters are deliberately untouched, because `description: ""` on
`linear_update_issue` and `path: ""` on GitHub's `contents.list` are real
requests.

X is handled on both sides of its own empty cursor: its parse maps a received
`""` to absence, that spelling being one its API emits rather than one a model
invented, and its four paginated tools now report a last page as
`next_cursor: null` instead of the `""` that read to a model as "there is
another page" and sent it back to page one indefinitely.

**Why:** A run failed to file a Linear ticket after sending `after: ""` on
`linear_list_teams` and `linear_search_issues`. The declared schema said only
`{ "type": ["string", "null"], "maxLength": 500 }`, the executor's parse agreed,
and the blank cursor went out as the GraphQL argument; Linear rejected it with a
bare `Argument Validation Error` naming no field, and the model retried the same
arguments five times before giving up. The declaration is half of the repair —
the harness now drops a blanked optional argument whose schema says the empty
string is invalid, which it can only know if the schema says so
([`agent-tools.md`](agent-tools.md#1-fail-loud-never-silently-ignore-an-input)).

**Considered and rejected:** Guarding each provider call site the way Notion
already guarded its cursor, which fixes one connector per incident and leaves
the model an error to recover from rather than a call that works. Also rejected:
tightening the executor parses alone, which converts a provider error into a
Rally validation error and still costs the round trip.

**Consequences:** A connector adding a string parameter whose empty value is
meaningless must declare `minLength: 1` or the blank still reaches the provider;
for a parameter named like a cursor, `tool-argument-empty-strings.test.ts` walks
every registered connector and fails until it does. Adapters that derive
`inputSchema` from zod with `z.toJSONSchema`, as GitHub does, get the
declaration from the parse and cannot drift.

### 2026-09-02 — Every shipped connector gets public support coverage

**What changed:** The public Support Center now mirrors the product connector
catalog and publishes a dedicated page for Google, GitHub,
Granola, Linear, Notion, Slack, inbound webhooks, and Public X. Each page names
the supported connection modes, first recovery steps, and the provider details
that are safe to include in a support request.

**Why:** A generic Connections article could not explain the meaningful
differences between personal OAuth, workspace installations, selected-resource
access, administrator API keys, signed inbound webhooks, and Rally-managed
read-only retrieval. It also made the public support surface drift from the
connectors visible in desktop Settings.

**Considered and rejected:** One long connector page with anchored sections.
That would repeat the same information-architecture problem corrected in the
Trust Center and would give individual connectors no stable support URL.

**What a future change has to respect:** Adding or removing a connector in the
desktop catalog requires the same change in the public connector directory,
its support page, sitemap, build inputs, and cross-link test. Do not document
credentials or provider payloads as information a customer should email.

### 2026-09-01 — Watching a Google resource routes events, having never routed any

**What changed:** The Google manifest's activity types declare
`resourceRelationships`: the three Drive event types name the file they are
about, and `email.received` / `email.updated` name the mail thread.
`ConnectorResourceRelationshipSchema` gained `file` and `thread` to say it, in
both places the enum is written — `automation-evaluators.ts` and the duplicated
literal in `contracts/src/index.ts`.

**Why:** Google declares `supportsWatches: true` and declared no relationships,
so watching an attached Sheet passed the UI, wrote a watch row, drove polling,
and then routed nothing — for every Google resource anybody had ever watched.
The registration reconciler derives its evaluator set from the relationships, so
an empty declaration produces an empty set and no error anywhere. It is the
failure the rule sheet names: nothing errors, nothing arrives, nobody can tell
why.

**Considered and rejected:** Shipping the Drive relationships first and deferring
threads, on the grounds that the mail events' filter fields were not designed
with per-thread scoping in mind. They do not need to be — a relationship is not
a filter, it says which attached resource an event concerns — and following one
client thread is the more common want of the two, expressible today only as a
mailbox-wide trigger with filters that go stale when the subject line changes.

### 2026-09-01 — OAuth persists the initiating desktop's handoff grammar

**What changed:** Connector start advertises handoff version 2 in an additive
query field. The regional OAuth state stores either a versioned addressed return
or the legacy unaddressed return and every provider completion uses that stored
value. Pending reconciliation moved from Settings-local state to app-session
state.

**Why:** Returning the new addressed shape to an older initiating desktop could
be rejected or, with the earlier query grammar, silently applied to the active
workspace. Switching workspaces could also unmount and forget the pending poll.

**Considered and rejected:** A custom capability header. A new desktop reaching
an older API would fail that API's CORS preflight before it could return the safe
legacy callback; an unknown query field is ignored safely.

**Consequences:** New/new pairs return to the originating workspace; either side
being old uses the legacy callback. Unknown OAuth state remains explicitly
unaddressed and asks the member to restart from Connections.

Shipped in #464.

### 2026-09-01 — Connector completion stays with the workspace that started it

**What changed:** Every resolvable connector success, denial, and failure target
includes the OAuth state's regional workspace. Desktop completion activates that
workspace before cache refresh or messaging, and Settings polls a pending attempt
only while that workspace is active. Electron's provider-result classifier now
derives from the shared provider list, including Granola.

**Why:** OAuth state and connection writes were already correctly bound to
workspace A, but the native callback carried only a region. After a switch to B,
the renderer could refresh or poll B for A's result and cross-region callbacks
were rejected outright. Granola separately fell out of a hand-maintained desktop
provider list.

**Considered and rejected:** Rebinding to the active workspace, prompting for a
workspace after consent, and provider-specific callback fixes. OAuth already
records the unambiguous origin, and all three alternatives create either a second
authority or another list that can drift.

**Consequences:** Following a connector callback may switch the foreground
workspace. Unknown-state failures remain unaddressed and never guess. A connector
added to `ConnectorOAuthProviders` automatically participates in main-process
completion delivery, but its API flow must still use `connectorAttemptTarget`.

Shipped in #464.

### 2026-08-30 — Connector activity no longer produces Suggested context

**What changed:** The processing step now has no classifier or route into an
existing work stream. It runs deterministic automation/watch matching first,
uses WorkspaceDO's durable `claimed` witness even after delivery settlement,
offers only unclaimed activity to Suggested Work, and always projects the
activity log.

**Why:** Suggested context was removed rather than left as a dormant branch in
the shared activity consumer.

**Considered and rejected:** Keeping digestibility as a confidence prior for a
hidden classifier. Digestibility answers only whether a person wants an event
read back in a digest; no other product now interprets it.

**Consequences:** Connector manifests, watches, automations, activity logs, and
Suggested Work remain. The connector pipeline stores no context-card feedback.

### 2026-08-29 — External platforms receive saved turns, never model streams

**What changed:** External result delivery now has one connector-wide rule: a
fixed status signal may be live, but a reply or comment is posted only from a
canonical turn after it is saved. Terminal results use the exact named turn;
`needs_input` uses the saved open-elicitation turn. Slack no longer starts or
appends response streams; its connector API contract no longer exposes those
methods. The retained `chat.stopStream` method exists only to close placeholder
streams left by an older deployed version. Empty automation projections still
record suppressed receipts, and a named turn that is missing settles status
without a body while retaining a durable diagnostic.

**Why:** A Slack run completed at the model boundary but terminal settlement
could not hydrate its structured assistant turn ID through a UUID-only message
schema. The already-open provider stream therefore remained as an empty shell,
while retrying settlement never reached result delivery. More generally,
streaming partial model output to a provider creates a second visible transcript
whose partial writes cannot be retracted or reconciled with Rally's authority.

**Considered and rejected:** Keeping provider streaming and appending the whole
saved answer at the end. Opening the stream is already an externally visible
write before Rally has a saved answer, and a lost append response leaves an
ambiguous partial result. Also rejected: adapter-specific policy. Teams, Linear
comments, Slack, and later message connectors have the same authority boundary.

**What a future change has to respect:** Branch to a new external adapter only
after saved-turn hydration. With no saved turn, settle status and send no reply
body; do not leave a provider surface looking busy forever. Never expose a
provider streaming primitive merely because its API offers one.

### 2026-08-29 — OAuth attempts and webhook receipt claims become typed WorkspaceDO methods

**What changed:** The connector OAuth attempt lifecycle — start, abandon,
extend, lazy expiry, settlement, telemetry binding — and webhook receipt claims
moved from SQL statements through the workspace runtime facade to typed
WorkspaceDO methods (`workspace-connections-protocol.ts`,
`workspace-connections-storage.ts`). The receipt claim returns a
`claimed`/`duplicate` outcome from an `INSERT … RETURNING` witness and sweeps
the connection's expired receipts in the same transaction; an attempt's expiry
sweep and the read that reports it are one member-scoped transaction; a
finish's replay-convergence check runs in the same transaction as its
compare-and-set. The generic WorkspaceDO SQL port now refuses
`webhook_receipts` by name. `connector_connections`, `external_user_identities`
and the attempt-bind statement batched with a connection mutation stay on the
facade.

**Why:** The facade routes by table name and decides mutation outcomes from
workerd's physical `rowsWritten` counter — the mechanism behind the
notification-intent production incident, still live here: a receipt claim's
duplicate branch was `meta.changes === 0`, and an attempt settlement re-read
the row in a second round trip after a refused update. The conversion also
surfaced that nothing ever deleted expired `webhook_receipts` rows on the
Granola path — the rows carry `expires_at` and an index on it, but only
generic-webhook ingestion pruned, so a Granola connection's receipts grew
without bound in the object's storage. These tables are also credential-free,
which makes them the right first slice of this domain: the typed schemas carry
only handoff state and delivery identities, never ciphertext or a secret.

**Considered and rejected:** Converting `connector_connections` in the same
change. That table carries the AES-GCM credential envelope, is joined from
nearly every other domain in the facade-to-RPC stack, and its lifecycles
interlock with regional control-plane writes (`oauth_states`,
`connector_ingress_routes`, `audit_events`) and with the attempt-bind batch in
`persistConnectionMutation` that must stay atomic with a connection mutation.
Also rejected: refusing `connector_oauth_attempts` at the generic port — that
batch still reaches it generically, and refusing the table would break the
atomic pair. Also rejected: an unbounded receipt sweep, which is how this first
landed. The connections that would pay for it are exactly the ones the fix is
for — a Granola connection whose receipts were never pruned arrives at this
deploy with the whole backlog, and its first claim would have had to delete all
of it inside the claim's own transaction. If that transaction outruns the
request's budget the claim never commits, and every retried delivery re-attempts
the same oversized delete: a webhook path that cannot make progress, on the
connections where the fix mattered most. Also rejected: sweeping from the
workspace alarm instead, which decouples the drain from the deliveries that
create the rows and adds a scheduled path to reason about for a table that is
already visited on every claim.

**Consequences:** New attempt states or receipt semantics are added to the
protocol and storage together, with both sides parsing. The attempt-bind
statement in `persistConnectionMutation` must move in the same change that
converts `connector_connections`, and only then can `connector_oauth_attempts`
join `WORKSPACE_TYPED_RPC_ONLY_TABLES`. A redelivery whose receipt has expired
is now claimable again on every path — acceptable because provider replay
windows (minutes) end long before the shortest receipt lifetime (a day). The
sweep is bounded, and a future change must keep it so: the claim deletes the
incoming `(connection_id, signature_hash)` row unconditionally — without that
an expired row for the key being claimed answers `duplicate` forever, since the
outcome comes from a unique-index conflict — and then drains at most
`RECEIPT_SWEEP_BATCH` further expired rows, oldest first. That constant is the
bound the generic-webhook prune already shipped with, carried over rather than
re-chosen, so the cutover changes *which* connections get swept without changing
what one delivery pays. A backlog therefore drains over several deliveries
instead of one, which is the intended trade: the claim always commits. If a
connection's backlog is ever seen to outrun its delivery rate, raising the
constant is the change, and by then it is a decision with evidence rather than a
guess. The
pre-cutover branches in `ConnectionService.ingestWebhook`/`ingestGranolaWebhook`
still write `webhook_receipts` through plain regional SQL; they run only when
`WORKSPACE_DOS` is unbound and never reach the object.

### 2026-08-28 — One event engine serves automations and watched work streams

**What changed:** Connector adapters normalize manifest-declared events once.
WorkspaceDO accepts the canonical regional event; a later, leased processing
delivery then calls `matchExternalEventDestinations`, which evaluates typed
automation rules and exact watched-resource registrations from one candidate
index, applies the audience rule, writes one delivery row per match, and emits
identifiers-and-hashes-only Queue messages. Each destination rechecks its own
authority generation and lifecycle before admitting an occurrence. The D1 scans
that used to match automations and watches during processing are gone, along
with the "semantic matching after deterministic prefilters" step — the evaluator
grammar is closed and deterministic and there is no model in the path.
Separately, an automation's delivery destinations are now resolved inside
`AutomationAgent` rather than through `resolveFrozenDeliveryIdentity`.

**Why:** Direct watch scans and a separate automation evaluator were two
matchers over the same events, each with its own idea of retries, deduplication,
and privacy — and the older of them read D1 rows whose authority had already
moved. One index, one delivery ledger, and one receipt state machine is the
smallest thing both destinations can share while each keeps its own admission.

**Considered and rejected:** Matching inside `ingestConnectorEvent`, at the
moment the canonical event commits. Ingest is the idempotency boundary for
provider and Queue replay and has to stay cheap; matching there would run the
whole registration index inside the transaction that deduplicates a webhook
retry. Sending the event body to each destination instead of an id, which would
put normalized provider content in the DLQ when a delivery exhausts.

**Consequences:** A new connector extends its manifest and evaluator fixtures; it
does not add another routing engine, and a false predicate never invokes
inference. A restricted activity's audience is decided once, in the matcher, so
nothing downstream re-derives it. And adding a personal delivery surface now
means registering it in `AutomationAgent.resolveDeliveryTargets` and
`AutomationRunDeliveryTargetV1Schema` as well as the shared registries — the
automation and digest paths state the same eligibility rules twice, in two
places, and a change to those rules has to be made in both.

### 2026-08-28 — Resource re-fetch follows the adapter capability

**What changed:** Resource API, work-stream detail, and live origin-attachment
projections now expose `refreshSupported`, derived from whether the deployed
connector adapter implements `hydrateResource`. The desktop uses that field to
decide whether to offer **Refresh from source**.

**Why:** A connection and its watch state do not imply hydration support. Slack
can own a connected source resource without implementing `hydrateResource`, so
the previous UI gate offered a request the hydrate endpoint could only refuse.

**Considered and rejected:** Maintaining a provider allowlist in the desktop or
deriving the answer from `watchStatus`. Both duplicate the adapter's own
declaration and can drift independently from the route that executes refresh.

**What a future change has to respect:** `hydrateResource` remains the source of
truth. Every person-facing resource projection must carry the server-computed
capability, and compatibility parsing must fail closed when an older server
omits it.

### 2026-08-28 — A routed watch activity names what went stale

**What changed:** The watch-routed arm now names the resources an activity
matched — in the message text by title, and in its structured content by id and
alias.

**Why:** The message said that something changed at the provider, not which of
a work stream's attached documents did — and a re-fetch, which is what makes a
stale snapshot into history rather than a loss, cannot be asked for by someone
who cannot identify the resource.

**Considered and rejected:** Re-fetching on the notification. That is
synchronization by another name, and it spends provider quota on changes nobody
asked about.

**Consequences:** Both the added line and the structured field are present only
for the watch-routed arm, where a resource was actually matched. The text
carries titles because the transcript renders text and no surface reads the
structured field yet. Nothing in this path performs a re-fetch.
### 2026-08-26 — Connector-event processing uses native Queue retry

**What changed:** After canonical WorkspaceDO ingress, new connector events send
an ID-only process pointer back to the existing regional `ACTIVITY_QUEUE`.
Queue deliveries claim/load and settle through typed WorkspaceDO RPCs; native
per-message retry and the existing regional DLQ replace creation of one
Cloudflare Workflow per event. The pointer's stable internal owner is correlation
identity; WorkspaceDO issues a fresh expiring lease for each acquisition and
fences settlement on that lease. Queue delivery attempts remain independent
transport telemetry. The Workflow class and binding remain deployed only so
instances created before cutover can finish. WorkspaceDO accepts the frozen
pre-cutover claim and settlement payloads, translates them into the current
lease protocol internally, and projects claim results back to the old strict
response shape. A process pointer whose product attempt is older than the
authoritative attempt is terminally acknowledged rather than retried into the
DLQ; only an active unexpired Queue lease receives a delayed Queue retry.
WorkspaceDO persists whether the active claimant is Queue or Workflow. A
draining Workflow claim never expires into Queue takeover because its processing
step can make several independently timed retry attempts; a concurrent cutover
pointer is acknowledged and the Workflow either settles success or enqueues its
own failed redrive.

**Why:** The Queue, Workflow, and WorkspaceDO were maintaining overlapping
retry and terminal ledgers for one processing callback. That duplication added
an external Workflow-instance identifier boundary and made transport drain look
more meaningful than it was. WorkspaceDO is already the product authority and
Queue already owns durable redelivery.

**Considered and rejected:** Splitting the shared activity Queue was rejected
because Rally has no capacity or isolation pressure that justifies additional
resources; strict message kinds and terminal logs provide flow identity.
Retaining new per-event Workflows was rejected because their only meaningful
step is the Queue-shaped callback. Using Cloudflare's Queue message ID as the
owner was rejected because its stability across redelivery is not part of this
contract. Retrying the original content-bearing ingress message for processing
was rejected because it would retain normalized provider content through every
retry and in the DLQ while still requiring the authoritative WorkspaceDO load.

**What a future change has to respect:** New connector events must never create
`CONNECTOR_EVENT_WORKFLOW`. Keep the single regional Queue, canonical
WorkspaceDO state, individual ack/retry, stable owner, authority-issued expiring
lease, lease-fenced settlement, and content-free terminal logs. Do not use Queue
delivery count as the product attempt fence: a pointer can begin at the legacy
attempt ceiling. Until the drain completes, an exact same-Workflow claim replay
must remain idempotent because the claim RPC can commit before the Workflow
persists its step result. The legacy request and response wire shapes must also
remain accepted: those Workflow instances execute versioned code whose strict
schemas cannot adopt a new RPC contract after creation. Preserve the stored
orchestrator discriminator too: `NULL` on an active claim means a pre-migration
Workflow because Queue claims did not exist when that row could have been
written. Remove that adapter, the legacy Workflow binding, discriminator
compatibility, and the physical `workflow_instance_id` column only after live
pre-cutover instances are proven drained.

### 2026-08-25 — Every connector operation is observable at two layers, and delivery has an observable terminal outcome

**What changed:** The connector registry now wraps every adapter surface with
shared structured lifecycle logging and wraps every configured provider fetch
with a second transport-level log. Adapter starts are `debug`, successful
terminal outcomes are `info`, expected refusals and degraded health are `warn`,
and unexpected failures or provider 5xx/transport failures are `error`.
Authorization, refresh, revoke, webhook verification and normalization,
polling, dynamic-tool discovery, agent protocol execution, hydration, origin
resolution, tool validation and execution, repair, and health checks all pass
through the shared wrapper. The provider layer records origin, method, status,
and duration independently. ID-shaped tool arguments and normalized provider
resource IDs are retained as correlation fields; Slack timestamp identifiers
use an explicit field-name allowlist, and non-ID arguments are not retained.
Observer failures are swallowed so diagnostics cannot alter connector delivery.

On the delivery side, connector-event Workflow instance IDs now use a branded,
Cloudflare-validated `wf_<sha256>` value derived from the typed connector-event
identity tuple. Provider and Rally identifiers influence only the digest, so
they cannot alter the external ID's alphabet or length. Polling, regional
enqueue, Queue admission, WorkspaceDO ingestion/claim/settlement, and Workflow
completion now emit correlated structured outcomes, including replay, busy,
redrive, exhaustion, and partial-stream poll results.

**Why:** Delivery-pipeline logs can prove that an event reached a Workflow or
durable outbox, but they cannot distinguish an adapter decision from an HTTP
refusal or show whether a connector branch was entered at all. Instrumenting
both boundaries makes the redundancy intentional: when one layer stops before
the other, that absence is itself useful evidence.

The delivery pipeline could not prove where an event finished either. An
invalid instance ID could make every Google poll appear to drain from the
shared Queue while no processing Workflow was ever created. Queue depth proved
only that the consumer acknowledged or exhausted a message; it did not prove
where a connector event finished or whether a partial Google stream advanced
its cursor.

**Considered and rejected:** Logging only individual adapters was rejected
because the next connector would begin uninstrumented and hosted MCP/shared HTTP
paths would remain blind. Logging full URLs, provider messages, inputs, outputs,
or health text was rejected because those values can carry connector content or
credentials. Pure Rally and provider identifiers remain present because they
are the stable correlation keys needed to follow one operation.

Treating Queue drain as delivery evidence, logging only thrown exceptions, and
removing deterministic Workflow IDs were also rejected. They respectively hide
downstream state, leave expected skip/replay branches invisible, or weaken
idempotency at the Workflow boundary.

**What a future change has to respect:** A connector added to
`createConnectorRegistry` must receive both wrappers. New adapter surfaces must
join the shared lifecycle wrapper rather than relying on call-site logging.
Keep starts at `debug` and terminal results at a production-visible level, keep
expected versus unexpected failure levels distinct, and never let observer
behavior or logging content affect the provider call. Each connector boundary
must log one content-free terminal or deferred outcome with stable correlation
IDs. A new branch must not acknowledge, replay, skip, or settle an event
without making that decision queryable, and Workflow instance IDs must remain
deterministic and valid under Cloudflare's ID grammar.

### 2026-08-25 — Connection management makes scope and consequences explicit

**What changed:** Desktop Settings separates personal and workspace credentials, defaults the provider catalog to scopes that remain unconnected, explains each connect scope in a tooltip, and requires confirmation before refresh or deletion. Refresh stays administrator-only in the desktop for both scopes; workspace deletion is likewise hidden from members to match the regional API's modification boundary. Pending webhook creation or secret rotation holds the dialog open so its one-time secret cannot be lost.

**Why:** A single mixed credential list obscured who could use a connection, while provider-level filtering hid an uninstalled personal or workspace scope as soon as the other scope existed. Immediate refresh and delete controls also made disruptive credential changes too easy to trigger, and closing a pending webhook request could strand the only copy of a newly issued secret.

**Considered and rejected:** Keeping one table with scope subtitles, treating any provider connection as fully connected, and exposing personal refresh to non-admin members were rejected. The first two retain the ambiguity this UI is meant to remove; the last conflicts with the product requirement that desktop refresh controls are administrator-only, even though the regional API still authorizes the owner of a personal connection.

**What a future change has to respect:** “Not connected” is scope-aware: a dual-scope provider remains actionable until every scope the current viewer can install has a matching connection. Any mutation that returns a one-time credential must keep its result surface open until that credential is shown, and modal-owned failures must render inside the modal rather than behind its overlay.

### 2026-08-24 — Public activity fans into private admission contexts, and a resource watch cannot broaden a restricted activity

**What changed:** When deterministic and contextual routes decline a
workspace-visible connector event, Suggested Work enqueues it once for every
active member rather than once for the workspace. Each window is personal, while
the event retains its workspace source audience for later routing authorization.

In the other direction, before injecting a restricted connector activity
through an explicit resource watch, the consumer now asks the authoritative
main SubstreamAgent for the watched work stream's current audience. The target
must be personal and every active participant must already be in the activity
audience. Workspace-visible activity is unchanged.

**Why:** Every member may read a workspace event, and each may have a private
work stream where it belongs. A workspace-only directory read could not consider
those authorized private targets.

The watch check had the opposite defect: it admitted a target when any one
permitted activity reader could read it. That allowed one person's private
connector activity to be copied into a workspace stream, or into a private
stream shared with somebody outside the activity audience.

**Considered and rejected:** For the fan-out, a single inference over the union
of private directories, or duplicating both workspace and user batches. Those
respectively disclose private titles across members or create competing
suggestions from the same event.

For the watch check, checking only the connection owner, retaining the
any-reader test, or reading legacy D1 participants. None proves the required
subset relationship, and WorkspaceDO's directory projection may lag the work
stream that owns participant state.

**What a future change has to respect:** Fan-out may duplicate public evidence;
it must never merge users' private contexts. Source visibility and admission
window visibility remain separate facts. With `N` active members this path costs
`N` enqueue RPCs and may yield `N` independent admissions; there is no
cross-member dedupe because the private contexts are intentionally disjoint.
Moving content is authorized from source audience to target audience, not by
one actor's ability to see both. A target may narrow an activity audience; it
may never broaden it.

### 2026-08-21 — A conversation too large to be a room opens to the workspace

**What changed:** `connectorWorkstreamScope` takes the conversation's member
count and a threshold the calling connector states, and returns `workspace`
above it whatever the conversation's privacy says. Slack's threshold is
`SLACK_CONVERSATION_WORKSPACE_SCOPE_THRESHOLD`, 50. Past it,
`slackConversationAudience` returns the count and skips resolving identities
altogether, so such a work stream seats nobody.

**Why:** Removing Rally's participant caps made the roster the whole
conversation, and that exposed the size question the caps had been hiding. A
private channel of sixty is not a room anybody experiences as private, and a
participant list standing in for it is a large copy of a membership Slack
already maintains and will keep changing. Widening the scope is the deliberate
cost: such a work stream is readable by workspace members who are not in that
conversation, which the participant model would not have done. It is taken
because at that size a work stream nobody can find is the worse failure, and
because the alternative — hundreds of participant rows per channel-born work
stream — is a cost paid on every create for a room nobody treats as one.

**Considered and rejected:** A shared default threshold. What counts as "too
many to be a room" is a fact about a provider's conversations, so a default
would quietly become Slack's number applied to every other connector; the
parameter is required instead, and the type system asks each connector for it.
Seating the roster anyway above the threshold was also rejected — the work
stream is already readable by everyone the seating would name, so the rows buy
nothing and the `users.info` fan-out behind them is the expensive half of
reading a roster.

**Consequences:** A private Slack channel larger than 50 now produces a work
stream readable by the whole Rally workspace. That is broader than the channel,
and it is the one place in this area where Rally deliberately shows more than
the provider does. Anyone in it may narrow it from the sidebar, which then
leaves it with no participants — a channel-born work stream above the threshold
has no room to fall back to, and whoever narrows it should add the people they
mean. A failed listing reports a zero count and falls back to the conversation's
privacy rather than its size.

### 2026-08-21 — The room is seated from the conversation, whatever the scope says

**What changed:** `createSlackWorkstreamSession` reads the conversation roster
for every scope, where it read one only when the work stream was coming out
`personal`. A public channel's thread now seats its resolved members as
participants instead of being created with an empty room. The participant caps
came off with it: `CreateWorkstreamRequestSchema.participantUserIds` no longer
carries `.max(25)` and the object's initialize input no longer carries
`.max(100)`, so the whole roster lands in the create.

**Why:** Scope and membership answer different questions, and the change that
made work streams private by default made it matter which. Rally's visibility
rule and Slack's are not the same system, and Slack's is the one that knows what
the person meant: somebody who summons Rally in a channel means the people in
that channel to be in the work stream. Seating only the private branch encoded
the opposite assumption — that Rally's scope could stand in for the provider's
audience — and produced a work stream *visible* to a channel while belonging to
nobody in it, which empties itself the moment anyone narrows the scope.

**Considered and rejected:** Truncating the roster to the old cap and admitting
the remainder immediately after the create. It was built that way first and
taken back out: it left Rally deciding that some of the people in a
conversation are not in the room, which is the provider's fact to state, and it
bought that for a bound the create had no reason to impose — the cap was sized
for a person naming the people they are starting work with, not for a channel.
Note the old cap did not degrade when a conversation exceeded it; it failed the
create with a validation error. Seating the whole roster only *after* the create
was rejected separately: a private work stream that exists for even a moment
with a partial participant list is one its own channel cannot fully read.

**Consequences:** The wire now accepts an unbounded `participantUserIds`. Every
id in it is still checked against active workspace membership before a
participant row is written, so it cannot name a stranger; what is no longer
bounded is how many ids one authenticated member may send, and that check is a
single `IN (...)` over the list. If that is ever worth a ceiling, it wants one
sized against the largest real conversation rather than the picker.

A public-channel create now costs one `conversations.members`
call and the identity resolution behind it. That is on Slack ingress, which
already runs inside the acknowledgement's `waitUntil`, so nobody is waiting on a
keystroke for it; it is bounded by `SLACK_AUDIENCE_MEMBER_LIMIT` and fails to an
empty roster rather than an error. Membership is still only ever admitted, never
revoked, so a channel that shrinks does not shrink the work stream.

### 2026-08-21 — A private conversation's work stream is private again

**What changed:** The scope `connectorWorkstreamScope` computes now reaches the
work stream it is computed for. `WorkstreamService.create` passed its input to
`WorkstreamObjectCreationService`, which parses it with
`CreateWorkstreamRequestSchema` — not `.strict()`, so `scope` was silently
stripped — and the object then hardcoded `'workspace'` into its authoritative
row. The scope is now an explicit input to `initialize`, and a work stream with
nothing said about it is born `personal` rather than `workspace`.

**Why:** Since the Durable Object cutover, a work stream summoned from a
private Slack channel or a DM by a member with an *account link* was created
readable by the whole workspace. The rule this section states was written and
enforced at the ingress; the enforcement was being dropped one layer below it,
where nothing looked. Making private the default is what stops the next such
omission from publishing anything: only the branch that means `workspace` — the
public channel, whose room is the channel rather than a participant list — now
has to say so.

**Consequences:** The unlinked-member path
(`SlackWorkspaceWorkstreamService`) was already carrying the scope correctly
and is unchanged. Existing work streams keep the scope they were created with,
including the ones this bug made public; a member of one moves it back from the
sidebar's right-click menu. See
[`data-model.md`](data-model.md#2026-08-21--a-work-stream-is-born-private).

### 2026-08-20 — The OAuth attempt table regains the telemetry columns its service reads

**What changed:** `WorkspaceDO` schema version 2 adds
`telemetry_event_version`, `telemetry_scope`, `telemetry_capability_count`, and
`telemetry_reconnect` to `connector_oauth_attempts`. Version 1 carried only
`telemetry_operation_id`.

**Why:** `connection-service.ts` writes and reads all five columns together,
and `connector_oauth_attempts` is one of the tables the workspace runtime
router sends to the object. The object's table was therefore narrower than the
statements routed to it — every OAuth attempt query naming those columns fails
against an opened region, and the maintenance import, which passes each D1
column through by name, cannot land the rows at all (it quarantined generation
7 of the Global cutover with `no column named telemetry_capability_count`).
The columns are live product telemetry, so they are added to the object rather
than dropped at import.

**Considered and rejected:** Filtering the four columns out in the importer's
row mapper — it would have unblocked the campaign while leaving the opened
region unable to run the service's own queries, converting a loud import
failure into a silent runtime one. Editing schema version 1 in place was never
an option: its statements are hashed, and changing them strands every object
that already applied it.
### 2026-08-19 — Audience admission runs under the work stream's authority

**What changed:** `admitConnectorAudience` routes its participant reads and
upserts through `workstreamExecutionEnvironment`, so after the cutover they
execute in the work stream's Durable Object instead of regional D1. The roster
read that used to join `users` inside one statement is split: participant rows
come from the object, user profiles from the regional `users` table, merged in
code. A regression test drives the phase machine to `durable_object_open` with
the D1 fences armed and asserts the admission lands in the object.

**Why:** The function still wrote `workstream_participants` through the
workspace-wrapped `env.DB`, whose router does not claim work-stream tables, so
post-cutover the upsert fell through to fenced D1 and aborted — refusing every
linked member speaking in a connector conversation. The fence did its job: it
turned a silent dual-authority write into a loud failure; this change moves the
write to the authority the fence was pointing at.

**Considered and rejected:** Adding `workstream_participants` to the workspace
router's allowlist (wrong object — participant rows live with the work stream,
not the workspace), and relaxing the fence for this one writer (re-opens the
dual-authority hole the cutover closed).

### 2026-08-18 — Connector product state moves into WorkspaceDO, and ingress routing is migration-tested and repairable

**What changed:** WorkspaceDO now owns connection credentials/configuration,
refresh leases/cursors/health, external identities, connection-scoped webhook
replay receipts, OAuth attempt status, workspace-local Slack
policy/sessions/jobs, and the canonical normalized event. Provider ingress uses
opaque global routing metadata, a regional Queue carrying the bounded
normalized event, typed WorkspaceDO RPC, then a deterministic Workflow. Legacy
D1 activity bodies are imported and scrubbed during cutover instead of retained
as a live handoff.

The D1 ingress directory's backfill and insert/update triggers are covered for
provider-user fallbacks and disabled status. The WorkspaceDO writer derives the
same minimal route shape in one helper. Slack workspace claim audits commit
explicitly to regional D1 after the local session claim and repair the same
audit on claim replay.

**Why:** Connection and normalized-event rows each belong to exactly one
workspace. Keeping either in D1 made the routing plane a product authority and
made credential refresh/event processing span databases unnecessarily.

Provider ingress must still discover a workspace before addressing its DO, but
connector product state is no longer in D1. An implicit subquery across the two
authorities could route the audit mutation into the object and lose the
regional record.

**Considered and rejected:** Keeping connector product rows in D1,
unbounded/raw provider payloads in Queue, D1 product projections, and an event
row shared by installations in multiple workspaces. Those alternatives weaken
retry/residency boundaries or cross workspace authorization. Also rejected:
copying full configuration into the route, and batching local claim state with
the regional audit.

**Consequences:** D1 retains only opaque routing fields and the provider/setup
receipts and routes needed before the workspace is known. A raw provider
delivery may fan out to multiple installed workspaces, but each resulting
normalized event is independently authorized and stored in one WorkspaceDO. A
committed claim may temporarily precede its audit during an outage, but replay
repairs the deterministic audit ID without changing product authority.

### 2026-08-18 — Connector events become workspace-local durable authority

**What changed:** Provider-facing Workers fan a raw delivery into separately
authorized workspace targets, a regional Queue admits each normalized event to
exactly one WorkspaceDO, and a deterministic Cloudflare Workflow owns routing,
automation, digest projection, and suggested-work processing. WorkspaceDO now
stores the complete normalized event and its replay/claim/settlement ledger.
Post-cutover ingestion never stages the normalized body in D1.

**Why:** Connector activity belongs to one workspace and is neither shared nor
queried across workspace boundaries. Keeping its durable body in regional D1
made the routing/control database a second product-data authority and left the
Queue callback responsible for long-running inference and fan-out work.

**Considered and rejected:** An ID-only Queue message backed by a D1 body row,
direct ingress-to-DO delivery without Queue buffering, and a shared event row
for one provider delivery. The first keeps D1 on the product path, the second
loses regional buffering/redrive, and the third crosses workspace visibility.
The accepted Queue contract contains only the bounded normalized event; raw
provider content remains in R2.

**Consequences:** The Queue message is self-contained for WorkspaceDO admission,
and the event must commit there before its Workflow exists. Event replay uses
provider/dedupe identity, not Queue order. Suggested-work windows, opportunities,
provenance, rankings, and user resolutions are also WorkspaceDO-local. New
downstream readers must load that event or materialize their own bounded local
product snapshot rather than introducing a D1 handoff.

### 2026-08-15 — Conversation audiences resolve in bulk and announce admissions

**What changed:** Conversation rosters now resolve known identities in one D1 query. Slack enriches
only unresolved members, at six profile requests at a time under one ten-second deadline. A member
admitted by a later connector message also emits `participant_added` after the durable write.

**Why:** A 200-member private conversation previously risked one Slack profile request and several
D1 reads per member, which could exhaust provider or Worker limits before the prompt started.
Writing a participant without the room event also left an already-open People rail behind D1.

**Considered and rejected:** Treating the 200-member roster cap as sufficient bounding, and relying
on a later work-stream snapshot to repair connected clients. Neither bounds concurrent external
work nor preserves the participant service's existing live-update contract.

**Consequences:** Known mappings cost no provider profile calls; email enrichment remains best
effort within the shared deadline. Consumers must continue to handle replayed `participant_added`
events idempotently.
### 2026-08-13 — Repository policy stays authoritative through drift and recovery

**What changed:** A present malformed GitHub repository policy now denies all
repositories while retaining its revision for repair; only a wholly absent
policy receives the legacy all-repositories default. Authorization resolves the
provider's immutable repository ID before applying name-based defaults, and
renamed repositories retain their configured override. Disabled connections
never perform settings discovery and revoke selected Terminal rows, while
recoverable `error` and `needs_reconnect` rows may be tried and revalidated at
GitHub. Policy writes update only their JSON subtree and commit mounted
Terminal-credential invalidation in one D1 batch.

**Why:** Review found four ways cached or mutable state could outrank the durable
administrator choice: malformed JSON failed open, a rename missed a read-only
override, a disabled credential could still enumerate repositories, and a
Worker interruption between policy persistence and token invalidation could
leave a broader credential mounted, and a whole-document rewrite could erase
connector metadata written concurrently.

**Considered and rejected:** Treating every non-healthy observation as a durable
revocation, adding a repository-ID lint rule, and introducing another policy
store. Connector status already defines only `disabled` as an intentional stop;
the existing provider metadata and transactional regional rows are enough.

**Consequences:** Repository-aware operations must resolve immutable identity
before falling back to an all-repositories default. Settings repair must preserve
the malformed row's revision, and future credential caches must be invalidated
in the same transaction as any policy downgrade.

### 2026-08-13 — Repository policy becomes connector-owned model context, and full access means native repository CLI access

**What changed:** GitHub connections now persist a revisioned all-or-selected
repository policy with read-only or full remote access, expose a dynamic
connector Settings child page, filter repository discovery, return effective
access to the model, and reject remote writes outside that policy. When no
repository is named, the plugin tells the model to search and choose from
context instead of delegating a chooser to the participant.

Terminal maps connector `full_access` to a short-lived single-repository GitHub
App token inside the Daytona sandbox, while `read_only` remains technically
enforced by token permissions. The harness prepares the work-stream branch and
tells the model to stay on it.

**Why:** Repository selection was presented as an interruption even when the
model already had installation-scoped discovery and enough context to make the
choice. At the same time, App installation access was too coarse to express
that a repository could be inspected and edited locally without authorizing a
remote push or pull request.

On the sandbox side, models already know Git and GitHub CLI, PRs routinely
receive multiple commits, and GitHub offers no branch-scoped installation
token. A second publish authorization parser and custom write path added
friction without expressing a provider primitive that exists.

**Considered and rejected:** Keeping one participant chooser per work stream,
and equating read-only with an immutable sandbox checkout. The former stranded
runs and made ordinary code tasks interactive; the latter prevented useful
local analysis and edits even though only the remote repository needed the
narrower boundary. Also rejected: a smart-HTTP/API proxy and a per-push
participant gate. Connector Settings is the explicit durable access decision.

**Consequences:** New GitHub operations must resolve the current policy and,
for explicitly configured repositories, revalidate the immutable repository ID.
Every model-visible repository listing must carry effective access. A future
connector with settings can reuse the dynamic navigation contract, but must own
its own typed settings endpoint and authorization semantics. `full_access` is
repository-wide at the provider. Policy updates must invalidate Terminal
credential freshness before another command, and model guidance must continue
to name the prepared branch behavior.

### 2026-08-13 — Connector adoption separates intent, established configuration, health, and activity

**What changed:** Added closed setup, action, health-transition, and activity-
ingest events across OAuth, API-key, direct, and webhook connectors. Terminal
outcomes are emitted by the regional service; activity is measured only after
the shared ingestion boundary classifies it.

**Why:** A connection row alone cannot show failed or denied setup, reconnect
pressure, stale-health recovery, or whether a configured connector ever produces
usable activity.

**Considered and rejected:** Provider payload logging, provider account IDs,
credential/scope arrays, client-reported OAuth success, and treating a health
check as activity. They expose content or report an observation at the wrong
authority.

**Consequences:** Connector dashboards can separate acquisition, establishment,
maintenance, and value delivery. New adapters must use the canonical connector
taxonomy and add no free-form provider fields to product telemetry.
### 2026-08-12 — Code-only tool refinements remain argument errors

**What changed:** `ConnectorAdapter` can expose a pure `validateToolInput`
classifier. Every current static connector tool with a Zod refinement supplies
its owning schema, and the host carries that classifier onto the `HarnessTool`
wrapper without attaching it to dynamic hosted-MCP definitions.

**Why:** JSON Schema cannot represent arbitrary Zod refinement callbacks. An
identity-only GitHub issue update therefore satisfied the model-visible
structural schema, then its correct “at least one field” rejection was labelled
as downstream data validation. For a non-idempotent write, the same
misclassification also made it impossible to distinguish a pre-provider input
rejection from an invalid response after the provider may have committed.

**Considered and rejected:** Treating every custom Zod issue as input. Provider
responses can have their own refinements, so that heuristic would blame the
model for malformed external data. Static validators also stay off dynamic MCP
tools because applying a code-authored snapshot to a live provider surface would
reintroduce the schema drift that dynamic discovery avoids.

**Consequences:** A connector adding a refined tool input must register the same
schema with `validateToolInput`; execution still parses independently as its
trust boundary. Valid input followed by response-validation failure on a
`record_before_execute` write is conservatively ambiguous and cannot be retried.

### 2026-08-12 — GitHub repository choice and code conclusions require evidence

**What changed:** GitHub repository listing now returns complete page metadata,
orders installation-authorized repositories by profile pin and recent activity,
and has a separate name search. The connector can list directories and narrowed
recursive trees. Its plugin instructions require an explicit repository choice
when results are ambiguous and prohibit a “no discrepancies” conclusion until a
code file has actually been read. Numeric tree offsets inherit the shared
harness normalization and validation recovery.

**Why:** The previous list returned only the current page and its local count,
offered no name search or tree discovery, and left provider order untouched. A
model therefore had neither the information to know more repositories existed
nor a bounded way to locate code before reading a filename it already knew. The
prompt required a provider read before saying information was unavailable, but
metadata alone satisfied that wording, so it did not prevent choosing the first
plausible repository or reporting no discrepancy without inspecting code.

**Considered and rejected:** GitHub's global repository search can return public
repositories outside the App installation, so using it would widen the
connection's authorized surface. Downloading one full recursive tree and then
filtering a requested directory was also rejected because the narrower argument
would not reduce provider cost or avoid GitHub's tree truncation. Per-tool
numeric coercion was rejected because the harness already owns a stricter exact
numeric-string rule across every tool.

**Consequences:** Listing/search scan at most 1,000 installation repositories and
say when that bound makes a search count incomplete. `hasMore` never promises an
empty page beyond that scan; provider truncation is a separate signal. Profile
pins are a ranking hint: failure to read them leaves repository listing
available and sets `pinnedSortAvailable` false. Directory responses at GitHub's
1,000-entry cap are conservatively inexact. A path-scoped recursive tree costs
one non-recursive lookup per path segment before the bounded subtree read.
Models must distinguish “I could not verify” from “there are no discrepancies.”

### 2026-08-12 — Speculative work-stream routing was paused

**What changed:** Activity ingestion now skips contextual routing and sends
unclaimed connector activity directly to suggested-work batching. Watches,
automation triggers, activity projection, and the connector digestibility
contract are unchanged. The retained routing module owns the shared pause switch
and its re-enable requirements.

**Why:** Suggested context was too noisy and not tuned well enough to interrupt
an active work stream. Dropping unclaimed activity was rejected because the home
screen remains a less intrusive place to propose work; deleting digestibility or
routing history was rejected because both remain useful to a later tuning pass.

### 2026-08-12 — Personal MCP tools are discovered, not guessed; Notion becomes a bot-owned workspace capability and its historical bot grants move with their real identity

**What changed:** Personal Granola and Slack plugins now pass through their
servers' live tool surfaces, and Notion gained a personal connection through its
official hosted MCP server. The shared abstraction is documented in
[`hosted-mcp-connectors.md`](hosted-mcp-connectors.md). Notion's existing public
integration remains the workspace bot path.

That public-integration path now declares only workspace scope. Its OAuth
callback still records the Notion user who approved the install, but the Rally
connection has no user owner, tools require the workspace execution principal,
and webhook activity is workspace-scoped with no target user. The administrator
gate protects both the workspace start and callback, while the same card
separately offers personal MCP.

Migration `0072_notion_connection_scope_split.sql` converts pre-MCP Notion
personal rows to workspace scope while leaving rows granted
`notion.personal.mcp` personal, so legacy public-integration rows are promoted
by a capability-aware migration rather than interpreted as personal MCP
credentials. The Notion adapter is always registered for the personal flow;
public-integration credentials are optional configuration needed only when
workspace authorization or bot-token operations run.

**Why:** The static Granola and Slack definitions represented one response at
one point in time, not a contract the MCP server was required to preserve. They
could drift in either direction and made adding Notion an invitation to repeat
provider-specific transport and OAuth code.

The Notion provider grant installs a Rally bot into a selected part of a Notion
workspace, and Notion attributes the resulting edits and comments to that bot.
Treating the human who clicked Allow as the runtime owner made an organization
capability appear personal, hid it from teammates, and sent shared change
activity only to that person.

Existing rows hold public-integration bot credentials, not hosted-MCP OAuth
metadata. Routing every `scope = personal` row through MCP made them fail
refresh and disappear from the tool surface, while their stale owner also
blocked a real personal connection. The capability dialect is deterministic
evidence of which identity each row contains.

**Considered and rejected:** Keeping Notion workspace-only after establishing
that its public integration acts as a bot. That correctly describes the public
API connection but leaves no member-attributed path; the official hosted MCP
server is that separate path and should not be conflated with the bot install.
Keeping static tool allowlists as a safety boundary was also rejected because
Rally's capability grant, principal checks, confirmation policy, and receipts
already provide that boundary without inventing a provider catalog.

Reusing Notion's `owner=user` parameter as Rally's scope signal was rejected
because it describes who approves public OAuth, not who the installed bot acts
as. Leaving old rows personal was rejected because the credential is an
installed bot regardless of the Rally label; treating that label as privacy
would both misstate provider authority and break the row once personal scope
acquired the distinct hosted-MCP credential dialect. Disabling the old rows or
requiring every member to reconnect was rejected as well: that would discard a
valid shared bot grant and leave its already registered webhook route orphaned.
Keeping the public client secret mandatory for the whole adapter was also
rejected because personal DCR does not use it.

**Consequences:** The workspace-only Notion decision still governs the
public-integration mode, but no longer the connector as a whole. Historical
public-integration rows are migrated to that workspace mode; the migration
deliberately broadens legacy rows to the workspace semantics their provider
bot always had. Future MCP providers must use live discovery and preserve a
static trusted catalog/policy boundary; they must not paste a current
`tools/list` response into `agentPlugin.tools`. Operators can offer personal
Notion MCP without configuring a public integration, although workspace
connect attempts then fail with an explicit configuration error.

Shipped in the pull request for this change.

### 2026-08-12 — Unsigned webhook setup is a connector pattern, not a Notion exception

**What changed:** The connector contract now names the narrow class of provider
handshakes in which an unsigned challenge delivers the secret that will sign
future webhooks. Such a connector uses a short-lived nonce stored only as a hash,
atomically binds its first challenge to that nonce, encrypts the delivered secret,
and gives an operator the plaintext only through a local no-output handoff when a
provider UI requires it. Notion is the reference implementation. Existing GitHub,
Linear, Slack, Granola, and generic-webhook connectors are explicitly outside the
pattern because their signing secrets are configured, returned during authenticated
endpoint creation, or generated by Rally rather than arriving in an unsigned
operator-mediated challenge.

**Why:** Treating the Notion fix as an isolated runbook detail would leave the next
provider with the same handshake free to repeat both failed designs: a reusable
query credential that the edge records before application code runs, or logging the
future signing secret so an operator can recover it. The security property belongs
to the connector architecture because it is determined by the provider protocol,
not by Notion's product name.

**Considered and rejected:** Requiring the nonce-and-local-copy workflow for every
webhook connector. That would add state and ceremony where a provider already has
a safe configured or authenticated secret exchange, without reducing risk. Also
rejected: introducing a generic setup-challenge table and adapter facet now. One
provider uses the flow today; keeping its schema and commands provider-specific
avoids freezing an abstraction before a second protocol reveals what is actually
shared.

**Consequences:** A future connector author must classify the provider's webhook
setup before implementation. If an unsigned delivered value becomes the signing
secret, the one-time token-bound flow is mandatory and logging is forbidden. If
the provider supplies or accepts a secret through an authenticated configuration
path, its existing setup remains sufficient. A second matching provider is the
point to evaluate a shared adapter facet and storage model, while retaining the
same observability and plaintext-handoff boundaries.

### 2026-08-12 — A work stream belongs to the conversation it started in, not to one member

**What changed:** Two connector-wide rules moved into `connector-workstream-audience.ts`. A work
stream started from a provider conversation now maps that conversation onto the existing
work-stream scope — public channel to `workspace`, anything else to `personal` — and a private
one is seated with the conversation's members, resolved through the actor mapping this document
already owned. Anybody
in the conversation may continue it, and each message runs under the authority of whoever sent
it: an account-linked member's own, the workspace principal for everyone else. Slack's
per-thread pin, its claim button, and `claimWorkspaceSession` are gone.

**Why:** The pin answered a real question with the wrong scope. Whose credentials a run spends
has to be settled — that part was right and is kept, per message — but it does not require the
*conversation* to have an owner, and making it one produced a public-channel thread that
refused everybody except the first member who happened to be linked. In production that meant a
workspace owner asking Rally for deep research and being told the thread was already running
with another member's personal authority, and a member Rally knew by verified email being told
an unlinked Slack member cannot continue it — both in channel, both with no way forward but
starting a new task and losing the thread. Claiming was the sanctioned escape hatch and nobody
used it: it moved the whole conversation's authority to the claimer rather than answering the
one message they had just sent.

**Considered and rejected:** Letting a `verified_email` match authorize a run as that member,
which would have made every one of those refusals disappear. It inverts the tier ordering this
document spends a section establishing — a provider profile address can belong to somebody other
than the member that identity is linked to, and a run spends real credentials — so the match
seats somebody in the room and credits them, and nothing more. Also rejected: keeping the pin
and adding a "take over" button next to the refusal. It is the claim flow again with better
copy, and it still asks a conversation to have one owner.

**Consequences:** A private conversation's roster is read once, at creation, bounded at 200
members and best-effort: `conversations.members` needs `groups:read`, which an installation that
has not reconnected does not have, and an admitted prompt must not be dropped over a roster. The
cost of failing is a smaller starting room, because every member is seated on their own first
reply anyway. Membership is admitted and never revoked, so leaving the provider conversation
does not remove somebody from the work stream — removal stays a decision a person makes.
`slack_agent_sessions.linked_user_id` and `execution_scope` are written as fixed compatibility
values for the previous Worker; nothing in the new Worker reads them. A later migration may
drop them after this code has shipped everywhere.

### 2026-08-12 — A connector says where the things it produces live

**What changed:** `ConnectorAdapter.origin` is a new optional capability: given a
`ConnectorOriginLocator` — a normalized activity, or a provider-native agent
session the host does not parse — an adapter returns a `ConnectorOriginResource`
naming the place. `describeConnectorOrigin` in the connector base is the single
entry point, `connectorOriginFromActivity` is the derivation every connector gets
without code, and a described `resourceType` is checked against the manifest's
`resourceTypes`. Slack is the first implementation. What the host does with the
answer is [`workstream-origin-attachments.md`](workstream-origin-attachments.md).

**Why:** The behaviour shipped first as Slack-specific code in an API service —
the host knew Slack's channel-versus-thread rule, Slack's title wording, and
Slack's permalink endpoint. That shape has one predictable outcome: the second
connector to need it copies the first, and the third copies whichever it found.
The knowledge belongs to the adapter, and putting it there is also what let the
manifest check exist at all — a host cannot tell a connector's real resource type
from a typo.

**Considered and rejected:** A parallel manifest declaration
(`originResourceTypes`, or a `supportsOrigin` flag). `resourceTypes` already
enumerates what a connector produces, and a second list is a second thing to keep
in step with the first. Requiring `describe` to handle every locator kind — that
would make each adapter reimplement the activity derivation to say "the default
is fine"; returning null and falling through says it once.

**Consequences:** A connector added later records origins for its activities by
existing, with nothing to remember. Implementing `origin` takes on one
obligation: the `resourceType` you name must be in your manifest, or
`describeConnectorOrigin` throws `invalid_configuration` and the work stream is
created without an origin. `resolveCanonicalUrl` joins the list of entry points
that take `AuthorizedConnectorConnection`, so it is reached through the credential
door like any other provider call.

### 2026-08-12 — A stored status stopped being able to refuse work

**What changed:** Every query that consulted `connector_connections.status` to decide whether to *attempt* something now admits any row except `disabled` — the credential coordinator's lease, reload and persistence, the credential door itself, provider webhook routing, Slack events and interactions, identity linking and its challenge, automation delivery and the plugin catalogue automations are built against, resource hydration, scheduled polls, resource watches, and the identity directory. A refresh the provider honours sets the row back to `healthy` and clears `error_json`. `withAuthorizedConnection` lost its `rotatable` gate, so a diagnostic path refreshes and rotates like any other caller. `redriveReauthorizedIngress` re-queues Slack ingress jobs that failed on authorization once their connection has been written again.

**Why:** A Slack workspace connection spent sixteen hours refusing work it could have done. A scheduled refresh found the installation missing `reactions:read`, a bot scope Rally began requiring after that workspace installed it, and marked the row `needs_reconnect` — correctly. From that moment the mark, not the grant, failed every request: `ensureFreshConnectorCredentials` filtered its lease claim and its credential reload on `status = 'healthy'`, so each Slack event was refused with `Connector authorization is unavailable` without one call being made to Slack. The refusal then overwrote `error_json` with its own generic `unauthorized`, destroying the accurate `missing_scopes: reactions:read` diagnosis hours after the fact and leaving an operator reading a reason that named nothing. Every work-stream link shared in Slack during the window lost its unfurl permanently, because Slack reports `link_shared` once and never redelivered it. The status is a record of one past moment and nothing re-checks it, so a stale one is indistinguishable from a current one — and the failure it caused was strictly larger than the failure it described.

**Considered and rejected:** Keeping the gate and shortening the staleness by re-probing more often. That trades a permanent wrong answer for a briefer one while adding provider load, and it still refuses real requests during whatever window remains. Also rejected: dropping `disabled` from the exception, for symmetry. `disabled` is not a belief about the provider — it is a person's decision, and it is the one status that is authoritative. Also rejected: relaxing the writes that *set* `needs_reconnect`. Those deliberately still require `status = 'healthy'`, so the first and most specific diagnosis survives; re-marking on every later attempt is precisely how the scope failure was erased.

**Consequences:** A connection the database believes is broken now reaches its provider, which means a genuinely dead grant costs one provider round trip per request instead of none. That is the price of never refusing a request that would have succeeded, and it is deliberate. Marking still happens, the desktop still asks for a reconnect, and the badge still appears — none of that was the defect. What a future change must respect: a status may be consulted to *report*, to *rank*, or to decide whether to *warn*, but never to decide whether to try. If a new gate is needed, gate on `disabled`.

A second rule falls out of the first and is easy to miss: **relaxing a read gate makes every write behind it hot.** Writes that had been nearly unreachable for a marked row — the door's `markConnectorNeedsReconnect`, Slack's `markSlackReconnectRequired`, the mention service's marker, resource hydration's marker, and `commitConnectorCursor`'s `error_json` — now run on every request against one. Each was re-narrowed to `status = 'healthy'` so the first, most specific diagnosis survives; without that, this change would have *recreated* the erasure it was written to end, on a far hotter path. And healing was removed from the refresh coordinator entirely: a token exchange proves the grant is alive, not that its scopes are sufficient, so healing there would have cleared a `missing_scopes` verdict within one token lifetime and reported a connection as working while every scoped call kept failing. Healing belongs to reauthorization and to an explicit connection test, which get an answer covering the whole question.

Shipped in #113.

### 2026-08-11 — What was fixed for Google was fixed for every connector, including Google

**What changed:** Connector descriptors declare `searchAliases` and end their catalog description with the sentence naming when to load them. A shared `connectorCapabilityRefused` — used by all seven connectors — answers a refusal with the capabilities of this plugin's own tools intersected with the grant. Linear's argument schemas are strict, its `create_issue` takes every field `update_issue` takes, its issue search matches descriptions as well as titles, and it gained `list_workflow_states`. Notion's plugin message states that its search is title-only and names the two ways past it.

**Why:** An audit of the six non-Google connectors, run against [`agent-tools.md`](agent-tools.md) after two rounds of the same work on Google, found that almost every improvement from those rounds had been applied to the connector in front of us and to nothing else. `connectorPluginPresentation` opened with `if (connectorType !== "google") return fallback`, so six connectors were reachable in the catalog only by their own product name — the exact shape of the recorded failure where a run with no connector tools in its visible list asked a person for something a plugin could have looked up. Linear carried the canonical silent-drop trap from the tool guidance, live: `update_issue` accepted `stateId` and `dueDate`, `create_issue` accepted neither, and no schema was strict, so a model that generalized from one to the other had the fields dropped and was told the issue was created.

**Considered and rejected:** Special-casing each connector inside the host, the way Google's capability-gated presentation is built. Aliases and the load-me sentence are properties of the connector, not of the host's rendering, and putting them on the descriptor is what makes the next connector arrive with them instead of needing a seventh branch. Google's presentation stays in the host because it composes from *granted scopes*, which a static descriptor cannot see — and for the same reason its branches merge in only the brand identifiers, never the descriptor's full alias list: that list is the union of every Google product, so a mail-only credential would match "spreadsheet" and send a run to load a plugin that cannot help it.

Also rejected: answering a refusal with the connection's raw grants. A connection carries control-plane capabilities that back no tool (`slack.agent`, `slack.notifications.write`), and naming one in answer to "what can I do instead?" is worse than the bare refusal it replaced.

**Consequences:** The transcript-prose guard walks the registry rather than a list, and the Linear strictness test asserts on a *successful* provider response so that removing `.strict()` fails it — an earlier version threw from the fetcher and passed either way. Both properties are the point of those tests; a rewrite that reintroduces a hand-maintained tool list or a throwing fixture silently stops testing anything. The same applies to the catalog-discovery suite: it derives its expectations from the registry, and writing it is what exposed that Google's own combined mail-and-files branch never said when to load it.

Shipped in #100.

### 2026-08-11 — A refused refresh reaches the row, whatever the adapter remembered to say

**What changed:** Slack and Granola now state `reconnectRequired: true` when their token endpoint refuses a refresh, GitHub stopped stating it for token errors that name Rally's own configuration, and the credential coordinator no longer treats a missing verdict as "leave the row alone" — with nothing stated it classifies the failure itself from the provider's OAuth code, and an unclassifiable refusal marks. A second registry-driven suite in `apps/api/test/connector-credential-freshness.test.ts` revokes every adapter's grant and asserts the row is marked.

**Why:** Tightening the coordinator's test to require `details.reconnectRequired === true` — the change directly above, made to stop nagging members over `invalid_client` — silently removed marking for the adapters that never set the flag. Slack raises a bare `unauthorized` for `token_revoked`, `invalid_refresh_token`, and `account_inactive`; Granola's token exchange raised a bare 401. A revoked grant on either left the connection `healthy` forever: every run dropped the plugin with no explanation, nothing prompted the member, and only a manual connection test recovered it. That is the exact failure this whole area exists to prevent, reintroduced by the fix for its opposite.

**Considered and rejected:** Fixing only the adapters, as the review proposed. It repairs today's six and leaves the seventh — the connector nobody has written yet — to strand its first revoked grant, because the failure of omission is invisible: nothing breaks, a row just stops being marked. Making the host's default the loud one means a forgotten verdict costs a member an unnecessary reconnect prompt instead of a silently dead connection, and the conformance suite catches it either way.

**What a future change has to respect:** The two ways to be wrong here are not symmetric, and every default in this area is set from that asymmetry. Do not "tidy" the fallback into requiring an explicit flag; that reads as stricter and is in fact the silent failure. An adapter that genuinely knows a failure is not the grant's fault says `reconnectRequired: false`, which the host believes.

### 2026-08-11 — Revalidation between turns stopped calling providers, and health checks stopped writing

**What changed:** `reauthorizePlugin` now says why it is asking. X's health check also stopped reading the account balance. An `activation` — a `load_plugin`, a restored hint, the initial preload — still checks all the way to the provider. A `continuation`, the check before every inference, is answered from Rally's own records alone. Granola's webhook re-enable moved out of `healthCheck` into a new optional `repair` that only an explicit connection test calls. Linear and Notion classify a refused refresh by the provider's OAuth error code instead of its HTTP status, and the three remaining proactive expiry refreshes go through the host's serialized rotation.

**Why:** `reauthorizeActive` runs before every model call, and with eight model iterations a run that meant up to eight provider round trips per active connection purely to re-establish authority. A workspace Granola connection spent two to three API calls per check and could `PATCH` its webhook endpoint each time, so a single run could make ~24 provider calls and repeat a write, none of it answering a question Rally could not answer itself: every authority this check can withdraw — grant, membership, work-stream state, stored health — is in D1. Separately, `isRefreshRejected` treated any 400/403 as a revoked grant, so a malformed request of ours or a proxy's 403 told a member to reconnect an account that still worked.

**Considered and rejected:** Caching the health result for the run. It keeps the provider round trip on the first turn of every run and adds a staleness window with no clear expiry, while still not distinguishing the two questions being asked. Splitting the occasions says plainly which check needs what. Also rejected: dropping the between-turn check to a fixed interval, which makes revocation latency depend on turn timing rather than on anything meaningful.

X's balance reading went the same way and for the same reason: it sampled one of two spendable balances at activation to predict whether a later call could be paid for, and got it wrong for every account whose credit sat in the other one. **Consequences:** A credential the provider has since refused is no longer noticed between turns — it surfaces on the next tool call, where `withProviderReauthorization` recovers or reports it. That is the right place: the check that costs a provider call now happens where a provider call was going to happen anyway. An adapter that needs to restore provider state declares `repair` rather than folding the write into `healthCheck`. And an adapter classifying a token-endpoint failure must read `details.providerError`; status alone is not enough to tell a dead grant from our own bad request.

Shipped on `claude/granola-authorization-issue-e5taks`.

### 2026-08-11 — Credential freshness became a property of the connection, not a step each caller repeats

**What changed:** Every adapter entry point that authenticates to a provider now takes an `AuthorizedConnectorConnection`, a branded type with exactly one producer — the host's credential door, which refreshes before handing it over. Adapters recover from a credential the provider refuses mid-call through one shared helper, and that recovery rotates under the same D1 lease as the expiry-driven refresh. Plugin revalidation answers with three verdicts instead of a boolean.

**Why:** A Granola personal connection was loadable for about five minutes after it was connected and never again. `load_plugin` revalidation health-checked the connection without refreshing it first, so Granola's MCP access token — the shortest-lived credential Rally holds — was presented stale, the provider answered 401, and a bare `catch { return false }` reported that to the run as `plugin_not_authorized`. Resource hydration had the identical hole, invisible only because Google's adapter privately retried its own 401s. The refresh was a free function sitting beside the thing that needed it, so every call site was a fresh chance to omit it, and three of six omitted it. Two later reviews of the fix found two more instances of the same shape: three adapters still carrying private reactive-refresh copies that bypassed the lease, and a health verdict of "reconnect required" that no longer reached D1, leaving the desktop showing a connection healthy that every run had already found unusable.

**Considered and rejected:** Fixing the call sites and adding a test per connector. That is what the code already relied on — each caller remembering — and it had just failed three times in a row; a new connector would have been free to fail the same way on day one. Also rejected: a lint rule requiring a refresh before any `adapter.*` call. It is checkable but still a rule about a convention, it cannot see through indirection, and it decays. The type system and a registry-driven conformance suite cannot be forgotten.

**Consequences:** `ConnectorConnectionContext` can no longer be handed to `executeTool`, `healthCheck`, `hydrateResource`, `poll`, `pollStream`, or `revoke` — obtain the branded type from `withAuthorizedConnection`, and expect ESLint to refuse a direct import of the minting function anywhere else. A connector added later is enrolled in the conformance suite by existing, so it fails on day one if it does not recover from a refused credential; an adapter whose health check legitimately presents no bearer declares that in the fixture table rather than passing quietly. What counts as a refusal is stated per adapter and must never be inferred from the `unauthorized` code alone, which adapters also raise for policy failures that never reached a provider. A health check must take the caller's signal rather than timing itself, because reauthorization runs inside a Workflow step where a non-disposable `AbortSignal.timeout` holds the invocation open. And a verdict must never be derived from a swallowed exception: failing to verify an authorization is not a denial, and only a denial may be reported to a run as one.

Shipped in #91.

### 2026-08-11 — Declaring an activity type means saying whether a person should hear about it

**What changed:** `ConnectorActivityTriggerDescriptor` carries a required
`digestible`, and `defineConnectorActivityTriggers` takes the event types as a
`{ digestible, operational }` partition rather than a flat list. A polling
activity stream declares `digestible` too, and may only ever withhold — an
activity reaches a digest when its event type says so *and* its stream agrees.
Every registered connector is classified; the verdicts and their reasons are in
[`connector-digestibility.md`](connector-digestibility.md), which this document
owns.

**Why:** A scheduled digest read the activity log directly, and the log could not
tell a connector's news from its machinery. GitHub reports two events per check
run and three per workflow run, so the first digest for a real workspace covered
seventeen minutes of one morning and was 84% continuous integration. The
judgement of which is which exists in exactly one place — the person adding the
event type to a manifest — and it was never being asked for.

**Considered and rejected:** A single `digestible: boolean` field on a flat list
of event types. It would have been quieter to write, and it has no state meaning
"nobody decided": a new event type would default to something, and whichever
default was chosen would be wrong for most connectors. Two lists have no
default, so adding an event type is answering the question. Also rejected:
letting a stream's declaration grant digestibility as well as withhold it, which
makes two sources of truth that can disagree, in a direction that ends in
somebody's inbox.

**Consequences:** Adding an activity type is now a compile error until it is
classified, in both the manifest and
[`connector-digestibility.md`](connector-digestibility.md) — `digestibility-doc.test.ts`
enforces the second. Everything unknown is withheld: an unregistered connector,
a dropped event type, an activity older than the declaration. That is deliberate
and one-directional, but it means a misconfigured region withholds everything
rather than failing loudly, which is why `activityIsDigestible` logs anything
that is not an ordinary unregistered-connector error. The reasoning behind
everything in this document before this entry is not recorded, and was not
reconstructed.

Shipped in #93.
