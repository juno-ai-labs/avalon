# Work-stream origin attachments

A work stream that exists because of a place in a connected tool — the Slack
thread `@Rally` was mentioned in, the Linear issue an automation fired on, the
GitHub pull request a suggestion was built out of — carries that place as a
resource attached to it, from the moment it is created. The **Sources** section
of the inspector rail shows it, and the agent's `workstream_list_resources` tool lists it
with the relationship `origin`.

The promise is narrow and worth stating exactly: **where a work stream came from
is written down once, at creation, by the connector that knows what the place
is.** Nothing reconstructs it afterwards — a Slack thread timestamp is not
recoverable from a transcript, and the person reading the work stream a week
later is the reason it is recorded at all.

Describing an origin is part of the connector contract rather than a per-provider
special case in the host. Every connector answers for its own activities without
writing a line of code, because the connector base derives an origin from the
object normalization already recorded; a connector whose work streams start
somewhere an activity cannot describe — a Slack thread, a provider-hosted agent
session — implements `ConnectorOriginSource` and the same host path carries it.
Read this alongside [`connectors.md`](connectors.md) for what a resource is, and
[`contextual-routing.md`](contextual-routing.md) for the *other* way connector
activity reaches a work stream — a card someone accepts, which is a decision
rather than a fact about how the work stream began.

Origin resources are always references at the model boundary. The message
attachment manifest cutover does not copy connector origin content into a
trigger: the agent discovers the origin through `workstream_list_resources` and
hydrates a currently authorized derivative only when the task needs it.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/index.ts` | `ConnectorOriginResourceSchema` — what a connector says about a place, and the one bound on its fields. |
| `packages/connectors/src/types.ts` | The connector base: `ConnectorOriginLocator`, `ConnectorOriginSource`, `connectorOriginFromActivity` (the derivation every connector gets free), and `describeConnectorOrigin` (the single entry point, which also enforces the manifest check). `ConnectorAdapter.origin` is where an adapter opts in. |
| `packages/connectors/src/slack.ts` | `slackOriginSource` — the only connector that implements one today: the thread an Agent invocation arrived in, plus `chat.getPermalink` for its URL. |
| `apps/api/src/lib/activity-visibility.ts` | `restrictedActivityUserIds` and `activityIsWorkspaceVisible` — the one implementation of who a connector activity may reach, shared with the activity queue. |
| `apps/api/src/services/workstream-origin-resource.ts` | The host half: `describeWorkstreamOrigin` binds a connector's answer to the connection it was reached through, `resolveOriginResource` is the one place a connector resource row is looked up or created, and `attachWorkstreamOriginResource` writes and broadcasts the attachment. |
| `apps/api/src/services/slack-agent-service.ts` | `slackSessionOrigin` hands the Slack locator to the adapter through the credential door; `createSlackWorkstreamSession` passes the result to whichever create path runs. |
| `apps/api/src/services/workstream-service.ts` | `create` attaches `input.originResource`; `createFromOpportunity` attaches a suggestion's activity provenance roots; `describeActivityOrigin` is the shared stored-row path both it and `attachActivityResource` use. |
| `apps/api/src/services/slack-workspace-workstream-service.ts` | `create` attaches the origin for a Slack member who is not a Rally user. |
| `apps/api/src/telemetry/workstream-creation.ts` | Resolves a started suggestion's canonical connector types from the same retained activity provenance roots, without copying source content or connection IDs into telemetry. |
| `apps/api/src/queues/activity-consumer.ts` | `startActivityAutomation` attaches the activity that matched the trigger. |
| `packages/db/migrations/0001_initial.sql` | `workstream_resources.relationship_type`, which carries the `origin` label. |

## How it works

An ingress that can start a work stream hands its connector a
**`ConnectorOriginLocator`** — either a normalized activity, or the provider's own
session payload, opaque to the host — and gets back a `ConnectorOriginResource`:
a resource type, the provider's own id for the object, a title, an optional
canonical URL, and metadata. The connector names *which object*; only the host
knows *whose connection* it was reached through, and
`describeWorkstreamOrigin` binds the two into the descriptor that gets attached.
Keeping them apart is what stops an adapter from being able to describe an origin
against a connection it was never given.

`describeConnectorOrigin` in the connector base is the single entry point:

1. The adapter's own `origin.describe` is asked first. What it returns is checked
   against the manifest's `resourceTypes` — the connector's own enumeration of
   what it produces, so a type absent from it is a typo rather than a new
   capability, and a typo silently forks the resource identity for every work
   stream after it.
2. Anything it does not describe falls back to `connectorOriginFromActivity`,
   which reads the provider object straight off the normalized activity. This is
   why a connector that implements nothing still records origins.
3. When the caller holds an authorized connection and the description has no URL,
   the adapter may fetch one with `resolveCanonicalUrl`, under the host's
   credential door. Best-effort: an origin that records *which* Slack thread but
   cannot link to it is still the only record of where the work stream came from.

`attachWorkstreamOriginResource` then resolves the descriptor to a `resources` row —
reusing the existing row when this workspace has seen the object before, keyed on
`(workspace, connection, provider, providerResourceId)` — inserts a
`workstream_resource_links` row with `relationship_type = 'origin'` and watching off,
and publishes `resource_attached` so a work stream already open on a screen shows
it without refetching.

Every attachment happens **before the harness run is launched**, so the run's
first context read already holds the place it is about rather than acquiring it a
turn later.

### Adding one to a connector

Nothing, for the activity case. A connector that emits activities already records
origins, because `connectorOriginFromActivity` reads `resourceType`,
`providerResourceId`, `title`, and a canonical URL from whichever of
`canonicalUrl`, `url`, `htmlUrl`, or `permalink` the provider used.

Implement `ConnectorAdapter.origin` for the two cases that derivation cannot
reach:

- **A place no activity describes.** A provider-hosted agent ingress — Slack's
  threads, Linear's agent sessions — arrives as a session, not an activity.
  Handle `locator.kind === "agent_session"`, parse the provider-native payload
  with your own schema, and return the place. Return `null` for any locator kind
  you do not handle; the base takes it from there.
- **A better place than the activity's own object.** An activity about a message
  may be better recorded as the thread it is in. Handle
  `locator.kind === "activity"` and return that instead.

Add `resolveCanonicalUrl` only when the URL is not already in the metadata and
the provider must be asked for it.

### Slack

Slack implements both halves. It attaches the **thread**, not the channel: an
`@Rally` mention that opens a new top-level message still gets a thread of its
own, so there is always one, and it is the place a person would go back to. A
direct message has a thread too — the root the agent posts when there is nothing
to reply under. The identity is `<channelId>:<threadTs>`, and the ingress passes
the channel and thread the agent actually replies into rather than the ones the
event carried, which a DM invocation arrives without.

Its identity carries a `thread` segment — `<channelId>:thread:<threadTs>` — and
that is not cosmetic. `normalizeSlackActivity` identifies a message as
`<channelId>:<ts>`, and for a thread root that `ts` *is* the `thread_ts`, so the
obvious form would be the same string while the identity tuple does not include
the resource type. A thread origin and a `slack_message` activity resource would
collide on one row, and whichever arrived first would win: the origin would
inherit the message's type, title, and missing permalink.

The title names the channel (`Thread in #operations`), or says
`Slack direct message` for a DM, or falls back to `Slack thread` when Slack did
not give a channel name. The canonical URL is asked of `chat.getPermalink`
rather than assembled, because a permalink is qualified by the team's own domain,
which the installation never told us; a guessed URL would be a link that silently
opens the wrong workspace.

### Connector activity

An activity that names no provider resource describes something with no place to
point at and produces no attachment.

Two paths use it. A connector activity that matches an automation trigger
attaches the object the automation fired on, ownerless — an automation fired,
nobody attached anything. A suggestion that someone starts attaches the activity
provenance roots the ranking model was shown, credited to the member who selected
it.

## Invariants

- **An origin is attached before the run is launched.** A run that starts first
  can read the work stream's context without its origin in it, and the agent then
  answers about a Slack thread it cannot see — the exact failure the attachment
  exists to prevent.
- **One resource row per provider object per workspace.** `resolveOriginResource`
  is the only place an origin's row is created, and it shares its lookup key with
  the accepted-suggestion path in `attachActivityResource`. A second work stream
  started in the same Slack thread, or a card later accepted against the same
  Linear issue, attaches the row that already exists; a second lookup key
  elsewhere would silently fork the object and split its watches.
- **Attaching an origin never fails a create, and that is structural.** Every
  caller awaits this between committing a work stream and launching its run, so
  an exception would leave a row at `harness_status = 'running'` with nothing
  behind it — strictly worse than the missing attachment. `describeWorkstreamOrigin`
  is therefore *total*: both failure paths inside it are caught, and its one
  remaining parse is a `safeParse`. `attachWorkstreamOriginResource` catches its
  own writes, and `attachOpportunityOriginResources` wraps the whole step
  including the provenance query. A new call site is expected to keep that
  property rather than rely on a caller's `try`.

- **A derived origin can only carry values the contract accepts.**
  `connectorOriginFromActivity` bounds every field the schema bounds and picks a
  canonical URL with the schema's own validator. The two used to disagree —
  `/^https?:\/\//` accepts the string `https://`, `HttpUrlSchema` does not — and
  an activity carrying that lost its *whole* origin over an optional field.
- **Only an activity the whole workspace may see becomes an origin.** A resource
  row is listed to everyone the work stream is listed to and is broadcast over
  `resource_attached`; `WORKSTREAM_RESOURCES_SQL` applies no connection-scope
  filter, so an attachment is a workspace-visible act whatever the credential
  behind it. The suggestion path therefore applies **two** filters: the
  connection's scope in SQL, which is authoritative for the credential, and
  `activityIsWorkspaceVisible` on the activity's own row, which the connection
  cannot express. The second is the one that matters — a message in a private
  Slack channel arrives on the *workspace* Slack connection and carries its
  restriction in `visibility` (`workspaceAutomationAllowed: false` with an
  explicit `allowedUserIds`), so scope alone reads it as public and republishes
  it.
- **A connector describes the object; the host binds the connection.** A
  `ConnectorOriginResource` names no connection and no provider, and
  `describeWorkstreamOrigin` is the only place the two are joined. Letting an
  adapter return a connection id would let it describe an origin against a
  credential it was never handed.
- **An adapter-authored resource type is one the manifest declares.** Checked in
  `describeConnectorOrigin` and thrown on. A type that is a typo forks the
  resource identity for every work stream started there afterwards, and nothing
  downstream would ever notice. A *derived* type is not checked: it came out of
  the connector's own normalization, so rejecting it would drop attachments over
  a drifted manifest rather than over a real mistake.
- **`relationship_type = 'origin'` means the work stream *began* there.** The
  agent is handed the relationship by `workstream_list_resources`, which is how it tells
  the channel it was summoned from apart from a document somebody attached
  afterwards. Nothing *automatic* may treat the two alike — a cleanup sweep or a
  re-attach path that cannot tell them apart would drop the only record of where
  the work stream came from.

  A person still can: `DELETE /workstreams/:id/resources/:resourceId` removes an
  origin like any other attachment, and the rail's **Remove** button offers it,
  because `WorkstreamDetail` does not carry `relationship_type`. That is
  deliberate for now — somebody who does not want a private channel's name
  visible in a shared work stream should be able to take it out, and protecting
  the row would mean a contract field, a disabled control, and a refusal that
  nobody has asked for. Revisit it together with those three, not on its own.

  The rail's resource detail now carries two more controls, and the same
  contract gap puts both on an origin: **Refresh from source**, which is offered
  for any `source` resource on a connection, and the version list, which is
  offered for any resource with more than one version. Neither changes what an
  origin *is* — the version list is empty because nothing swaps an origin's
  pointers, and `POST /resources/:id/hydrate`, which the button calls, was
  already reachable for an origin before there was a button. What the button
  does change is that a participant can now reach it in one click, and a
  connector whose `hydrateResource` returns channel content would store it on a
  row this document says carries none. That is the same missing
  `relationship_type` again, and it belongs in the same revisit rather than in a
  second one-off guard.
- **An origin carries no provider content.** It records where something is, not
  what it said. Slack Agent policy makes this explicit — durably storing provider
  content gathered for surrounding context is forbidden — and the rule is the
  same for every connector: identifiers, a name, and the kind of place, with the
  content left where an authorized tool can fetch it for a run.

  Concretely, an origin's `content_ref` is always null. An activity's
  `payload_ref` addresses the raw verified webhook body in R2, and
  `workstream_read_resource` serves a selected model derivative only after the
  shared work-stream visibility boundary authorizes it — so copying it would turn "record
  where this came from" into "publish the provider payload to the run".
  `attachActivityResource` is the one path that still sets it, because there a
  person accepted a card about that activity and reading it is the point.

## Boundary

The connector base owns what a place *is*; the host owns binding it to a
connection, writing it, and broadcasting it. Neither decides *whether* a work
stream should exist — that is the ingress's judgement — and neither hydrates,
watches, or renders what it attaches.

It deliberately does **not** cover:

- **Manual attachment and watches.** `ResourceService` and
  `WorkstreamService.attachResource` own those, including the authorization an
  origin does not go through: an origin is a fact the server observed, not a
  request a caller may make. `originResource` is therefore absent from
  `CreateWorkstreamRequestSchema` and cannot be asserted over the wire.
- **Contextual routing.** The paused **Suggested context** surface offered an
  activity to an *existing* work stream; if re-enabled, accepting one produces
  an `attachment`, not an `origin`. See
  [`contextual-routing.md`](contextual-routing.md).
- **Inbound email.** A work stream created from an address already attaches its
  email resource in `resend-inbound-email-service.ts`, and a scheduled automation
  run already copies its subscription's resources; neither is rewritten here.
- **What the model does with the attachment.** The pageable
  `workstream_list_resources` index and bounded read/search tools are
  [`agent-harness.md`](agent-harness.md) and
  [`agent-attachments.md`](agent-attachments.md).

## Failure modes and limits

- **A `resolveCanonicalUrl` call fails or times out (1s for Slack).** Swallowed
  in `describeConnectorOrigin`; the attachment keeps a null `canonical_url` and
  still records *which* object, which is the part nothing else holds. Swallowing
  it inside the base is also what keeps a refused permalink from reaching
  `withAuthorizedConnection` as an `unauthorized` error and marking a working
  connection `needs_reconnect` — a link is not evidence about a grant, and the
  ingress calls the provider again moments later for anything that is.

  Slack's budget is deliberately **one** second rather than the usual five: the
  call runs inside the thread claim and ahead of the `slack_agent_sessions`
  write, and a concurrent event in the same thread waits only about two seconds
  in `waitForSession` before it is refused with `slack_thread_busy`. An optional
  field on an optional attachment does not get to spend the window that decides
  whether somebody else's message is accepted.
- **The connector registry cannot be built.** One misconfigured credential takes
  every adapter down with it, so an activity locator falls back to
  `connectorOriginFromActivity` — which needs no adapter — and the origin
  survives. Logged as `connector_registry_unavailable_for_origin`. A session
  locator has no such fallback and yields no origin.
- **An adapter describes an undeclared resource type**, or its description fails
  the contract. `describeConnectorOrigin` throws `invalid_configuration`, logged
  as `workstream_origin_description_failed`, and the work stream is created with
  **no** origin — not with a derived one. The two failures above are caught
  separately for exactly this reason: a single `catch` around both let an
  adapter's undeclared type fall through to the activity derivation, which
  answered with a substitute origin and defeated the check that exists to stop a
  typo forking a resource identity.
- **A queue invocation dies between committing an automation run and attaching
  its origin.** The redelivery attaches it: the write sits on both the new-run
  and existing-run paths, before the Workflow is created, and both statements
  behind it are `ON CONFLICT DO NOTHING`. Repeating it costs one lookup.
- **The resource insert or the attachment write fails.** Logged as
  `workstream_origin_resource_attach_failed` with the workspace, work stream,
  provider, and resource type. The create continues. The resource row is resolved
  before the attachment, so a failed attachment leaves the shared row behind
  rather than half of one.
- **A suggestion has more sources than the cap.** At most **8** activity
  provenance roots become attachments, in `position` order. A batched opportunity
  can be built from a run of related events, and the rail is a reading surface
  before it is an index; the cap is generous against what admission actually
  produces.
- **The same object is resolved concurrently.** Safe, and by construction rather
  than by luck: `resources_connection_provider_identity_idx`
  (`0002_scope_resource_identity.sql`) is a unique index on exactly
  `(workspace_id, connection_id, provider, provider_resource_id)` where both are
  non-null, so the `ON CONFLICT DO NOTHING` insert is a real no-op for the loser
  and the read-back returns the one row. That index is also why two *different*
  kinds of object must never share a `providerResourceId` — see the invariant
  above.
- **The work stream is gone by the time the attachment is written.** The foreign
  key rejects it, the failure is logged, and `attachWorkstreamOriginResource`
  returns null.

## Testing

Three suites, split the way the code is:

```bash
pnpm --filter @rally/connectors exec vitest run src/origin.test.ts   # the contract and the base
pnpm --filter @rally/connectors exec vitest run src/slack.test.ts    # one connector's implementation
pnpm --filter @rally/api exec vitest run test/workstream-origin-attachment.test.ts  # the host
```

`src/origin.test.ts` holds the contract against a synthetic adapter, so a new
connector's obligations are readable without opening a provider. The host suite
runs each creation path against a real migrated SQLite database through
`test/helpers/sqlite-d1.ts`.

Traps for whoever extends it:

- The host suite builds descriptors **through the registry**, never by hand: a
  hand-written descriptor would not notice the connector no longer producing that
  shape. Its fake `Env` therefore carries real-looking `SLACK_*` and `LINEAR_*`
  configuration, because an unconfigured connector is not in the registry at all.
- `integrations`, `workstream-naming-service`, and
  `workstream-email-routing-service` are module-mocked. The email fake must
  return a **distinct address per work stream** — `workstreams.email_address` is
  unique, so a constant collides the moment a test creates two.
- Use `vi.clearAllMocks()`, not `vi.restoreAllMocks()`: restoring wipes the
  implementations the module factories installed, and the next test fails in a
  way that looks nothing like its cause.
- The activity path needs real `activities` and `connector_connections` rows, not
  a hand-built activity object: the work stream it writes references the activity
  by foreign key.

## Data model

No new tables. An origin attachment is a `resources` row plus a
`workstream_resources` row whose `relationship_type` is `origin` rather than the
default `attachment`; [`data-model.md`](data-model.md) stays authoritative for
both.

## Security and trust model

Everything a descriptor carries is provider-supplied and untrusted: it is stored
as data and never interpolated into instructions. An origin carries no provider
content (see the invariant above), and the suggestion path filters personal
connections to their owner so an attachment cannot widen who can see a connector
object. The `originResource` field is server-side only and absent from
`CreateWorkstreamRequestSchema`, so no client can assert an origin its work
stream does not have — and a `ConnectorOriginResource` names no connection, so
neither can an adapter.

`resolveCanonicalUrl` is the only part of this that reaches a provider, and it
runs through `withAuthorizedConnection` like every other provider-calling adapter
entry point: the credentials it uses are refreshed by the door rather than by a
step the ingress has to remember.

## Changelog

### 2026-08-28 — The rail's new resource controls reach origins too

**What changed:** The inspector rail's resource detail gained **Refresh from
source** and a version list. Both are gated on the resource contract alone, so
both appear on an origin.

**Why:** `WorkstreamDetail` still does not carry `relationship_type`, which is
the same reason **Remove** has always been offered on an origin. Adding a guard
for one control while the other two stay open would spend a contract field on a
third of the problem.

**Considered and rejected:** Gating the new controls by inferring an origin from
its provider or its null `content_ref`. Both are guesses that a legitimate
attachment can also satisfy, and a control that disappears for the wrong reason
is worse than one that appears for a knowable one.

**Consequences:** An origin's version list is empty, because nothing swaps its
pointers. A refresh calls `hydrate`, which was already reachable for an origin
before there was a button; a connector that returns content for one would now
store it on a row this document says carries none. That is the missing
`relationship_type`, and it is on the same revisit as **Remove**.

### 2026-08-27 — Origin relationships render as sources

**What changed:** `origin` is one of the constrained work-stream resource
relationships and derives `direction: source`; the inspector rail lists it under
Sources rather than a combined Resources section.

**Why:** An origin is material brought into the work stream, not something the
work stream generated, even when the shared canonical resource was first created
while the work stream was starting.

**Considered and rejected:** Persisting direction on the workspace resource
would prevent that same resource from taking a different role in another work stream.

### 2026-08-13 — Connector provenance also attributes creation analytics

**What changed:** The server's single work-stream creation event now records the
canonical connector type for Slack and activity-triggered automations. Suggested
work joins its retained activity roots back through their connection rows and
emits a bounded unique connector-type list; exact retained provider values are a
fallback only when they are already part of the closed connector taxonomy.

**Why:** Origin attachments preserved where work began for people and agents,
but product analytics still could not distinguish connector-created work or say
which connector contributed to a multi-source suggestion.

**Considered and rejected:** Sending connection IDs, provider account IDs,
origin URLs, labels, or one creation event per root. Those either expose
high-cardinality identifiers/content or multiply one work-stream creation.

**Consequences:** The attachment and analytics paths share provenance but remain
purpose-specific: resources preserve the navigable place, while telemetry keeps
only canonical connector types. A new connector-origin ingress must supply its
registered type to both boundaries without sending provider content.

### 2026-08-12 — Origin content stays behind scoped hydration

**What changed:** The manifest-only message cutover explicitly keeps connector
origin resources reference-first; no origin bytes are added to a triggering
message as a compatibility shortcut.

**Why:** Origins and message uploads share resource hydration, but only message
uploads have a same-turn manifest. Treating an origin relationship as implicit
prompt content would restore the context-growth and partial-coverage problem the
attachment cutover removes.

**Considered and rejected:** Eagerly hydrating the origin when a work stream is
created. Many tasks never need its full contents, and large provider objects
would consume the opening context before the agent chooses relevant evidence.

**Consequences:** Origin discovery remains through the pageable sidebar-aligned
list, and every content read retains current principal authorization and exact
coverage metadata.

Shipped in [#144](https://github.com/juno-ai-labs/avalon/pull/144). Design:
[context-safe agent attachments](PRDs/2026-08-12_context-safe-agent-attachments/prd.md).

### 2026-08-12 — Origin discovery uses the shared pageable resource boundary

**What changed:** The agent now discovers origin relationships through
`workstream_list_resources`, using the same principal-aware visibility loader as
the right sidebar. Content hydration reads a bounded, versioned derivative
rather than handing the model the resource's raw `content_ref`.

**Why:** The retired `workstream_read` index stopped at fifty rows and had its
own note-visibility SQL, so the rail and the agent could disagree as either
query evolved. Raw resource refs also offered no structured partial-coverage or
version guarantee.

**Considered and rejected:** Keeping a separate origin-only listing path. Origin
is a relationship value inside the complete resource inventory; a second
catalog would recreate the synchronization problem and make a small model choose
between overlapping discovery tools.

**Consequences:** Code and documentation that teach the agent where an origin
appears must name `workstream_list_resources`. Origin creation remains unchanged
and still precedes run launch; only authorized discovery and hydration moved.

Shipped in [#144](https://github.com/juno-ai-labs/avalon/pull/144). Design:
[context-safe agent attachments](PRDs/2026-08-12_context-safe-agent-attachments/prd.md).

### 2026-08-12 — A work stream records the connector place it started from

**What changed:** Work streams created from a connector context now attach that
context as a resource with `relationship_type = 'origin'`, before the harness run
launches. Three ingresses supply it: the Slack Agent (the thread), a connector
activity that matches an automation trigger (the object the activity is about),
and a started suggestion (its activity provenance roots).

Describing the place is part of the **connector contract**:
`ConnectorAdapter.origin` is a `ConnectorOriginSource`, the connector base
derives one from any normalized activity for free, and `describeConnectorOrigin`
is the single entry point the host uses. Slack is the first implementation —
its threads, plus `chat.getPermalink`, added to the Slack API surface for a real
thread URL.

**Why:** A work stream started from Slack arrived with **No resources attached**
and no record anywhere of the channel or thread it came from — the Slack thread
ts lives only in `slack_agent_sessions`, which no product surface reads, so the
place was unrecoverable to a person and invisible to the agent working in the
work stream. The same hole existed for automation runs, where the work stream
named the issue in its title and nothing linked to it. Provenance was being
thrown away at exactly the moment it was known, and only at that moment: nothing
downstream can reconstruct it.

**Considered and rejected:** Building the Slack rules into the host service,
which is where they started. It worked, and it was the shape that guarantees the
second connector copies it: `slackOriginResourceDescriptor` sat in an API module
that had to know Slack's channel-versus-thread rule, Slack's title wording, and
Slack's permalink API, none of which the host has any business knowing. Putting
the capability on the adapter also put the manifest check somewhere it can
actually run.

A parallel manifest declaration (`originResourceTypes`, or a
`supportsOrigin` flag) was rejected for the same reason: `resourceTypes` already
enumerates what a connector produces, and a second list would be a second thing
to keep in step.

Attaching the Slack *channel* rather than the thread — coarser, and it collapses every work stream started in a busy channel
onto one row, so the row stops answering "where did this come from". Building the
permalink locally as `https://slack.com/archives/…` — the team subdomain is never
supplied by the installation, and a link that resolves to the wrong workspace is
worse than no link. Deriving the origin lazily when the rail is read — the
information is not durably available later, which is the whole problem. Making
the attachment a required step of create — it would let a resource write fail a
person's request.

**Also settled here, from review:** a Slack thread's identity carries a `thread`
segment so it cannot collide with its root message's activity resource; the
automation attachment sits on both run paths so a redelivery repairs it; the two
description failures are caught separately so a connector's undeclared type is
never worked around; a provider-returned URL is re-parsed through the contract
before it is stored; an origin's `content_ref` is always null; and an existing
row has a missing link filled in rather than being left stale.

**Consequences:** A new connector gets activity origins with no code and opts
into more by implementing `origin`; a new *ingress* is expected to build a
locator and call `describeWorkstreamOrigin` rather than a descriptor of its own.
The paths that deliberately do neither are listed under **Boundary** with the
reason. `attachActivityResource` no longer owns its own resource lookup SQL —
`resolveOriginResource` is the single place a connector resource row is resolved,
and a second lookup key added elsewhere would fork the object. Both stored-row
callers now join `connector_connections` for `connector_type`, because the
registry is keyed on it rather than on `activities.provider`. The suggestion path
caps attachments at 8 roots.

Shipped on branch `claude/workstream-source-attachments-lscki1`.
