# Connector cards

A **connector card** is an offer of a connection made in a work stream's
transcript: the connector's name, why it is being offered, what state it is in
right now — connected, needs reconnecting, not connected — and the one action
that state implies. It is how Avalon answers "send my boss three open slots from
my calendar" when no calendar is connected, instead of refusing the request or
sending somebody to find the right row in Settings.

The offer has two halves. Finding *what could* answer a request is
`core_find_connectors`, over a registry of offerings tagged with the categories
people describe needs in. Putting it in front of somebody is either a Markdown
link inside the agent's own sentence or a standalone block published by
`core_show_connector_cards`.

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
| `packages/contracts/src/connector-offerings.ts` | **The registry.** Every offering — id, connector type, name, description, icon, categories, scopes, and the capabilities each scope asks for — plus the block schema, the card limit, the fallback sentence, and `connectionMatchesOffering`. The single source for every surface. |
| `apps/api/src/services/connector-recommendation-service.ts` | `findConnectorOfferings`: which connectors could answer a need, and what stands between this run and each of them. |
| `apps/api/src/lib/connector-run-eligibility.ts` | The one rule saying whether a run may see a connection at all. Shared by the plugin loader and the recommendation read so they cannot disagree. |
| `apps/api/src/services/connector-card-service.ts` | Writes the block into a transcript and publishes it. Also the dedupe and the scope check every producer runs first. |
| `packages/agent-harness/src/index.ts` → `AVALON_SHOW_CONNECTOR_CARDS_TOOL_DEFINITION` | The agent tool's model-facing contract and its strict input schema. |
| `apps/api/src/services/integrations.ts` → `createAvalonTools` | The tool's executor, and the `avalon:core` plugin it is registered in. |
| `apps/desktop/src/renderer/lib/connector-offerings.ts` | The renderer's view of the registry: icons, the Linear native-agent flag, and `connectorCardStatus` — **the only place a card's state is decided**. |
| `apps/desktop/src/renderer/lib/use-connector-authorization.ts` | Starting an authorization and waiting for the browser to finish it. Shared with the Settings pane. |
| `apps/desktop/src/renderer/components/connector-cards.tsx` | The block and its cards. `ConnectorCardsBlock` is presentational; `ConnectorCardsMessage` wires it to `['connections']`. |
| `apps/desktop/src/renderer/lib/api.ts` → `mapMessage` | Recognizes the block on a `system` row and gives it the client message type `connector_cards`. |
| `apps/desktop/src/renderer/components/workstream-blocks.tsx` → `connectOfferFromHref`, `standaloneConnectOffers` | The `connect:` Markdown scheme, and the one rule that decides chip versus row. |
| `packages/agent-harness/src/prompts/workstream.ts` | The standing policy that teaches the syntax and says to offer rather than refuse. |

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

### Categories, and why they are on the offering

A request arrives as a need — "email my boss", "check my calendar", "file a
ticket" — and almost never as a product name. Every offering therefore carries
one or more categories from a closed set (`email`, `calendar`, `messaging`,
`meetings`, `documents`, `project_tracking`, `code`, `social`, `custom`), which
reaches the model in the tool's JSON schema so the vocabulary is discoverable
from the tool itself.

They sit on the offering rather than the connector manifest because that is the
granularity a person authorizes. Google's mail-and-calendar grant is genuinely
both `email` and `calendar`; Google's other offering is `documents` and shares
neither. A category on the manifest could not express that, and would answer a
request to send mail by offering the Drive authorization.

Every offering has at least one category and every category has at least one
offering, both enforced by test: an uncategorized offering is unreachable from
any request that describes a need, and an empty category is a word the model can
spend a call on for nothing.

### Finding what is missing

`findConnectorOfferings` filters the registry by category and by an all-words
query, drops anything this region has no credentials configured for, and
classifies what is left against the connections the run can actually see:

| State | Meaning |
| --- | --- |
| `not_connected` | Nothing to use. Offer it. |
| `needs_reconnect` | A connection exists but the provider stopped honouring it. |
| `connected_not_yet_usable` | Connected *after* this run was admitted, so its tools are not in this run's frozen scope. |
| `connected` | Usable right now. Withheld unless `includeConnected` is set. |

The third state is the one worth the complexity. A person who connects Gmail in
response to a card has a real, healthy connection that Settings and every card
show as connected — and the run that asked for it still cannot use it, because
its authority was frozen at admission. A model told plainly "connected" there
announces it is sending the email and then calls a tool that does not exist.

`connected` is withheld by default because this answers *what is missing*. A
run's existing connections are already in front of the model as loaded and
loadable plugins; repeating them here would be a second, competing catalog.

### Two ways to offer, and one rule that picks between them

Both presentations render the same card against the same live state.

- **In the agent's own text.** `[connect Gmail](connect:google-mail-calendar)`,
  optionally `(connect:github:workspace)` to name the grant. A link inside a
  sentence becomes a chip in that sentence; links standing alone in their own
  paragraph become full-width rows. That is the whole selection rule — there is
  no second syntax and no mode to set, because a model is already deciding where
  each line of its answer goes.
- **As a block of its own**, published by `core_show_connector_cards`. Use it
  when the offer *is* the message rather than part of one: onboarding, or an
  automation run with no prose around it. Only this path is idempotent, moves
  the attention marker, and publishes over the socket.

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

`useConnectorCardSurface` reads `['connections']` — the same react-query key the
Settings pane and the authorization hook use — so every card, row, and chip in
every open work stream shares one fetch, and a connection made anywhere updates
all of them without a reload. `connectorCardStatus` maps the matching connections to one of
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
- **A connect affordance renders only in agent-authored text.** Every author's
  Markdown goes through one `MarkdownBody`, so without the opt-in a Slack
  member, an inbound email, or a quoted provider payload could render a Connect
  button inside a transcript this workspace trusts. The offering set is closed
  and a person still authorizes in their own browser, so the blast radius is
  bounded — but it is somebody else's button, and it does not belong there.
- **Recommendation and plugin discovery answer different questions.**
  `list_plugins` and `search_plugins` describe the frozen run scope, and their
  contract is that everything they name is authority the run already holds.
  `find_connectors` describes what it does *not* have. Merging them makes a
  recommendation look loadable, and `load_plugin` will fail on it.
- **Recommendation may never be looser than loading.** Both go through
  `connectionIsEligibleForRun`. A looser rule here answers "you already have a
  calendar" by describing a colleague's personal credential — a disclosure, and
  a dead end, because the run could not have used it either.
- **`connected` is not one state.** A connection made after admission is real
  everywhere a person looks and unusable in this run. Collapsing
  `connected_not_yet_usable` into `connected` produces a model that says it sent
  the email and then calls a tool that is not there.
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
| Categories | 9, closed set |
| Categories accepted in one `find_connectors` call | 9 |
| `find_connectors` query | 120 characters, all words must match |

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
- **An offering this region has no credentials for.** `find_connectors` drops it,
  so an agent following the intended path never offers one. A block that names
  it directly still renders and its Connect still fails at the provider — the
  card itself does not check availability, which is the remaining gap and the
  first thing to close if a non-agent producer appears.
- **The connector registry will not build.** Availability cannot be determined
  and every offering is reported, because the alternative is telling somebody
  Avalon has no email connector. Logged as
  `connector_registry_unavailable_for_recommendation`; the same fail-open choice,
  for the same reason, as contextual routing's
  [`declaredConfidenceFloor`](contextual-routing.md#failure-modes-and-limits).
- **A sub-agent asking what is connected.** It cannot: `connection.` tools are
  excluded from the child surface. A sub-agent's frozen scope is deliberately
  narrower than its parent's, so a connection the parent holds and uses would
  come back as connected-but-unusable — true of that surface and false of the
  work. The sub-agent reports what it could not investigate; the parent offers.
- **A connect link in text that reaches Slack or email.** It travels as raw
  Markdown, so `[connect Gmail](connect:google-mail-calendar)` renders there as
  a dead link. `person:` mentions already have this shape and the same
  limitation; stripping both at the delivery boundary is the fix and has not
  been done.

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
pnpm --filter @avalon/api exec vitest run test/connector-recommendation.test.ts
pnpm --filter @avalon/api exec vitest run test/core-tool-idempotency.test.ts
pnpm --filter @avalon/desktop exec vitest run src/renderer/components/connector-cards.test.tsx
pnpm --filter @avalon/desktop exec vitest run src/renderer/components/workstream-blocks.test.tsx
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
- `connector-recommendation.test.ts` runs against a migrated in-memory database
  whose connector credentials are **partial on purpose**: Google and Slack are
  configured and nothing else, so the availability filter has something to
  exclude. A fixture with no credentials would build no registry, the filter
  would fail open, and every assertion about it would pass while testing the
  fallback. Its other load-bearing fixture is the second member — the test that
  a colleague's personal connection is never reported is the one that would
  otherwise turn a recommendation into a disclosure.
- `workstream-blocks.test.tsx` covers the dispatch and both Markdown
  presentations, and needs a `QueryClientProvider` and a mocked `useAppSession`
  — these components fetch connections themselves. Two of its cases are
  regression fixtures rather than features: a `connect:` link in an external
  member's message must stay text, and an unknown offering id must stay text.
- **A failure in `new-automation.test.tsx` can be this module's fault.** Every
  Markdown body in the app shares `MarkdownBody`, so a component passed to
  react-markdown must be defined at module scope: an inline one is a new
  component type on each render, and React then unmounts and remounts every
  paragraph in every body whenever anything re-renders — which the transcript
  does on each streamed token. The symptom is somewhere else entirely, as a
  `findByText` result that is "not in the document".
- Both prompt hashes in `packages/agent-harness/src/prompts.test.ts` move when
  the standing policy changes. They are byte-stability guards, not assertions
  about content: update them deliberately, in the same change.

## Data model

No tables of its own. One `messages` row per block, with the payload in
`structured_content_json` and idempotency on the existing
`UNIQUE (workstream_id, client_message_id)`. The `message_type` CHECK constraint
is untouched, which is the point of using `system`.

## Changelog

### 2026-08-12 — Offers are found by category and written into the sentence that needs them

**What changed:** Offerings carry categories from a closed set of nine, and
`core_find_connectors` searches them for what a run does *not* have, classifying
each result as not connected, needing reconnection, connected-but-not-in-this-run,
or connected. An agent can now offer a connection inside its own Markdown —
`[connect Gmail](connect:google-mail-calendar)` — which renders as a chip in a
sentence, or as full connection rows when the links stand alone in a paragraph.
`connectionMatchesOffering` moved into `@avalon/contracts` so the API and the
desktop client answer "is this connected" identically, and the run-eligibility
rule moved into `connector-run-eligibility.ts` so recommendation cannot be looser
than plugin loading.

**Why:** The card block shipped with no way for an agent to find out what to put
on one. Its only inputs were offering ids the model had to already know, so the
realistic failure — "send my boss three open slots from my calendar" with no
Google connection — still ended in a refusal, because the plugin catalog lists
only what is connected and its silence reads as "Avalon cannot do this". Two
things were missing: a vocabulary matching how requests are phrased, and a way to
answer *inside the sentence that explains the problem*. A standalone block after
a paragraph saying "I need access" is a second thing to read that says what the
paragraph already said.

**Considered and rejected:** *Categories on the connector manifest.* That is
where connector metadata lives and it was the first place tried. It cannot
express the case the model exists for: Google is one manifest and two offerings,
one of which is email and calendar and one of which is neither, so a
manifest-level tag answers a request to send mail by offering the Drive
authorization.

*Extending `avalon_discovery` with unconnected connectors.* Its two tools are
already "what can this run use", and its system message promises that everything
named is authority the run holds. A recommendation in that list is something
`load_plugin` will fail on, and the fix would have been prose telling the model
which entries are real — replacing a clean contract with a caveat.

*A second Markdown syntax, or a mode flag, to choose inline versus block.* Both
were designed and neither survived contact with the question "what does the model
have to learn". Placement already carries the intent: a link in a sentence is
part of the sentence, and a link alone on a line is a block. One syntax, and the
decision is made by writing normally.

*Reporting a connection made mid-run as simply connected.* Simpler output and a
worse failure. The connection is genuinely there — Settings shows it, the card
shows it — and the run's frozen scope does not include it, so the model would
confidently act on a tool it does not have.

*Letting sub-agents call it.* Caught by an existing test rather than by design: a
child's scope is narrower than its parent's, so it would report a connection the
parent actively uses as unusable. Excluded by capability prefix, like wake-ups.

**Consequences:** Adding an offering now means adding it to
`CONNECTOR_OFFERINGS`, `ConnectorOfferingIdSchema`, **and** at least one
category; tests enforce all three. Adding a category means giving it at least one
offering and a description, because the descriptions are what the model chooses
from. The `connect:` scheme renders only in agent-authored bodies — any new
caller of `MarkdownBody` that passes `offerConnections` is deciding that its
author is trusted, and for a human or external author that decision is wrong.
Connect links travel to Slack and email as raw Markdown, the same limitation
`person:` mentions already have; the fix is a strip at the delivery boundary and
it is not done. Anything passed to react-markdown from here has to be defined at
module scope — the paragraph override was inline for one commit and broke an
unrelated automation-composer test by remounting every paragraph in the app. Availability filtering lives in the recommendation read rather
than in the card, so a producer that bypasses `find_connectors` can still offer
a connector this region cannot complete.

Shipped in #TBD.

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
