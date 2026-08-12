# Connector cards

A **connector card** is a block in a work stream's transcript offering a
connection: the connector's name, why it is being offered, what state it is in
right now — connected, needs reconnecting, not connected — and the one action
that state implies. A block of them is how Avalon asks for access in the place
the request came up, instead of telling somebody to go and find the right row in
Settings.

The whole design turns on one rule: **the message stores which connectors were
offered, and nothing about whether they are connected.** A transcript row is
durable and a connection is not, so a state written beside the offer is wrong
within seconds of somebody acting on it and still there a year later. Read this
before changing the block's payload, what a card renders, or what happens when
Connect is pressed; [`CONNECTORS.md`](CONNECTORS.md) owns the connector registry
and adapters this sits on top of.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/connector-offerings.ts` | **The registry.** Every offering — id, connector type, name, description, icon, scopes, and the capabilities each scope asks for — plus the block schema, the card limit, and the fallback sentence. The single source for all three surfaces. |
| `apps/api/src/services/connector-card-service.ts` | Writes the block into a transcript and publishes it. Also the dedupe and the scope check every producer runs first. |
| `packages/agent-harness/src/index.ts` → `AVALON_SHOW_CONNECTOR_CARDS_TOOL_DEFINITION` | The agent tool's model-facing contract and its strict input schema. |
| `apps/api/src/services/integrations.ts` → `createAvalonTools` | The tool's executor, and the `avalon:core` plugin it is registered in. |
| `apps/desktop/src/renderer/lib/connector-offerings.ts` | The renderer's view of the registry: icons, the Linear native-agent flag, and `connectorCardStatus` — **the only place a card's state is decided**. |
| `apps/desktop/src/renderer/lib/use-connector-authorization.ts` | Starting an authorization and waiting for the browser to finish it. Shared with the Settings pane. |
| `apps/desktop/src/renderer/components/connector-cards.tsx` | The block and its cards. `ConnectorCardsBlock` is presentational; `ConnectorCardsMessage` wires it to `['connections']`. |
| `apps/desktop/src/renderer/lib/api.ts` → `mapMessage` | Recognizes the block on a `system` row and gives it the client message type `connector_cards`. |

## How it works

### The offering, not the provider

A card names an **offering**, not a connector type. Google is one connector with
one OAuth client and two offerings — mail and calendar, or Drive and the editors
— because nobody wants the union of those grants in order to read one document.
So `google-drive-workspace` and `google-mail-calendar` are separate ids with
separate capability lists, and everything downstream keys on the offering.

That distinction is also why a card's state cannot be resolved by connector type
alone: a Gmail connection would otherwise light up the Drive card and hide the
authorization that actually reads documents. `connectionMatchesOffering`
compares the *capabilities* a connection was granted against the ones the
offering asks for. An offering that declares none — the inbound webhook — matches
on type, which is correct for it because there is nothing narrower to compare.

### Publishing a block

`publishConnectorCards` writes one `messages` row: `author_type = 'agent'`,
`message_type = 'system'`, `structured_content_json` holding
`{ kind: "connector_cards", heading?, cards: [{ offeringId, scope?, note? }] }`,
and `text_content` holding a plain sentence from `connectorCardsFallbackText`.
It moves `latest_attention_sequence_number`, because a card asks for something
only a person can do, and publishes `message_created` to the work-stream room.

`system` is deliberate on both counts. The row is interface state rather than
something anybody said, which is what keeps it out of the model transcript; and
it means no new value was added to the wire `messageType` enum, so a client
released before this feature renders the sentence in `text_content` instead of
failing the whole transcript page on an unknown enum member.

The desktop client discriminates on the structured content instead, in
`mapMessage`, and gives the block its own *client-side* message type. The client
enum already diverges from the wire one this way — `tool` becomes `tool_event`,
`suggestion` becomes `activity_suggestion`.

### The agent tool

`core_show_connector_cards` takes `connectors: [{ connector, scope?, note? }]`
and an optional `heading`. `connector` is an offering id, and because the schema
is a `z.enum` the valid values reach the model in the JSON schema, so it needs no
lookup call to discover them.

The executor dedupes `(offering, scope)` pairs, rejects a scope the offering does
not support with `connector_card_scope_unsupported` and a hint rather than an
exception, and derives the row's `client_message_id` from the tool receipt so a
replayed call converges on the one block it already wrote. It returns
immediately with `state: "offered"` — it does not block the run, and it grants
the run nothing.

The tool call and its result *are* replayed into later runs, unlike the card row
itself, so an agent can see that it already made the offer.

### Rendering, and where the state comes from

`ConnectorCardsMessage` reads `['connections']` — the same react-query key the
Settings pane and the authorization hook use — so every card in every open work
stream shares one fetch, and a connection made anywhere updates all of them
without a reload. `connectorCardStatus` maps the matching connections to one of
four states, preferring a healthy connection over one needing reconnection:

| State | What the reader sees | Action |
| --- | --- | --- |
| `connected` | Connected, with the scope it is connected in | **Manage**, which opens Settings |
| `needs_attention` | Needs reconnecting | **Reconnect**, which re-authorizes that connection |
| `disconnected` | Not connected | **Connect** |
| `unknown` | Checking… | disabled |

A card whose block named no scope offers the choice, when the offering has more
than one, rather than silently picking the narrower grant. Pressing **Connect**
calls `POST /connections/<provider>/start` with the offering's capabilities for
the chosen scope, opens the system browser, and waits on the attempt.

Offerings that cannot be finished in a browser redirect — the inbound webhook,
which mints a signing secret shown once, a workspace Granola connection, which
needs an admin API key, and X, which is created outright — declare no
`oauthScopes` for that scope and their button opens Settings instead of starting
something a transcript cannot complete.

## Invariants

- **No card state is ever stored in the message.** The row outlives every
  connection decision made after it. Storing `connected: true` beside the offer
  produces a card that confidently contradicts Settings, and there is no event
  that would come back to correct it. `connectorCardStatus` is the only place
  state is decided, and it reads live connections.
- **Capabilities live in the registry, never at a call site.** They are what the
  OAuth start endpoint is called with, so a second list is a second grant: a
  member gets a narrower connection depending on which button they pressed, and
  nothing fails until a tool call does, in a different session, with an error
  that names neither surface.
- **A card names an offering, and matching uses capabilities.** Matching on
  connector type alone silently merges Google's two offerings — and any future
  provider split the same way — reporting one as connected because the other is.
- **The wire `messageType` stays `system`.** Adding an enum member is a breaking
  change for every already-released desktop build, which validates the whole
  transcript page against the contract. New block types discriminate on
  `structuredContent.kind`, as `suggested_work_expansion` and `inbound_email`
  already do.
- **`text_content` is never empty.** It is what an older client, a plain-text
  export, and anything else reading transcripts as prose will show. The sentence
  comes from `connectorCardsFallbackText` so every producer writes the same one.
- **The tool grants nothing.** `core_show_connector_cards` shows an offer and
  returns; the run's authority is frozen at admission and a card cannot widen
  it. An agent that treats a published card as a connection will call a tool it
  is not authorized for.
- **One authorization loop.** The Settings pane and a card in a transcript both
  go through `useConnectorAuthorization`. Two implementations would disagree
  about when a connection exists, and only one of them would invalidate
  `['connections']`.

## Boundary

Connector cards own the *offer*: which connectors are put in front of a reader,
what state each one is in, and the first step of connecting one. They own no
credential, perform no OAuth exchange, and decide no authorization.

They do not own: the connector registry, manifests, or adapters
([`CONNECTORS.md`](CONNECTORS.md)); the OAuth start, callback, and credential
storage (`ConnectionService`, and [`PROVIDER_APPS.md`](PROVIDER_APPS.md) for the
registrations); what the agent may call once a connection exists
([`AGENT_HARNESS.md`](AGENT_HARNESS.md)); or the Settings pane's inventory of
installed connections, which is a different question — *what do I have* rather
than *what is being asked of me*.

Producers: the agent tool today. `publishConnectorCards` is deliberately a plain
function taking `Env`, so anything else that wants to make the same offer —
onboarding, an automation that discovers it needs a connector — publishes the
same block rather than inventing a second card type.

## Failure modes and limits

| Limit | Value |
| --- | --- |
| Cards per block | 6 (`CONNECTOR_CARDS_MAX`) |
| Offerings in the registry | 9 |
| Card note | 240 characters |
| Block heading | 120 characters |
| Authorization wait before it is abandoned | 16 minutes, polled at 1s and backing off to 5s on error |

- **The connections read fails.** No card claims a state — all four cards show
  `Checking…` with a disabled button — and the block says once that Avalon could
  not check, pointing at Settings. A failed read must never render as "not
  connected", which would invite somebody to authorize a connection they already
  have.
- **The authorization is cancelled, denied, or expires.** The hook reports it on
  the block, and every card stays exactly as it was. Nothing is written.
- **A duplicated card.** Dropped by `dedupeConnectorCards` before the row is
  written, because two identical cards means two Connect buttons of which the
  second is dead the moment the first is used.
- **An unsupported scope.** Returned to the model as a structured error naming
  the scopes the offering does have. It is deterministic bad input, so it must
  not throw — a throw is classified as transient and retried unchanged.
- **A block naming an offering this Avalon region has not configured.** The card
  renders and Connect starts an authorization that fails at the provider. The
  Settings pane checks `GET /connections/catalog` for this and cards do not; it
  is a real gap, kept because a card is published by an agent that already had
  the connector in its catalog, and the failure is legible when it happens.

## Security and trust model

The block carries no credential and no connection id — only offering ids from a
closed enum, an optional scope, and a note. A malformed or hostile
`structured_content_json` fails `ConnectorCardsBlockSchema` in the renderer and
the row falls back to being an ordinary system message, so nothing about the
payload can select an arbitrary provider or capability: the capabilities sent to
the OAuth start endpoint are read from the registry by offering id, never from
the message.

Pressing **Connect** is a person authorizing something in their own browser
session. Nothing an agent writes can complete an authorization, and the run that
published the block does not gain access to whatever gets connected — its scope
was frozen at admission ([`AGENT_HARNESS.md`](AGENT_HARNESS.md)).

## Testing

```bash
pnpm --filter @avalon/contracts exec vitest run src/connector-offerings.test.ts
pnpm --filter @avalon/api exec vitest run test/core-tool-idempotency.test.ts
pnpm --filter @avalon/desktop exec vitest run src/renderer/components/connector-cards.test.tsx
```

- `connector-offerings.test.ts` keeps `ConnectorOfferingIdSchema` and the
  registry in step. That pairing is hand-maintained because `z.enum` needs a
  literal tuple to produce a union type, and the test is what stops the two
  drifting into an id nothing can render or a card nothing can publish.
- `core-tool-idempotency.test.ts` runs the tool against a migrated in-memory
  SQLite database and asserts that a replayed call writes one row, that the row
  is `system`/`agent` with the fallback sentence, and that the work stream is
  *not* left in `needs_input` — a card does not pause a run, which is the one
  behavior it must not inherit from the elicitation tool beside it.
- `connector-cards.test.tsx` renders the presentational block directly with a
  fake authorization object, so no session or query client is needed. The
  Google-split case is the regression fixture for capability matching; delete it
  and matching by connector type passes every other test in the file.
- `workstream-blocks.test.tsx` covers the dispatch, and needs both a
  `QueryClientProvider` and a mocked `useAppSession` — `ConnectorCardsMessage`
  fetches connections itself.

## Data model

No tables of its own. One `messages` row per block, with the payload in
`structured_content_json` and idempotency on the existing
`UNIQUE (workstream_id, client_message_id)`. The `message_type` CHECK constraint
is untouched, which is the point of using `system`.

## Changelog

### 2026-08-12 — Connections can be offered in the feed, and the offer stores no state

**What changed:** A work-stream transcript can carry a block of connector cards.
Each names an offering, shows its live connected/reconnect/not-connected state,
and connects it in place. `core_show_connector_cards` lets an agent publish one —
during onboarding, or whenever a missing connection is what blocks the work.
Every offering's name, scopes, and capabilities moved into a shared registry in
`@avalon/contracts` that the Settings pane, the cards, and the agent tool all
read, and the OAuth wait the Settings pane ran was extracted into
`useConnectorAuthorization` and is now shared with the cards.

**Why:** Asking for a connection in prose ends the conversation. The reader has
to find Settings, then find the right row among nine offerings, then guess which
of the two Google entries the request meant — and the agent never learns whether
they did. The onboarding case makes it worse, because the person being asked is
the one least able to answer any of those questions. Putting the offer where the
request was made removes all three steps, and showing the live state is what
makes it honest: half of what a new member is offered is usually already
connected by somebody else, and a card that cannot say so is asking them to
redo work.

**Considered and rejected:** *Storing each card's state in the message.* It is
the obvious shape — the producer knows the state, and the renderer would need no
query — and it is wrong in a way that only shows up later: the row is durable,
the state is not, and there is no event that comes back to correct a stale card.
A transcript scrolled back to six months from now would show confident,
contradictory claims about what is connected. Resolving at render time from
`['connections']` costs one shared query and can never be stale.

*A new `messageType` on the wire.* Cleaner to read, and a breaking change for
every released desktop build: the client validates each transcript page against
the contract, so an unknown enum member fails the whole page rather than one
row. Discriminating on `structuredContent.kind` follows what
`suggested_work_expansion` and `inbound_email` already do, and lets an older
client render the fallback sentence.

*Cards naming a connector type rather than an offering.* Simpler payload, and it
cannot express the only case that is actually hard: Google's two offerings share
a connector type and an OAuth client, so a type-keyed card would ask for
whichever capability set the code picked, and would report Drive as connected
because Gmail was. The same reasoning is why `connectionMatchesOffering`
compares capabilities rather than types.

*Leaving the Settings pane's catalog and OAuth loop where they were.* That would
have been two copies of every capability list and two implementations of the
authorization wait. The capability copies are the dangerous half: they drift
silently, and the symptom is a member with a narrower grant than a colleague
with no error anywhere. The registry now holds one copy and the pane derives
from it.

*Making the tool block the run until somebody connects.* It sits next to
`core_request_elicitation`, which does exactly that, and the parallel is
tempting. A card is not a question: several may be shown at once, some may
already be connected, and none of them need answering for the conversation to
continue. Halting would strand a run on an offer nobody was obliged to accept.

**Consequences:** The offer is a `system` row, so it is not replayed into the
model transcript — an agent's evidence that it already offered is its own tool
call and result, which *are* replayed. Any second producer must publish through
`publishConnectorCards` rather than writing its own row, or the fallback
sentence, the dedupe, the attention marker, and the realtime publish drift apart
one at a time. Adding an offering means adding it to `CONNECTOR_OFFERINGS` *and*
`ConnectorOfferingIdSchema`; the test that pairs them is what stops that being a
silent half-change. A card does not check `GET /connections/catalog`, so an
offering unavailable in a region renders and fails at the provider — acceptable
while the only producer is an agent whose catalog already contains the
connector, and the first thing to revisit if a non-agent producer appears.

Shipped in #TBD.
