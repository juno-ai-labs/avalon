# Clockwork Recruiting connector

> Created 2026-09-17.
>
> A workspace connector for Clockwork Recruiting: bounded read tools over the
> firm's search data, and webhook activity that a Sidekick can trigger on.
> Companion: [the API investigation](research.md). Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).
> Architecture it extends: [`connectors.md`](../../connectors.md),
> [`automation-lifecycle.md`](../../automation-lifecycle.md).

## Summary

An executive search firm running on [Clockwork
Recruiting](https://www.clockworkrecruiting.com/) connects it to a Rally
workspace once, as an administrator. From then on the agent can look up a
person, a search project, and where a candidate stands in it, without anybody
pasting a Clockwork screenshot into a work stream; and a Sidekick can be
triggered by a candidacy moving — "when anyone on the Meridian CFO search goes
red, open a work stream with the last note and who to call."

This is the Fireflies shape: one administrator-pasted credential, a small set of
read-only tools, and webhook activity that flows into the existing normalize →
queue → match pipeline. It is **workspace-only**. Clockwork issues no per-user
grant of any kind, so there is nothing a "Connect for me" could honestly mean
here, and the PRD says so rather than building a personal mode that silently
reads the whole firm.

## Motivation

Rally's connector inventory covers how a team communicates — Slack, Gmail,
Linear, GitHub, Notion, meeting notes. It covers hiring exactly once, through
Ashby, and that connector is event-only: its workspace half deliberately exposes
no recruiting reads and directs every question to a personal MCP connection.

For a retained executive search firm, the ATS is not a system of record next to
the work. It **is** the work. The firm's day is candidacies moving through
stages, and the artifacts a client actually receives — the weekly progress
update, the slate, the reference summary — are assembled by hand from data that
already exists in Clockwork. That assembly is the thing a Sidekick is for, and
today it cannot be built, because Rally cannot see the data and cannot be woken
when it changes.

The specific failure is worth naming, because it is the one the connector
removes. A search partner wants a work stream opened when a candidate on a live
search stalls. Rally has no Clockwork events, so the alternatives are a
schedule that polls nothing, or a person remembering. Both are how a slipping
candidacy reaches a client as a surprise.

Two things make now the moment rather than later. First, [the Ashby
connector](../../connectors.md#ashby) already paid for the general shape — an
ATS-flavoured workspace webhook install, event-only, administrator-authorized —
so most of what Clockwork needs exists and has been through review. Second, the
Sidekick trigger grammar landed with [`set_evaluator_rules`
](../../automation-lifecycle.md#triggers-and-occurrences) and a connector that
declares typed filter fields gets automation triggers for free; a connector
written before that would have needed rewriting to get them.

The counter-argument, stated fairly: Clockwork does not publish its developer
documentation, so this is being designed against a reconstruction. [The
investigation](research.md) sets out exactly how much is confirmed — the base
URL, the auth scheme, the webhook create/delete calls and one real payload — and
exactly how much is not. The design below is arranged so that the unconfirmed
parts narrow the connector rather than break it.

## Goals

1. **A Rally administrator can connect a Clockwork firm to a workspace** by
   pasting the firm's four credential values into Settings, and is told before
   anything is stored whether they work.
2. **The agent can answer questions about the firm's searches** — who is on a
   project, what stage they are at, what the last note said — through read-only
   tools available to every member of that workspace.
3. **A candidacy changing in Clockwork reaches Rally as a normalized activity**,
   through the same ingress, queue, dedupe and matching path every other
   connector uses.
4. **A Sidekick can be triggered by that activity**, narrowed by search project
   and by the candidacy's own fields, using the existing evaluator grammar and
   no new trigger machinery.
5. **A delivery Rally cannot authenticate is never treated as evidence.** What
   a Clockwork webhook says about the world is confirmed by reading the API
   before any of it is shown to a person or a model.
6. **An event name Rally does not recognize is refused, visibly**, with the name
   it refused in the refusal — so the unknown part of Clockwork's event
   catalogue is discovered from production rather than guessed at in advance.
7. **Disconnecting removes the registration from Clockwork**, and a removal that
   cannot be completed is recorded rather than assumed.

## Non-goals

1. **No personal "Connect for me" connection.** Clockwork has no OAuth and no
   per-user credential; a personal connection would be the firm-wide key with a
   single owner's name on it, which reads as a personal-data boundary and is
   not one. **Deferred** — the moment Clockwork issues per-user grants this
   becomes the Granola/Fireflies two-mode shape, and nothing here blocks that.
2. **No third-party MCP broker.** Zapier, Pipedream, viaSocket and Membrane all
   publish a "Clockwork MCP server"; each is a re-broker that would hold the
   firm's recruiting credential, and each wraps the same REST API that Rally can
   call directly. **Rejected outright.** A hosted MCP connection in Rally means
   the provider's own server holding a grant the provider issued, and calling a
   broker by that name would make the distinction unreadable at the exact point
   a customer is deciding whom to trust.
3. **No writes to Clockwork.** The API supports creating people, tags,
   candidacies and notes; this connector does not. **Deferred**, and the reason
   is ordering: an agent that can write into the system of record for a live
   retained search should be designed when there is a firm using the read half
   to say what a write would be for.
4. **No mirror, cache or sync of Clockwork data.** Tools read through to the
   provider on each call. **Rejected outright** — it is the caching layer
   [`CLAUDE.md`](../../../CLAUDE.md) says not to build for a product that has no
   load history, and a stale slate is worse than a slow one.
5. **No subscription narrowing at registration.** `POST /webhooks` accepts a URL
   and nothing else, so Rally cannot ask Clockwork for fewer events. Filtering
   happens on arrival. **Rejected** because it is not available, not because it
   is undesirable; [question 3](research.md#open-questions-for-clockworks-integrations-team)
   would reopen it.
6. **No digest news in v1.** Every declared activity type is `operational`. See
   [Product behavior](#what-a-digest-may-read).
7. **No Clockwork resource watches.** `supportsWatches: false`. A watched
   resource is a document going stale; a candidacy is a workflow record, and the
   automation trigger is the right instrument for it. **Deferred.**
8. **No dedicated `clockwork.rallywith.ai` Worker.** Ashby needs one because a
   single provider account fans out to several regions and the signed bytes must
   reach each unchanged. Clockwork registers one URL per call, so each workspace
   registers its own region's ingress directly. **Rejected as unnecessary.**

## Product behavior

### Connecting

Settings → Connections shows **Clockwork** with a workspace row only. There is
no **Connect for me** button, and its absence is explained rather than left to be
noticed: the catalogue entry says a Clockwork connection is a firm-level
credential held by the workspace, because Clockwork issues no personal one.

**Connect for workspace** requires a Rally administrator and asks for four
values, because Clockwork's auth needs four:

| Field | Example | Why it is separate |
| --- | --- | --- |
| Firm identifier | `meridianpartners` | Goes in the URL path |
| API key | | Pairs with the secret |
| API secret | | Pairs with the key |
| Firm service key | | A second key, sent as `X-API-Key` |

The dialog says where they come from — Clockwork's _How to Create API Keys_
article, and `support@clockworkrecruiting.com` for a firm whose API access is
not yet switched on — and that the API is included in every Clockwork
subscription, so nobody goes looking for an upgrade.

Before anything is stored, Rally validates the credentials against a cheap read
(`GET /people?limit=1`) and records the firm identifier on the connection so
Settings can say **whose** Clockwork this is. A rejected credential fails the
dialog with the reason; nothing is written. This is the Fireflies `validate`
contract, and it matters more here than there: four fields is four ways to
paste one of them wrong, and "one of these is wrong" is not a diagnosis.

On success Rally creates the webhook registration (`POST /webhooks`) pointing at
that workspace's regional ingress URL, and stores the returned `id`. If the
registration call fails, the connection is still created and reports **healthy
with a warning** naming the condition — its read tools work, and only delivery
is missing. Granola's rule: a health check never repairs an installation, and
delivery is restored through **Test** and the installation lifecycle.

### What the agent can do

Six tools, all read-only, all available to every member of the workspace,
executing as the workspace principal:

| Tool | Reads | Notes |
| --- | --- | --- |
| `search_people` | `GET /people` | Bounded page, [first/next cursor](../../tool-pagination.md) over Clockwork's `limit`/`offset` |
| `get_person` | `GET /people/{id}` plus requested sub-resources | Takes an `include` array: `positions`, `emails`, `phone_numbers`, `education`, `tags`, `websites`, `notes` |
| `list_projects` | the firm's search projects | |
| `get_project` | one project, with its clients and assigned users | |
| `list_candidacies` | the candidacies on one project | The slate |
| `get_candidacy` | one candidacy, with its status **resolved to a name** | |

`get_person`'s `include` is the shape decision worth defending. Clockwork
exposes a dozen per-person sub-resource collections, and one tool per collection
would be a dozen tools that each answer a third of a question — the agent would
call four of them to describe one candidate. One parameterized read of a person
is the Lego block; the collections are its facets. Whatever ships must be under
the response cap, so each included collection is bounded independently and a cut
is reported through a `truncated` flag rather than silently.

Status resolution is not a nicety. Clockwork's candidacy carries `status_id` as
a UUID and nothing else, so a tool that returned it faithfully would return a
fact no person and no model can read. `get_candidacy` resolves it against the
firm's candidacy statuses and returns the name; the id rides alongside for a
rule that wants to match on it.

### When something changes in Clockwork

A candidacy changes; Clockwork posts to the workspace's ingress URL. Rally:

1. **Authenticates the request by its URL**, which carries a high-entropy
   per-connection ingress token. Clockwork signs nothing, so this is the whole
   of the transport's authentication and the design treats it as such — see
   [Security and trust model](#security-and-trust-model).
2. **Parses the envelope** and refuses an unrecognized `event_name` with `400
   unsupported_webhook_event`, **naming the event it refused**, per
   [`connectors.md`](../../connectors.md#granola) and
   [naming a schema failure](../../naming-a-schema-failure.md).
3. **Dedupes** on `(event_name, resource id, updated_at)`, because Clockwork
   sends no delivery id.
4. **Hydrates** — reads the candidacy, its person, its project and its status
   name back from the API. Nothing from the delivery body reaches an activity
   title, a summary, or a model.
5. Normalizes, queues, and enters the existing pipeline: dedupe receipt,
   `WorkspaceDO.ingestConnectorEvent`, `matchExternalEventDestinations`,
   one message per matched registration.

The activity a person eventually sees reads **"Priya Raghunathan moved to Client
Interview on Meridian — CFO"**, and every word of it came from an authenticated
read rather than from the untrusted post that prompted it.

Hydration happens after the acknowledgement path is clear and before opportunity
admission, the same way Fireflies reads a meeting it was only told the id of.
A candidacy that has since been deleted hydrates to nothing; the delivery is
acknowledged and no activity is written, because a change to a record that no
longer exists is not news.

### Events Rally subscribes to and ingests

Clockwork's `POST /webhooks` takes a URL and no event list, so "subscribe" here
means **which arriving names Rally admits**, not which it requested.

| `event_name` | Rally activity type | Admitted | Why |
| --- | --- | --- | --- |
| `candidacy_updated` | `candidacy.updated` | **Yes** | Confirmed from a real payload. The event the product is for: a candidate's state on a search changed. |
| `candidacy_created` | `candidacy.created` | **Yes, on confirmation** | A person joining a slate. Named by Zapier as a trigger; the webhook spelling is unconfirmed. |
| `person_created` | `person.created` | **Yes, on confirmation** | A new person in the firm's network. |
| `person_updated` | `person.updated` | **Yes, on confirmation** | Contact and position changes are what keeps a network usable. |
| anything else | — | **No** | Refused with `400 unsupported_webhook_event`, naming it. |

Only the first row ships without an answer from Clockwork. The other three are
written, tested against fixtures, and **enabled by the answer to [question
1](research.md#open-questions-for-clockworks-integrations-team)** — because
admitting a name we guessed from a naming convention would either silently never
fire or silently admit a payload shaped differently from the schema we wrote.

The refusal is the discovery mechanism, and that is deliberate. Each refused
delivery logs the name it refused, so the unknown part of Clockwork's catalogue
arrives in the logs of the first firm to use the connector — the platform's own
failure as the monitoring, per [`CLAUDE.md`](../../../CLAUDE.md).

### What a digest may read

**Every Clockwork activity type is `operational`.** None are digestible.

The question [`connector-digestibility.md`](../../connector-digestibility.md)
asks is whether a person away for a day wants this read back to them, and for
`candidacy_updated` the answer is no despite how important the underlying change
is. The event fires on **any** field of a candidacy — a rank nudged, a note id
attached, a colour category set — and Clockwork does not report which field
moved. A digest fed from it would be mostly rank adjustments, and a partner who
learned to skim it would skim the one that mattered.

This matches Ashby, whose `candidateStageChange` is operational for the same
reason. Operational is not a rejected event: it is normalized, routed, matched
against automations, and written to the activity log. It simply never interrupts
somebody on a schedule. The interruption a partner wants is a Sidekick that
fires on a **narrowed** rule, which is the next section.

### Triggering a Sidekick

Because the connector declares its activity types with typed filter fields, the
existing trigger grammar covers this with no new machinery. A partner drafts a
Sidekick conversationally; the drafting agent calls `plugins_search`, sees
Clockwork's triggers, calls `resources_search` to bind the search project, and
calls `set_evaluator_rules`.

Three rules the declared attributes make expressible:

**"Tell me when anyone on the Meridian CFO search goes red."**
`candidacy.updated`, bound to the `clockwork_project` resource, `allOf:
[stoplightStatus equals "red"]`.

**"Open a work stream when a candidate reaches Client Interview on any search."**
`candidacy.updated`, `allOf: [statusName equals "Client Interview"]`, unbound,
so it covers every project.

**"When someone joins a slate, pull their last three roles into the project's
work stream."** `candidacy.created`, bound to a project — which is why
`candidacy.created` is worth having as a distinct type rather than folding it
into `updated`.

A rule that needs OR is two rules; the grammar is one AND group, deliberately.

The run then uses the read tools as any run does: `get_candidacy` for the state,
`get_person` for the history, `get_project` for who the client is. **The trigger
and the tools are the same connection**, which is the reason workspace scope
carries read tools here and does not for Ashby — Ashby can send a recruiting
question to a personal MCP connection, and Clockwork has nowhere to send it.

Because activity arrives only in workspace scope, the connector declares
`activityConnectionScopes: ["workspace"]`. Nothing else is needed to make the
catalogue honest: a personal connection cannot exist for Clockwork at all, so
the "a workspace connection is required" sentence
[`automation-lifecycle.md`](../../automation-lifecycle.md#drafting-in-the-conversation)
generates never has to be shown.

### Disconnecting

Disconnect immediately stops local access and queues `DELETE /webhooks/{id}`
against Clockwork. Removal authority is retained separately and encrypted, so a
repeated disconnect does not erase the ability to finish the removal. A removal
that cannot complete is recorded as uncertain rather than reported as done —
and because Clockwork publishes no `GET /webhooks`, an orphaned registration
cannot be discovered later by inspection. Deliveries to a removed connection are
rejected at the ingress, which is what bounds the consequence.

## Impact on the product contract

None. This adds one connector inside the existing contract: a workspace
connection is an organization capability, its tools execute as the workspace
principal, its activity enters the one event pipeline, and it creates no
channel, no global inbox and no global search.

One clause is worth checking explicitly because the connector is close to it.
[The brief](../2026-08-05_avalon-implementation-brief/prd.md) holds that a work
stream belongs to the conversation it started in and that there is no semantic
route into an existing work stream. This connector adds no such route: a
Clockwork event reaches a Sidekick through an explicit registration the partner
drafted, or it reaches the activity log and Suggested Work, and nothing else.

## Decision log

None yet.

## Key design decisions

1. **Workspace-only, with read tools.** Clockwork issues one firm-wide
   credential and no per-user grant, so scope follows the credential.
   _Rejected:_ a personal connection over a pasted key. It would present a
   firm-wide read as one person's connection — the opposite of what "personal"
   means everywhere else in Settings — and every member of the firm pasting the
   same secret is worse credential hygiene than one administrator doing it once.

2. **Rally authors the tools; no MCP broker.** _Rejected:_ Zapier's or
   Pipedream's Clockwork MCP server. Both hold the firm's credential and wrap
   the same REST API. Rally's hosted-MCP pattern means the provider's own server
   and the provider's own grant; a broker under that label would be a category
   error a customer could not see through, at the moment they are deciding
   whether to hand over a recruiting database.

3. **Every delivery is hydrated before it is believed.** _Rejected:_ normalizing
   the delivery body directly. Two reasons compound: Clockwork's payload is
   UUIDs with no human-readable field in it, so it could not produce a legible
   activity anyway; and it is unauthenticated, so believing it would let anyone
   who guesses an ingress URL write into a workspace's activity log. Hydration
   answers both with one round trip, and Fireflies already does it.

4. **The URL is the credential, and it is treated as one.** Clockwork signs
   nothing, so there is no better option available. It is recorded here as a
   constraint accepted with open eyes rather than a mechanism chosen: the
   ingress token is high-entropy, never logged, rotatable by re-registering, and
   load-bearing only because hydration means a forged delivery can at most cause
   Rally to re-read a record it is entitled to read. _Rejected:_ shipping an
   unauthenticated ingress and relying on hydration alone — a forged delivery
   would still be an unauthenticated stranger choosing which records Rally reads
   and how often.

5. **`get_person` takes an `include` array.** _Rejected:_ one tool per
   sub-resource collection. Twelve tools that each answer a third of a question
   is not a platform; a parameterized read of one entity is. This is the
   [`CLAUDE.md`](../../../CLAUDE.md) platform rule applied to a tool surface.

6. **Three of the four event types ship dark.** _Rejected:_ enabling all four on
   the strength of a naming convention. A guessed event name fails in the worst
   available way — it either never fires, which looks like a broken connector,
   or it fires with a body shaped differently from the schema and produces a
   parse failure a partner sees as Rally being wrong about their data.

7. **No defensive numbers are invented.** Page sizes, response caps, hydration
   concurrency and the ingress body limit are all guards this design requires and
   whose _numbers_ it does not set, per
   [`adding-security-defensive-and-other-limits.md`](../../adding-security-defensive-and-other-limits.md).
   Clockwork's own rate limits are not publicly obtainable
   ([research](research.md#rate-limits)), so the retry path is built to read the
   provider's throttling response rather than to pre-empt it.

## Data model

New contract module `packages/contracts/src/clockwork-events.ts`, following
`ashby-events.ts`:

```ts
export const ClockworkEventTypes = [
  "candidacy.updated",
  "candidacy.created",
  "person.created",
  "person.updated",
] as const;
```

The webhook envelope is a discriminated union on `event_name`, because the
resource arrives under a key named after itself rather than a generic `data`:

```ts
const ClockworkCandidacySchema = z.object({
  id: z.string().min(1),
  person_id: z.string().min(1),
  project_id: z.string().min(1),
  status_id: z.string().min(1),
  created_user_id: z.string().min(1).nullable(),
  rank: z.number().finite().nullable(),
  stoplight_status: z.string().nullable(),
  color_category: z.string().nullable(),
  assessment_note_id: z.string().nullable(),
  next_steps_note_id: z.string().nullable(),
  overview_note_id: z.string().nullable(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

const ClockworkWebhookEventSchema = z.discriminatedUnion("event_name", [
  z.object({ event_name: z.literal("candidacy_updated"), candidacy: ClockworkCandidacySchema }),
  z.object({ event_name: z.literal("candidacy_created"), candidacy: ClockworkCandidacySchema }),
  z.object({ event_name: z.literal("person_created"),   person:    ClockworkPersonRefSchema }),
  z.object({ event_name: z.literal("person_updated"),   person:    ClockworkPersonRefSchema }),
]);
```

Every string that cannot be empty says so, per
[`connectors.md`](../../connectors.md), and a parse failure is wrapped in a
`ConnectorError` with a code rather than surfacing a bare `ZodError` — a signed
but unexpected body must not become a 500.

Hydration reads get their own schemas — `ClockworkPersonSchema`,
`ClockworkProjectSchema`, `ClockworkCandidacyStatusSchema` — parsed at the
provider boundary, not trusted into tool output. Each caps its
provider-controlled strings and arrays and reports a cut through `truncated`.

### Resource types and relationships

`resourceTypes: ["clockwork_person", "clockwork_candidacy", "clockwork_project"]`.

`candidacy.updated` and `candidacy.created` declare
`resourceRelationships: [{ relationship: "project", resourceType:
"clockwork_project" }]`, which is what puts the search project into
`automationBindableResourceTypes` and makes "on the Meridian CFO search"
expressible as a bound rule rather than a string comparison.

**A declared relationship that nothing materializes is a defect**, and
[`automation-lifecycle.md`](../../automation-lifecycle.md#triggers-and-occurrences)
names Granola's `granola_folder` as the standing example: a searchable type with
no rows reads to the model as a search miss. So hydration writes the
`clockwork_project` discovery upsert on every candidacy event, and
`resources_search` returns projects the workspace has actually seen.

### Filter fields

Per-type, on both candidacy events:

| Key | Value type | What it narrows |
| --- | --- | --- |
| `projectId` | `string` | One search, for a rule that would rather match than bind |
| `personId` | `string` | One person across every search they are on |
| `statusId` | `string` | An exact status, stable across renames |
| `statusName` | `string` | The readable spelling — what a partner says out loud |
| `stoplightStatus` | `string` | `red` / `yellow` / `green` |
| `rank` | `number` | Slate position |

`statusName` is hydrated, not delivered, which is the point: the payload's
`status_id` is unreadable, and a rule grammar the drafting agent can only fill
with UUIDs is a grammar nobody writes a rule in.

### Activity types

| Activity type | Digestible | Reason |
| --- | --- | --- |
| `candidacy.updated` | No | Fires on any field of a candidacy, and Clockwork does not report which changed; a digest of it would be mostly rank adjustments. The narrowed automation rule is the instrument for the ones that matter. |
| `candidacy.created` | No | A slate addition is recruiting workflow, not workspace-wide news. |
| `person.created` | No | Network growth; operational recruiting data. |
| `person.updated` | No | Contact and position maintenance. |

These rows land in
[`connector-digestibility.md`](../../connector-digestibility.md) in the same
change as the manifest — `digestibility-doc.test.ts` fails otherwise.

## Security and trust model

**Clockwork authenticates nothing it sends.** There is no HMAC, no signing
secret, no timestamp header, and no challenge handshake — so the [unsigned
subscription handshake pattern](../../connectors.md#unsigned-webhook-subscription-handshakes)
does not apply either: that pattern exists for a provider that delivers a
plaintext secret once, and Clockwork delivers none. This is the weakest inbound
posture of any connector Rally has shipped, and the design's job is to make the
consequence of a forged delivery small rather than to claim it cannot happen.

Three properties bound it:

1. **The ingress URL carries a high-entropy per-connection token.** It is
   generated by Rally, stored encrypted with AES-GCM and connection-ID
   additional authenticated data alongside the Clockwork credentials in the
   owning WorkspaceDO, never returned to the desktop, and never logged — the
   whole URL, not just a query parameter, because
   [`connectors.md`](../../connectors.md#unsigned-webhook-subscription-handshakes)
   records that edge observability captures complete URLs. Rotation is
   `DELETE /webhooks/{id}` followed by `POST /webhooks` with a fresh token.
2. **A delivery is never evidence.** Hydration means the worst a forged
   delivery achieves is causing Rally to re-read records the workspace is
   already entitled to read, and to write an activity that is true. It cannot
   inject text into a work stream, a digest, or a model's context, because none
   of its bytes get there.
3. **An unrecognized name is refused before anything is written** — no receipt,
   no payload row, no activity — so an attacker cannot fill storage with
   deliveries naming events that do not exist.

The four credential values are admin-only on the way in, encrypted at rest in
the WorkspaceDO connector row, decrypted only for the duration of a backend
operation, and never returned to the desktop or placed in routing metadata,
provider identifiers, audit data or telemetry.

What the key can read is the whole firm. Clockwork has no read-only credential
class that the public material describes ([question
8](research.md#open-questions-for-clockworks-integrations-team)), so the
connection's setup copy states plainly that every member of the Rally workspace
can read whatever the firm's Clockwork key can — Fireflies' precedent for
stating an uncertainty rather than guessing at it. For a search firm this is
usually correct and occasionally not, and the administrator is the right person
to make that call with the sentence in front of them.

Personally identifying data is unavoidable here: this connector reads candidate
contact details for a living. It does not persist them beyond the normalized
activity and the resource rows, tools read through to the provider rather than
mirroring, and disconnecting stops access immediately.

## Agent behavior

The agent gains the six read tools above through `plugin_clockwork`, loaded like
any other connector plugin, executing as the workspace principal under the
connection's recorded capability. Every tool is a read; the connector declares
no write capability, so there is nothing for the write-execution path to do and
no receipt beyond the ordinary tool record.

Rally never asks a member to confirm an individual Clockwork tool call, per
[`CLAUDE.md`](../../../CLAUDE.md).

Two behaviors are the agent's responsibility rather than the adapter's, and the
tool descriptions carry them:

- **A candidacy status is a name, not a judgement.** "Client Interview" means
  what the firm configured it to mean; the agent reports the stage and does not
  infer how well a candidacy is going from its spelling.
- **`stoplight_status` is the partner's own assessment.** Red means a person
  wrote red. The agent reports it as the firm's assessment, not as a fact about
  the candidate.

Every tool's parameters are described, per the connector parameter-description
rule, and list tools answer in an envelope with a `truncated` flag and a
cursor.

## Provider configuration

Outside the repository, before the connector is usable by a firm:

| What | Where | If it is missing |
| --- | --- | --- |
| API access enabled for the firm | Clockwork; included in every subscription, switched on by `support@clockworkrecruiting.com` | Every call returns 403 and setup fails at validation |
| An API key/secret pair and the firm service key | Clockwork admin, per their _How to Create API Keys_ article | Setup cannot be completed |
| The firm identifier (URL slug) | The firm's Clockwork URL | Every call 404s |
| The developer documentation | Requested from Clockwork support | The four event names stay at one; see [open questions](research.md#open-questions-for-clockworks-integrations-team) |

Nothing is required in Cloudflare beyond the regional ingress route, and no
Rally-owned provider app registration exists to create — Clockwork has no OAuth
application model. [`provider-apps.md`](../../provider-apps.md) gains a row
saying exactly that, so the next person checking does not go looking.

**The last row is the one that gates delivery scope.** The connector ships with
`candidacy_updated` alone if that conversation has not happened.

## Rollout

**No flag.** Asked and answered by the product owner on 2026-09-17: this ships
on merge to every region.

The reasoning, recorded because a "no" is a decision: a new connector type is
additive and inert. Until an administrator pastes a credential there is no
connection, no registration, no ingress route in use and no tool in any run's
inventory — the flag would gate a catalogue row and nothing else. This differs
from Fireflies, which took `FIREFLIES_CONNECTOR_ENABLED` because its rollout was
staged region by region against a provider Rally could not test against; nothing
here is staged.

Turning it off, if it goes wrong: disconnect the affected connection, which
stops access immediately and queues the registration removal. There is no
migration and no backfill, so there is nothing to reverse. A defect in ingest is
bounded by the same property that bounds a forged delivery — deliveries are
change signals, so a stopped connector loses notifications and no data.

Sequencing, for a `plan.md` written later:

1. Adapter, manifest, contracts and tools, with `candidacy_updated` only.
2. Installation lifecycle: create, validate, remove, Test, and the health
   warning for a connection whose registration is missing.
3. Documentation: a `docs/clockwork-integration.md` module document, the
   digestibility rows, the `provider-apps.md` row, and the index registration.
4. The other three event types, enabled by Clockwork's answer and not before.
