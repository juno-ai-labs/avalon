# Connector architecture

Connectors are typed adapters behind a registry. A manifest declares OAuth needs, supported personal/workspace scopes, activity and resource types, tools, polling, webhooks, and watches. The adapter owns provider protocol details; Rally owns tenancy, execution principals, persistence, retries, schedules, and audit.

The desktop shows **Reconnect required** only for `needs_reconnect`. Generic
`error` states, such as a failed background poll, display as healthy because
they do not establish that authorization needs renewing. `disabled` remains
distinct. The stored polling diagnosis is retained for investigation.

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
Adjacent repeated presentations of the same connector and scope collapse to the
newest durable row, while an intervening conversation row keeps a later request
as a separate occasion.

While the card has not observed `connected`, it follows the active connections
query in the conversation surface. OAuth completion publishes the workspace
socket's `connector_connections` topic, which invalidates that query and makes
the card become **Connected** without polling or relying on application focus. The
card latches that success: a historical card does not turn back into a recovery
action if the provider later revokes the grant; a new agent state read owns that
later decision.

## Where the code lives

| Path | Responsibility |
| --- | --- |
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

## How it works

### Authorization model

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

The Connections tables show numeric counts under the Tools heading using `GET /connections/:id/tool-count`.
The visible-connection authorization check runs before counting. Static connectors
count agent tools matching the connection's grants and scope; dynamic connectors
read their live inventory through the normal credential-refresh boundary, including
any server tool policy and the same connection-prefixed name validation used
at agent activation. Tool inventory reads share the existing 20-second Settings MCP
deadline, composed with the caller’s cancellation signal. Each row loads independently so a slow provider does not
hold up the table. Counts share the connection list’s five-second freshness window to avoid duplicate
provider calls on an immediate reveal, then refresh when Settings regains focus. A failed inventory
displays “Unavailable”, including after an earlier successful read, never a stale
count or a fabricated zero. Saving an MCP tool policy invalidates the count,
including if the user returns to Connections while the save is pending. The Tools
column remains visible in narrow Settings windows. Disabled connections show a dash
and do not request an inventory.

### Credential freshness

Every adapter entry point that authenticates to a provider — `executeTool`, `healthCheck`, `hydrateResource`, `poll`, `pollingActivity.pollStream`, and `revoke` — takes an `AuthorizedConnectorConnection` rather than a `ConnectorConnectionContext`. The difference is a brand that cannot be produced by writing an object literal, because the symbol keying it is declared in `packages/connectors/src/types.ts` and never exported. Refreshing an expiring credential before calling a provider is therefore not a step a caller can forget: it is a value a caller cannot otherwise obtain.

`withAuthorizedConnection` in `apps/api/src/services/connector-connection-access.ts` is the one door that produces one, and ESLint pins the import that mints the brand to that module. Around the operation it owns the three duties that used to be stacked by hand at each call site: refreshing through `ensureFreshConnectorCredentials`, persisting credentials the adapter rotated in place, and marking a connection `needs_reconnect` when the provider refuses the authorization. Stacking them by hand is what produced the defect this design replaces — `load_plugin` revalidation and resource hydration each reached a provider with a credential nobody had refreshed, and a Granola personal connection, whose MCP access token is the shortest-lived credential Rally holds, became unloadable a few minutes after it was connected while the connections screen still showed it healthy.

The claim is scoped to adapter entry points. A few host paths need only a fresh token rather than a connection to hand an adapter — `slack-agent-service.ts`, `slack-unfurl-refresh.ts`, and `slack-notification-service.ts` each call `ensureFreshConnectorCredentials` directly to read a bot token — and the brand correctly does not apply to them. They get freshness, but not the mid-call recovery below, because they are not making a call an adapter would recover.

Rotation is available to every connection a person has not disabled. The coordinator's lease claim, its credential reload, and the write that stores a rotated credential all admit any row except `disabled`, so a connection this database believes is broken is refreshed and rotated exactly like one it believes is fine, and the provider gets to say whether the belief was still true. A refresh the provider honours also clears the belief: the same write sets the row back to `healthy` and drops its `error_json`, because a provider that just accepted the refresh token has answered the question the status was guessing at. See the section below for why.

Freshness at the door is necessary but not sufficient, because a credential can be revoked or expire while a call is already in flight. `withProviderReauthorization` in `provider-utils.ts` is the shared recovery: a provider that refuses the credential gets one refresh and one repeat of the call, and a second refusal is raised as the real one. Adapters must route their authenticated provider calls through it rather than carrying a private copy, and must not report a first rejection as a revoked grant.

Two things about that recovery are easy to get wrong, so neither is left to the caller. **What counts as a refusal is provider-specific and is never inferred from the `unauthorized` code alone** — adapters raise that for policy and configuration failures that never reached the provider, and spending a single-use refresh token on one buys a retry that fails identically. Each adapter states its own vocabulary through `isProviderCredentialRejection`, which additionally admits only errors carrying provider response details: Granola matches a 401 from its MCP transport and not a 403, Slack matches `token_expired` and not the settled answers around it, Google matches the two reasons a new access token resolves. **And the rotation itself is serialized by the host**, not performed beside the coordinator: the door hands the adapter a `rotateCredentials` that claims the same WorkspaceDO-local lease, so two calls refused at the same moment cannot each redeem a rotating refresh token and leave the loser marking a connection `needs_reconnect` that its sibling had just rotated successfully. A caller that finds the stored credentials already changed adopts them instead of redeeming over them.

Two adapter obligations sit alongside that. **A health check answers a question and must not write.** Reauthorization calls it on every plugin activation, so a read-shaped call that quietly repairs provider state does so on that cadence; an adapter with state worth restoring — Granola's webhook endpoint, which stops delivering when disabled — declares `repair`, which only an explicit connection test invokes. A repair never fails the test, and its outcome is reported in the test result either way, because a connection whose delivery is still broken must not read the same as one that was fixed. The health check reports the same condition without failing on it: the authorization is sound and every read tool works, so failing would take a usable connection out of every run to describe a problem only the test can fix. **And a token-endpoint failure is classified by the provider's error code, not its status.** `isRevokedGrantError` treats `invalid_grant`, `expired_token`, and `invalid_token` as a dead grant and everything else the provider names as Rally's problem, because OAuth reports a revoked grant and our own malformed request with the same HTTP 400 — and marking a member's working connection `needs_reconnect` over our bug is the worse of those two mistakes. `providerJsonResponse` carries the code through as `details.providerError`, read from `error` or `code` and from either nested, since Notion keys its token-endpoint envelope differently from the OAuth spec. When a provider names nothing at all the original status test stands: an unclassifiable failure that leaves a dead connection reporting healthy, prompting nobody while every call fails, is worse than one that asks for a reconnect that was not needed.

Both halves are held to account by `connector-credential-freshness.test.ts` — see
[Testing](#testing).

### Stored status is a belief, not a gate

`connector_connections.status` records what Rally observed the last time it looked. It is not a fact about the grant, and nothing re-checks it: a row marked `needs_reconnect` at 08:00 says exactly as much at midnight, whether or not the credential was repaired in between. **A belief must never be the reason Rally declines to attempt something a provider is asking it to do.** If an incoming request can be answered, answer it. The provider's response is the only thing that is current, and it is what decides the outcome.

There is one exception, and it is a different kind of value. `disabled` is a person's decision, so it is authoritative and it is honoured everywhere. Every other status — `healthy`, `error`, `needs_reconnect` — is a guess about the past. Query for `status <> 'disabled'`, never `status = 'healthy'`, wherever the row is being consulted to decide whether to *try*.

That applies to the whole inbound surface, not merely to tool calls: provider webhooks, Slack events and interactions, identity linking, automation delivery, resource hydration, scheduled polls, and the plugin catalogue an automation is built against. It applies to writes as much as reads — a credential an adapter rotated must be storable on a row the database believes is broken, since that rotation is very often the thing that fixes it.

*This rule was written after a Slack workspace connection spent sixteen hours refusing work it could have done. A scheduled refresh found the installation missing a bot scope Rally had begun requiring after the workspace installed it, and marked the row `needs_reconnect` — correctly. From then on the mark, not the grant, was what failed every request: the refresh coordinator filtered its lease and its credential reload on `status = 'healthy'`, so each new Slack event was refused with `Connector authorization is unavailable` without a single call being made to Slack. The refusal then overwrote `error_json` with its own generic reason, erasing the accurate `missing_scopes: reactions:read` diagnosis hours after the fact. Every work-stream link shared in Slack during that window lost its unfurl permanently, because Slack reports `link_shared` exactly once and never redelivered it. Nothing in the sequence after the first mark involved Slack's opinion at all.*

Three consequences follow, and each is load-bearing:

- **Marking is still allowed; refusing to try is not.** A provider that genuinely refuses still marks the row, and the desktop still asks for a reconnect. What changed is that the mark no longer prevents the next attempt from reaching the provider.
- **A mark records the first, most specific diagnosis.** The writes that set `needs_reconnect` deliberately still filter on `status = 'healthy'`, so a row that is already marked keeps the verdict that explains why. Re-marking on every later attempt is what replaced a precise scope failure with a bare `unauthorized`.
- **Success heals.** Any path that gets a real answer from the provider clears the stale belief rather than leaving it for a member to resolve by hand.

Recovery is part of the contract too. A durable job that failed on authorization may be classified non-retryable — that is correct while a grant is dead — but something has to lift the ceiling once the connection is reauthorized, or the outage becomes permanent for every request that arrived during it. `redriveReauthorizedIngress` is the Slack example: a job whose connection has been written since the job last failed is re-queued, which is self-limiting because a job that fails again stamps itself newer than the connection.

### Actor identity and work-stream attribution

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
   `<team>:<user>` for Slack, the organization for Linear.
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

A connector that can hand a finished digest to a specific person declares `userDelivery` in its manifest: the `targetType` stored on the digest destination, the label and one-line description the digest settings screen shows, and `requiresPersonalIdentityLink`. Nothing about which providers can deliver is written into the API or the client — declaring this is what puts a connection in the digest's destination list, and a connector that declares nothing is never offered. The scheduled digest ([`digests.md`](digests.md)) is the one consumer. It used to serve personal automation results as well; automations no longer have destinations of their own — a run sends its result with the connector tools it holds, inside the loop — so a connector that starts declaring a surface becomes a digest destination without the digest changing.

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

- Gmail: `google_gmail_read_profile`, `google_gmail_search`, `google_gmail_find_contacts`, `google_gmail_read_thread`, `google_gmail_read_message`, `google_gmail_create_draft`, and `google_gmail_send`. `google_gmail_read_profile` answers which account is connected — the address it sends from, which is also what `me` matches in a search operator, with its message and thread totals. It exists so the account holder's own address is read rather than inferred from a signature or a From header, which are somebody's claim about the account rather than the account. It needs no scope beyond the existing Gmail read grant. Search returns each hit's sender, recipients, subject, date, labels, snippet, and RFC `Message-ID` by hydrating the metadata headers behind the bare identifiers Gmail's list endpoint returns, so a result is answerable without a read per hit and a threaded reply has the `inReplyTo` value `google_gmail_create_draft` requires. `google_gmail_find_contacts` resolves a person's name to ranked candidate addresses by scanning the address headers of prior correspondence, excluding Spam and Trash so a spoofed message cannot become a sourced address, each returned with the message it was drawn from; it needs no People API scope, excludes the authorized mailbox's own address, and returns an empty list rather than a guess when nothing matches — carrying a `reason` of `no_messages_matched` or `no_address_matched_name` and a `hint` in its output, since a tool result's `summary` never reaches the model. Gmail message and thread identifiers are both bare hex and cannot be told apart at the schema boundary, so `google_gmail_read_message` and `google_gmail_read_thread` translate the provider's 404 into a `wrong_id_family` failure that names which of a search hit's two identifiers belongs where. `google_gmail_create_draft` returns a `webUrl` alongside its id. A draft or message body is delivered as `text/plain` exactly as written — `serializeEmail` builds no alternative part — so the descriptor's system message, the capability-gated Google presentation, and the `body` parameter's own description all say to write plain text rather than Markdown, which would otherwise reach the recipient as `#` and `**`.
- Calendar: `google_calendar_list_calendars`, `google_calendar_list_events`, `google_calendar_read_event`, `google_calendar_create_event`, and `google_calendar_update_event`. Event tools accept a calendar ID, `primary`, or a calendar's **name**, which is resolved against the account's calendar list — a name matching two calendars is an `ambiguous_calendar_name` failure listing both rather than a guess — and otherwise use the configured calendar, which defaults to primary. An event ID that looks like a calendar address is rejected as `wrong_id_family` at the boundary. Scheduled activity polling still follows the configured calendar.

  A relative change carries each existing guest across whole rather than rebuilding them from an address, so `responseStatus`, `optional`, `displayName`, and a room's `resource` flag survive an addition; re-sending bare addresses would reset every RSVP and re-invite everyone. The read is uncapped and an `attendeesOmitted` response is refused rather than patched from, because `maxAttendees` returns only the participant past its cap rather than a prefix — a capped read is how a large event loses its guest list. Resolving a calendar by name needs the connection's calendar read capability, and says so rather than failing as an opaque provider error.

  Attendee changes are stated relatively. Google's event PATCH replaces the whole `attendees` array, so `google_calendar_update_event` takes `addAttendeeEmails` and `removeAttendeeEmails`, which it applies to the event's current guest list after reading it, and `replaceAllAttendeeEmails` for the rare case of setting the list outright. The create-shaped `attendeeEmails` is deliberately absent from the update schema: reaching for it fails the strict parse instead of silently deleting everyone who was already invited. Any attendee change emails everyone remaining on the event, and creating an event with attendees sends real invitations — both tools say so in their descriptions.
- Drive: `google_drive_search`, `google_drive_get_metadata`, `google_drive_download`, and `google_drive_export`. Search matches a plain-text `query` against file **names and indexed contents** — it is not a Drive query expression, so an operator written into it is matched literally — and narrows through its own `fileType` (named as a person would: `document`, `spreadsheet`, `pdf`, …), `modifiedAfter`, and `orderBy` parameters rather than through query syntax. A name-only search made a request for what a document *says* come back empty, which the plugin message then licensed reporting as the content not existing.
- Docs: `google_docs_read_document`, `google_docs_create_document`, `google_docs_append_text`, and `google_docs_replace_text`.
- Sheets: `google_sheets_read_spreadsheet`, `google_sheets_read_values`, `google_sheets_create_spreadsheet`, `google_sheets_update_values`, and `google_sheets_append_values`.

Every tool that returns something a person can open returns it as **`webUrl`** — Gmail threads and drafts, calendar events, Drive files, and created Docs and Sheets alike — rather than the four provider-shaped names those surfaces use natively. A Workspace file id is the same shape whatever it addresses, so any Docs or Sheets call the provider refuses — reads and writes alike, not only the two document readers — is re-checked against Drive's MIME type and, where they disagree, fails as `wrong_id_family` naming the canonical tool that does accept it; the check needs the connection's Drive read capability and is skipped without it, and never replaces the original failure with one of its own. `google_sheets_read_values` returns what the sheet displays by default and accepts `valueRenderOption: "UNFORMATTED_VALUE"` for numbers and serial dates that can be computed with.

Docs and Sheets operations use their native provider APIs. Docs reads return bounded document structure and text; writes create a document, append plain text, or replace exact text. Sheets reads return bounded spreadsheet metadata or formatted values from an explicit A1 range; writes create a spreadsheet or update/append bounded row values. Drive download/export remains available for file-oriented retrieval, but it does not replace the native Docs and Sheets operations.

The production-approved Google scope set uses `drive.readonly` for Drive discovery and native Docs/Sheets reads, and `drive.file` for native writes. Newly created Docs and Sheets can be edited. An existing file is writable only after it has been explicitly opened or shared with Rally under Google's per-file authorization model; an arbitrary existing file discovered through Drive search remains read-only. Rally does not yet include a Google Picker flow for granting that per-file write access. Drive search and metadata results expose `isAppAuthorized`, `canEdit`, and the derived `writableByRally`; Docs/Sheets update tools preflight the same metadata and fail with `details.reason = drive_file_not_writable` without attempting a mutation when either condition is false or the file is invisible to a `drive.file`-only token. This preflight is a fail-closed model-guidance and user-experience guard, not the security boundary: Google enforces the current authorization again when it receives the mutation.

Google activity ingestion is polling-only. Gmail, Calendar, and Drive are independent named activity streams under one connection. Each commits its own provider-native high-watermark—Gmail history IDs, Calendar sync/completion tokens, or Drive change page tokens—only after its canonical activities are persisted. A transient failure in one stream preserves that stream's checkpoint without forcing successful sibling streams to replay; the scheduler uses the earliest backlog or retry deadline. Gmail and Calendar are digestible streams and Drive is not: a change feed reports a save, so a document written over an afternoon is one piece of news and dozens of events. `email.received`, `calendar.event_changed`, and `calendar.event_completed` are the digestible activity types; `email.updated` is a label or read-state change on mail already seen. Drive change polling classifies Google Workspace MIME types into `docs.document_changed` and `sheets.spreadsheet_changed`; other files produce `drive.file_changed`. Consequently `drive.read` is included in the Drive + Docs + Sheets preset and is the event source for Docs and Sheets changes. Operators can follow each normalized poll result into WorkspaceDO at `connector_event_authority_ingested`, before its Queue processing begins. Rally does not currently register Gmail Pub/Sub watches, Calendar notification channels, Drive push notifications, or any other Google webhook. Rally resource watches route the normalized polled activity and must not be confused with provider push delivery. Calendar change polling expands recurring events into instances, so one edit to a series returns every instance Google holds for it. An instance is therefore reported against its series rather than on its own: one `calendar.event_changed` activity per edit, carrying `seriesChange: true`, built from the series master — read once per changed series per poll with `events.get` — and keyed on the master's id together with the master's own `updated`. Because the content is the master's, the activity carries the series' real start and end, its link, its location, its `recurrence` rule (in `metadata`), and each guest's series-level RSVP. An instance whose `updated` is after the master's was edited on its own and is reported as that occurrence, with that occurrence's times, keyed on its own etag; an instance whose `updated` is at or before the master's belongs to the edit the master records, or to an older one it has since superseded, and either way is reported against the master as it now stands. A burst is larger than the 150 items one poll fetches, so the same identity is re-emitted on later polls and the workspace's dedupe absorbs the repeats. Two rules follow from that, and both are load-bearing. An instance is classified by comparing its own `updated` to the master's, never by how many of its siblings landed in the same chunk, or the same edit would be reported differently depending on where the page boundary fell. And the activity's content must be identical in every chunk, because a repeated identity whose payload hash differs is refused at ingest — which is exactly what building it from the master, and nothing from the instances, guarantees: the master for a given `updated` is one fixed record. When the master cannot be read (a purged series, or a body that is not the master asked for) the series is reported from a representative instance keyed on the instances' `updated`, and then carries only what every instance agrees on: no start or end, no link, no overriding location, and each guest without the per-occurrence `responseStatus`. Each Google activity type declares the attached resource its events are *about* — `sheets.spreadsheet_changed` a `google_sheet`, `docs.document_changed` a `google_doc`, `drive.file_changed` a `drive_file`, and both mail events a `gmail_thread` — because the registration reconciler builds an evaluator set from those relationships and a type that declares none routes nothing, however many watches exist. The relationship names the watched entity itself rather than a container it sits in, which is why `file` and `thread` exist beside Notion's `page` in `ConnectorResourceRelationshipSchema`.

A revoked refresh grant marks the connection `needs_reconnect`. Production smoke tests should create a Gmail draft rather than send unsolicited mail. A personal Gmail send tool is available only to its owner; if an administrator creates a workspace-scoped Gmail connection through the backend, its granted send capability rolls down to every work stream like every other workspace capability.

The two records are isolated by Rally capability checks, not by separate Google OAuth principals. Because both presets use one OAuth client with incremental authorization, Google may return a token containing scopes previously granted to that account; Rally still exposes only the capabilities recorded on the particular connection. Disconnect is local when another Google connection for that account remains. Operators must not describe the presets as provider-level credential isolation.

### GitHub App

GitHub uses one public App with a signature-verifying smart ingress. One installation may be connected to Global workspaces, EU workspaces, or both; an indexed installation directory fans exact signed deliveries only to the applicable regional Workers. OAuth callbacks, credentials, raw payload storage, normalization, and activity processing remain regional. Workspace connections execute with short-lived installation tokens. Personal connections require an expiring user token and prove that the user can access the selected installation and repository.

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

GitHub delivery signatures are verified against the exact raw body before
installation-aware normalization and queueing. Webhooks also discover durable
repository, commit, file, issue, pull-request, release, workflow-run, and
check-run resources so people and agents can attach provider objects directly
to work streams without copying their content into Rally. Issue-dependency and
sub-issue deliveries add both sides of the relationship, including
cross-repository issues, while retaining one normalized activity per delivery.


### Linear

Linear is a composable connector with both `resource` and `native_agent` surfaces. One public OAuth app supports two identities through PKCE: personal connections use `actor=user` and remain private to their Rally owner; workspace connections use `actor=app` and roll their tools down to every member. The native surface is bound explicitly to the workspace-only, non-tool `linear.agent` capability. It grants `app:assignable` and `app:mentionable` for activation plus `write` for the deterministic source-comment acknowledgement; resource tools independently grant `read`, `issues:create`, `comments:create`, and `write`. The resource agent can search/read issues and projects, list teams and workflow states, create/update issues, and create comments.

`search_issues` matches a term against issue titles **and descriptions**, so an issue is findable by what it is about rather than only by what it was called. `list_workflow_states` exists because `stateId` had no discovery path: the only way to learn a valid state was to read an unrelated issue in the same team and copy the id out of it, which is a lookup dance a model does not invent and frequently gets wrong. Every argument schema on this connector is strict, and `create_issue` accepts every issue field `update_issue` accepts — the two go together, because a family whose members take different fields plus a non-strict parse is the silent-drop trap in [`agent-tools.md`](agent-tools.md#1-fail-loud-never-silently-ignore-an-input): a model that learned `dueDate` on update sent it to create, it vanished, and the tool reported success.

Linear's one public webhook is timestamp/signature verified at a dedicated smart ingress, routed by organization to the owning Global/EU connections, verified again, normalized, deduplicated by `Linear-Delivery`, and queued regionally. Workspace app connections receive matching resource events directly. A personal connection receives a delivery only after its own token proves access to the signed resource or a signed parent in one bounded GraphQL probe; its normalized activity remains personal and targets only its Rally owner. Authorization loss marks that connection `needs_reconnect`, and lifecycle/native-agent events never fan out to personal connections. Agent-session events are represented explicitly rather than being flattened into ordinary resource updates.

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
both regions, so both arrive at a Global ingress that routes them to the owning
region — see [`notion-ingress.md`](notion-ingress.md).

### Granola

Granola has two intentionally separate connection modes. A personal connection uses Granola's hosted Streamable HTTP MCP server and browser OAuth with PKCE and dynamic client registration. It follows the member's currently active Granola workspace and exposes the server's live tool surface rather than a code-authored snapshot. A personal connection remains available only to its Rally owner.

A workspace connection uses one administrator-created Granola Workspace API key. It exposes bounded read operations for listing notes, reading a note with an optional transcript, and listing folders. Rally creates the Granola webhook endpoint during installation with Granola's required `workspace` scope and note access/edit/generation events. This admits notes visible through that Workspace API key. Deliveries are verified against their untouched raw body using the endpoint's Standard Webhooks signing secret before storage, deduplication, normalization, and queueing. Granola's delivery is a change signal, so Rally hydrates the current note through `GET /v1/notes/{note_id}` before opportunity admission. Disconnecting the connection removes the remote endpoint when Granola accepts the request.

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
- `external_people`: up to 100 bounded external-person references. Generic-webhook claims remain unverified source evidence and can never create a reusable verified identity mapping.
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

### Activity ingestion

WorkspaceDO discovery upserts write only when type, title, effective canonical
URL, or merged resource metadata changes. A missing URL retains the stored URL;
metadata keeps JSON merge-patch semantics, including explicit-null deletion.
`discoveredDeliveryId` and `discoveredEventType` alone do not count as resource
changes: those fields and `updated_at` describe the last meaningful discovery
change, not a last-seen heartbeat. Real workerd coverage lives in `resource-update-cost.test.ts`.


Connectors expose one of two provider-facing activity facets while sharing the same normalized activity, persistence, queue, identity, and opportunity pipeline:

- `webhookActivity.verify` verifies exact raw bytes and returns a provider-neutral delivery envelope; `normalize` applies connection scope and provider-specific semantics. GitHub, Granola, Linear, Notion, and generic webhook use this facet.
- `pollingActivity` declares named streams and polls each from an opaque provider-native high-watermark. Its required `normalizeHighWatermark` hook canonicalizes sequences, dates, cursors, legacy values, or composite provider state both when checkpoints are loaded and before they are committed. The shared checkpoint runner bounds retries and backlog scheduling while leaving provider hooks in control of checkpoint semantics, pagination, reset/reconciliation rules, and activity normalization. Google currently supplies Gmail, Calendar, and Drive streams.

#### Declaring what a digest may read

**Every activity type a connector declares must say whether a person should be told about it in a digest, and there is no default.** `ConnectorActivityTriggerDescriptor` carries a required `digestible`, and `defineConnectorActivityTriggers` takes the event types as two lists rather than one:

```ts
activityTriggers: defineConnectorActivityTriggers("GitHub", {
  digestible: ["github.pull_request.merged", "github.pull_request_review.submitted", …],
  operational: ["github.check_run.completed", "github.workflow_run.in_progress", …],
})
```

The shape is the point. There is no list meaning "I did not think about this", so adding an event type is adding it to a list, and an event type in both is refused where it is written rather than resolved silently. Ask it this way: **would a person who was away for a day want this read back to them?** A pull request opened, yes. The eleven check runs it started, no.

`operational` is not a rejected event. It is verified or polled, normalized,
routed, matched against automations and watches, considered for Suggested Work,
and written to the activity log exactly like a digestible one — every surface
except the one that interrupts somebody on a schedule. Answer the digest
question when classifying an event type, and nothing else. Most of what a
provider emits belongs here, and that is the normal case rather than a failure:
the GitHub manifest declares ninety-one activity types and thirty of them are
digestible. Every current connector's classification, one row per activity type
with the reason, is in [`connector-digestibility.md`](connector-digestibility.md).

A **polling activity stream** declares `digestible` too, and it is required for the same reason: a stream is the granularity a connector author actually thinks in — Gmail is somebody's day, Drive's change feed is a file watcher — and a stream added later has to state which it is. **A stream can only ever withhold.** An activity is digestible when its event type says so *and* the stream that produced it agrees, so the two declarations cannot contradict each other into somebody's inbox, and a stream saying yes grants nothing on its own. `pollCheckpointedActivityStreams` stamps the withholding onto every activity a non-digestible stream returns, at the one place all polled activity passes through, so an adapter can neither forget to mark its output nor grant itself a digest it was not given.

The manifest is read when the activity log is written, in `activityIsDigestible`, keyed on the event type — the one thing an activity carries all the way from the provider to the log. **Everything unknown is withheld**: a connector this region does not register, an event type a manifest has dropped, an activity older than the declaration. None of those are somebody confirming that a person wants this in their inbox, and being wrong costs one way only. What happens to the answer afterwards — the `activity_events.digestible` column, the cursor that steps over what was withheld — belongs to [`digests.md`](digests.md#digestible-what-a-person-should-be-told).

Manifests and facets are cross-validated at registry construction: a connector that declares provider activity cannot claim webhook or polling support without the corresponding implementation. Slack keeps its dedicated signature-verified Agent ingress, but that ingress may normalize a bounded event into the shared activity pipeline when an exact active automation source is listening; it does not create a general Slack feed. X remains an on-demand read connector because a connection does not yet select a monitored user, list, or stream rule from which a safe feed could be constructed.

1. The provider-facing Worker verifies a webhook or a poll Workflow reads the provider. Large raw bodies remain in regional R2.
2. Resolve every authorized connector installation. A single raw provider delivery may fan out to multiple workspaces only when that account is independently installed in each one; normalization produces a separate event for every connection/workspace target.
3. Normalize the bounded event for one workspace target and retain any large raw body in regional R2.
4. Enqueue the region, bounded normalized event, ingress UUID, and canonical
   content hash on that region's Cloudflare Queue. Large/raw provider bytes stay
   in R2 behind `payloadRef`; the Queue message is independently parseable and
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
   cannot mistake handled work for an unmatched event. Only an unclaimed event
   enters WorkspaceDO's Suggested Work batch tables; activity-log projection is
   unconditional. There is no semantic route into an existing work stream.
   Admission and ranking are separate fenced Workflows whose durable product
   results, including provenance and per-user resolutions, commit in the same
   WorkspaceDO. The evaluator grammar is deliberately closed and deterministic,
   and [`automation-lifecycle.md`](automation-lifecycle.md) owns it. The Queue
   consumer then settles the authoritative event as processed or failed. A
   transient failure calls per-message `retry()` and an exhausted message enters
   the existing regional activities DLQ.
9. Each match becomes its own message on the same regional Queue, carrying the registration, the destination, and the event inline. The consumer calls `AutomationDO.admitExternalEvent` or `SubstreamAgent.appendWatchedResourceEvent`; the destination re-checks its own lifecycle and activation boundary and admits at most one occurrence per canonical event, keyed on the event id, so there is no delivery ledger and no lease to settle.
10. WorkspaceDO retains/reaps the canonical event according to product retention. Legacy D1 `activities` rows are imported and scrubbed before the route opens; live events never create a D1 body handoff.

**Why the event is present in ingress but absent from processing:** the first
Queue message must be self-contained because no canonical WorkspaceDO event
exists yet. Once step 5 commits, WorkspaceDO is the only event authority. A
second event copy would either have to be ignored or hash-checked against that
authority, so it cannot remove the claim/load RPC; it could also become stale,
increase every retry's payload, and leave normalized provider content in the DLQ when
processing exhausts. The ID-only pointer makes processing retries and exhausted
messages content-free. The cost is one additional same-Queue send after commit.
That handoff is closed by acknowledging ingress only after Cloudflare accepts
the pointer: if the send or invocation fails first, the self-contained ingress
message replays and WorkspaceDO deduplicates it.

A single-message alternative—ingest, process, and retry the original full
message—would also be correct if every retry re-ingested idempotently and still
loaded WorkspaceDO authority. It was rejected because it retains the normalized
event for the entire processing retry/DLQ lifetime in exchange for saving only
the second Queue send, not an object round trip.

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

“Global ingress” means Cloudflare's edge Worker fleet, not one US data plane.
The global router may inspect routing metadata, but EU workspace content is
forwarded to the EU regional Worker, EU Queue, and EU-locked WorkspaceDO.
Normalized content never crosses through the global D1 routing plane.

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

Slack is a composable `resource` and `messaging_agent` connector. Workspace installations host the Agent, App Home, interactive surfaces, activity triggers, and deterministic automation delivery; the bot joins existing public channels after install/reconnect and new public channels when Slack reports their creation. Accepted DM and mention prompts receive an immediate `eyes` reaction through the shared activation hook before processing. Optional personal authorizations use Slack's hosted MCP server and its live `tools/list` surface rather than Rally's historical snapshot. Slack delivers bounded message, reaction, file-share, channel, and membership events. Agent-thread events follow the existing conversational path; events matching an exact active automation source are normalized into the shared regional activity pipeline. Unmatched activity is discarded before durable queueing and is never turned into a general Slack feed or mirrored corpus. See `docs/slack-integration.md` for the product and data flow and `docs/slack-permissions.md` for the complete OAuth scope inventory.

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

**Never refuse an incoming request because a stored status says the connection is unhealthy.** Gate on `disabled` — a person's decision — and on nothing else; see [Stored status is a belief, not a gate](#stored-status-is-a-belief-not-a-gate). *A Slack installation refused sixteen hours of events, unfurls, identity links and automation deliveries without once asking Slack whether the grant still worked, and overwrote the accurate diagnosis of its own failure while doing so.*

**Never reach a provider with a credential nobody refreshed.** Enforced structurally: provider-calling entry points take `AuthorizedConnectorConnection`, which only the credential door can mint. *A Granola personal connection became unloadable minutes after it was connected, reporting `plugin_not_authorized` while the connections screen showed it healthy, because `load_plugin` revalidation health-checked it without refreshing first.*

**A health check must not write.** Provider state that needs restoring goes in `repair`, which only an explicit connection test invokes. *Granola re-enabled its webhook endpoint with a `PATCH` inside `healthCheck`, which reauthorization ran on every plugin activation.*

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
| What happens to `digestible` after the log is written | [`digests.md`](digests.md#digestible-what-a-person-should-be-told) |
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
Durable Object goes through `withWorkspaceRuntimeDatabase`, never `this.env.DB`.
Written against the regional binding it names a table regional D1 does not have,
which reaches the person as "An unexpected error occurred" rather than as
anything naming the boundary. That defect was found on the automation delivery
path this section used to describe, and
`durable-object-workspace-table-routing.test.ts` is what catches it now,
whichever object makes the mistake next.

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
- **Everything unknown is withheld from a digest** — a connector this region does
  not register, an event type a manifest has dropped, an activity older than the
  declaration. None of those are somebody confirming a person wants this in their
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
- **X remains an on-demand read connector.** A connection does not yet select a
  monitored user, list, or stream rule from which a safe feed could be constructed.

## Testing

`apps/api/test-workers/resource-update-cost.test.ts` covers no-op discovery, each
independent change condition, mixed batches, and URL/metadata merge behavior.


| Suite | Covers |
| --- | --- |
| `apps/api/test/connector-credential-freshness.test.ts` | Both halves of the freshness contract. Its conformance half **enumerates the registry rather than a hand-written list**, so a connector added later is enrolled by existing: for every adapter that can refresh a credential, a provider that rejects the token must be answered with a refresh and a retry. An adapter whose health check does not present the connection's expiring credential — Notion introspects a token in the request body under the integration's own client credentials — declares that in the fixture table, so the exemption is a reviewable fact rather than a silent pass. |
| `apps/api/test/connector-credential-refresh.test.ts` | The lease, the serialized rotation, the adopt-don't-redeem path, and that a successful refresh heals the row. |
| `apps/api/test/connector-oauth-error.test.ts` | `isRevokedGrantError` and the three-answer classification. |
| `apps/api/test/connector-actor-identity.test.ts` | The three tiers, the monotonic write, and that only `verified_email` is recorded. |
| `apps/api/test/connector-catalog-discovery.test.ts` | `searchAliases`, the catalog wording, and the load sentence. |
| `apps/api/test/connector-tool-selection.test.ts` | Capability intersection and the `connectorCapabilityRefused` shape. |
| `apps/api/test/connector-poll-reliability.test.ts` | `normalizeHighWatermark` on both load and commit, the bounded retries, and backlog scheduling. |
| `apps/api/test/connector-event-authority.test.ts` | WorkspaceDO event admission/replay and frozen pre-cutover activity rows ignored once object authority is open. |
| `apps/api/test-workers/durable-object-runtime.test.ts` | Real-workerd WorkspaceDO schema, Queue/provider replay dedupe, Queue claim fencing and recovery, and terminal settlement. |
| `apps/api/test-workers/workspace-connections.test.ts` | The typed OAuth attempt lifecycle across the real RPC boundary — settlement witnesses, replay convergence, the member-scoped lazy expiry, the succeeded-over-expiry override — plus webhook receipt claims, their same-transaction expired-receipt sweep, and the generic port's refusal of `webhook_receipts`. |
| `apps/api/test/connector-oauth-handoff.test.ts`, `apps/api/test/connector-outcome-telemetry.test.ts`, `apps/api/test/granola-connector.test.ts` | The connection service over a real `WorkspaceDO` via `test/helpers/workspace-object-rpcs.ts` — attempt expiry/reconciliation through the service, single-emission outcome telemetry, and that no plaintext credential crosses the recorded RPC boundary during webhook ingestion. |
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

## Changelog

### 2026-09-12 — Ashby and shared workspace installation ownership

Ashby adds personal hosted MCP and independently authorized workspace events. Only `applicationSubmit` and `candidateStageChange` are declared, both operational. Workspace tools remain empty. Shared installation state now reserves identity before provider create and retains cleanup authority after disablement. Granola adopts the same lifecycle without replacing its existing subscription. See [installation lifecycle](connector-installation-lifecycle.md) for invariants and outstanding acceptance; the confidential-payload review still blocks workspace automation launch.

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
Rally's capability grant, principal checks, execution policy, and receipts
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
