# Work-stream and automation email addresses

Every work stream and every automation subscription receives one permanent address
on the domain configured when it is issued — `automation.rallywith.ai` today —
generated from a frozen vocabulary and reserved in a single Global registry that
both regions share. An address is never recomputed,
never recycled, and never reassigned — a deleted owner leaves a tombstone rather
than freeing the name, so a stale sender can never reach a different work stream.

Read this before changing the local-part format, the vocabulary, the allocator, the
reservation path, or what inbound mail is allowed to do when it arrives.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/lib/workstream-email-address.ts` | The v1 format, the frozen vocabulary, and the HMAC allocator. |
| `apps/api/src/services/workstream-email-routing-service.ts` | The Global `workstream_email_routes` ledger: which addresses are taken, and by whom. |
| `apps/api/src/workstream-email-routing-bridge.ts` | The named RPC binding every non-Global region reserves through. |
| `apps/api/src/services/resend-inbound-email-service.ts` | Inbound delivery: idempotency, leases, the sender check, the hourly budget. |
| `apps/api/src/inbound-email-regional-bridge.ts` | The one verified Resend event handed to the owning region. |
| `apps/api/src/routes/resend.ts` | The Global receiving webhook. |
| `apps/api/src/services/automation-email-service.ts` | Outbound automation results by email. |
| `apps/api/src/services/automation-email-content.ts` | The result email's shell, importable without the Worker's bindings. |
| `apps/api/src/services/email-markdown.ts` | The Markdown renderer both Rally emails share; owned by [`digests.md`](digests.md). |
| `scripts/preview-automation-email.mjs` | Rendering the result email for somebody to look at. |
| `apps/api/src/services/user-delivery.ts` | The connector-declared personal delivery surfaces beside it. |

## How it works

### The v1 format

```text
adjective-adjective-adjective-noun
```

All four segments are lowercase ASCII. The three adjective positions are ordered
and must contain three different words. The noun is either the surname of a
deceased scientist or an animal name. For example:

```text
luminous-tidal-structured-curie@automation.rallywith.ai
```

V1 contains 128 adjectives and 512 nouns: 256 scientist surnames and 256 animal
names. Because adjective order matters and repetition is not allowed, its exact
capacity is:

```text
128 * 127 * 126 * 512 = 1,048,707,072
```

Every possible v1 local part is at most 64 ASCII bytes, including its three
hyphens.

### Language policy

Adjectives are limited to clearly positive or neutral terms describing nature,
geometry, materials, light, motion, or well-understood system qualities. The list
excludes negative, insulting, violent, political, medical, emotionally loaded,
culturally sensitive, or potentially embarrassing descriptions.

Nouns are limited to deceased scientists' surnames and neutral animal names. Names
with likely insulting, sexual, violent, or culturally sensitive readings are
excluded even when they could technically identify an animal or scientist. All
vocabulary is reviewed as an address shown to people, not merely as random input to
a generator.

### Allocation and reservation

The allocator uses HMAC-SHA-256 over the version, region, workspace, owner kind,
owner ID, collision attempt, and expansion block. It consumes three distinct
ordered 7-bit adjective indexes and one 9-bit noun index. The server reserves each
candidate atomically; a collision advances the attempt.

There is exactly one authoritative reservation namespace for every Rally region
and both owner kinds. The Global control plane owns the historical
`workstream_email_routes` registry; Global work streams and automations reserve
there directly, and every non-Global data plane reserves through the named
`WorkstreamEmailRoutingBridge` RPC binding. The registry's case-insensitive primary
key is the complete normalized email address. A claim is shared across all regions
and owner kinds on that domain, while the same local part may safely identify a
different owner on another platform or future custom domain.

**The ledger records the exact address that is taken and where it points.** It holds
no lifecycle: no `reserved`/`active`/`disabled` status, no `disabled_at`. Whether
mail is actually accepted is decided regionally, at delivery, from the owner's own
row — a work stream must not be archived, an automation must be `status = 'active'`
and `lifecycle_state = 'visible'`. Because a claim is never released, there is
nothing for a pause, an archive, or a delete to write here.

`activateWorkstreamRoute` and `activateAutomationRoute` therefore reserve the
address and then read that regional row, returning the address or refusing with
`workstream_email_owner_archived` / `automation_not_active`. They are
a gate, not a transition.

The regional owner also stores the exact issued address. Detail reconciliation sends
that full value to Global; it never combines a persisted local part with the
domain configured on the Worker today. Migration `0097` inferred the two domains
for pre-existing claims at the Rally cutover boundary and tagged those rows as
`address_source = 'migration'`. The owner may verify or correct such a row once,
changing the source to `owner`; allocator- and owner-sourced claims are immutable.
Until that verification, the inferred value is provisional rather than an issued
tombstone. Correcting it frees only the unissued inference; the owner's actual
address becomes the permanent tombstone.

Automation sidebar snapshots return that regional address as stored and do not
verify it against Global one row at a time. Detail reads perform reconciliation;
keeping the list read regional avoids turning one sidebar snapshot into a batch
of cross-region registry calls. Detail reconciliation deliberately fails closed
when Global is unavailable so it cannot return an unverified address.

**Each gate reads through the database that owns its row.** An automation's
`status` and `lifecycle_state` come from the workspace facade, because
`automation_subscriptions` is a workspace-local table and the facade routes it
into WorkspaceDO. A work stream's `archived_at` must come from
`workstreamExecutionEnvironment` instead: `workstreams` is *not* workspace-local,
so the facade would send the read to regional D1, where migration 0090 left only
the identity anchor and dropped that column.

### Inbound delivery

Mail sent to a **work-stream** address is attached to that existing work stream as
an untrusted resource and transcript entry. It does not start an agent run.
Listing, detail, preview, and content reads authorize that resource through the
attached work stream's own scope and active participants. A private
ad-hoc work stream does not become workspace-readable merely because its email
resource has no automation subscription.

Mail sent to an active **automation** address creates a new automation run and a
new work stream with the automation's `personal` or `workspace` scope. The
automation owner is recorded as creator and participant; for a personal
automation that participant list is also the reader boundary, while workspace
membership admits readers to a workspace automation's runs. The received message
is its explicit opening input and attached resource, labelled as untrusted
external data before it reaches the model. A provider retry uses the Resend email
ID as the idempotency key, so it resolves to the same work stream and run. Receipt rows use reclaimable processing
leases so an interrupted delivery can continue after the lease expires. The
work-stream email receipt, the automation receipt, its rate window and the
resulting product state are all WorkspaceDO rows; the Global address ledger
remains only the opaque address-to-region/workspace/owner route needed before
the regional object can be selected.

For a personal automation, the normalized From mailbox must match its owner. For a
workspace automation, it must match an active workspace member. This check is
defense in depth because email From headers can be spoofed, so inbound-email runs
also omit every external connector tool declared as a write operation, and omit
outbound web search and fetch tools so untrusted mail cannot use them as an
exfiltration channel. Connector reads and Rally's internal work-stream tools
remain available.

Pausing an automation changes nothing in Global: the claim stands and the
resolver's `status = 'active'` test refuses the mail. Resuming makes the same
address deliverable again. An archived or deleted owner keeps its claim forever —
the row is the tombstone.

The Global webhook resolves the complete normalized recipient address. It does
not discard the domain and query by local part. This keeps the legacy and Rally
domains independent today and leaves the registry compatible with custom domains
where the same generated local part may legitimately belong to another owner.
An exact miss may fall back by local part only for a still-unverified migration
row and only across the two platform domains migration `0097` inferred. The old
schema made that local part globally unique. This prevents a bad cutoff inference
from silently dropping mail without collapsing a future custom domain's namespace;
the fallback emits `email_route_migration_domain_fallback` for operations.

### Outbound automation results

The addresses above are inbound. Separately, a personal automation may copy each
run's result outward, and may change that afterwards from the automation itself:
`PATCH /automations/:id` takes the whole destination set, and only the owner's own
request is accepted. Every run always lands in its own Rally work stream — that
is the canonical record and is not a destination the creator can turn off. On top
of it the creator may freeze email to their own account address and one
connector-provided personal surface, chosen on the create screen, changed afterwards
from the automation, and stored in `automation_delivery_targets`. Which connectors offer such a surface is the
connector's own declaration rather than a list held by the create screen; see
[connector architecture](connectors.md#delivering-automation-results-to-a-person).
Slack's Agent DM is the one shipped today.

Email delivery resolves the owner's account address when the destination is added
and stores that literal address, so a later account change cannot silently redirect
results. Editing the set does not re-resolve a destination that is already
delivering; switching one off and on again does, because a retired row is not
treated as current. Each result is sent through Resend from the notification sender —
`RESEND_NOTIFICATION_FROM_EMAIL`, which is set in both Workers' vars; unset, it
falls back to the transactional sender and a morning briefing arrives from the
invitations address. Delivery is keyed for idempotency on the delivery target and
the run's work stream, and the target records the work stream it last received so a
workflow retry cannot mail the same result twice. Empty results and the "nothing
qualified" phrasings suppressed for Slack are suppressed for email too.

**The run itself is told where Rally will send its result.** The active targets
are loaded into the automation's prompt context as `resultDelivery`, and the
platform policy forbids sending, drafting, or posting a copy of the result to any
destination listed there. Without it a run whose instructions say "email me the
briefing" reads that as a step, sends it through the mail connector, and Rally
then mails the same result to the frozen target — two copies from two senders. The
compiler is the other half: it writes a destination into `expectedOutputs` rather
than a provider send into `instructions`.

**The body is the run's final message, which is Markdown**, rendered into email
HTML by `apps/api/src/services/email-markdown.ts` — the same renderer the digest
uses. A mail client renders no Markdown of its own, so text that is escaped and
line-broken instead reaches the reader as `## Heading` and `**bold**`.

`automation_delivery_targets`, its per-run last-delivery fence, and email
receipts live in WorkspaceDO. The regional sender uses a stable provider
idempotency key and settles the target there. A delivery path needing a
multi-destination lease has to model one — the `external_delivery_attempts`
ledger reserved for it was retired unused — and D1 does not retain an outbound
payload or delivery-state projection.

### The frozen v1 vocabulary

The array order below is part of the v1 protocol. **Do not reorder, replace, or
remove entries.** Future vocabulary changes require a new generation version and do
not alter existing addresses.

#### Frozen v1 adjectives (128)

```text
acoustic, adaptive, aerial, alpine, amber, aquatic, arboreal, arctic,
autumnal, axial, azure, boreal, bright, bronze, calibrated, celestial,
central, cerulean, circular, classic, clear, coastal, compact, complete,
concentric, connected, consistent, constant, continuous, coppery, coral,
cosmic, crisp, crystalline, cubic, curved, daylit, diagonal, digital,
durable, dynamic, early, efficient, elegant, elliptical, even, evergreen,
exact, faceted, flexible, floral, flowing, fluid, forested, frosted,
geometric, glassy, glowing, golden, granular, harmonic, helical, horizontal,
indexed, integrated, interoperable, iridescent, jade, layered, level, linear,
local, luminous, lunar, marine, maritime, measured, methodical, misty,
modern, modular, montane, oceanic, orbital, parallel, pearly, planar,
polished, portable, precise, prismatic, radial, rainwashed, ready,
rectangular, riverside, rounded, russet, scalable, seamless, sequential,
silvery, smooth, solar, solid, spacious, spherical, spiral, steady, starlit,
streamlined, structured, sunlit, symmetric, systematic, textured, tidal,
tidy, unified, useful, verdant, versatile, vertical, vibrant, vivid,
windward, wintry, woodland
```

#### Frozen v1 scientist surnames (256)

```text
ampere, lovelace, avogadro, babbage, becquerel, bernoulli, bohr, boltzmann,
brahe, cavendish, celsius, copernicus, curie, darwin, dirac, doppler,
einstein, euler, faraday, fermi, feynman, franklin, galilei, gauss, halley,
chandrasekhar, helmholtz, herschel, hertz, hooke, hubble, huygens, joule,
kepler, lavoisier, leavitt, leibniz, linnaeus, lorentz, carver, maxwell,
meitner, mendel, minkowski, moseley, newton, noether, ohm, oersted, pasteur,
pauli, planck, poincare, raman, riemann, rontgen, rutherford, sagan,
schrodinger, shannon, tesla, turing, volta, watt, abel, agassiz, agnesi,
akasaki, alvarez, anderson, angstrom, anning, arrhenius, aston, avery, baade,
backus, baeyer, banach, banting, bardeen, barkla, barton, basov, bayes,
beadle, behring, bell, benacerraf, bergius, bethe, bhabha, bhatnagar,
birkeland, blackett, bloch, bordet, born, bose, bosch, bothe, bowen, boyle,
bragg, braun, brenner, brouwer, buchner, bunsen, burnet, butlerov, cajal,
sabatier, cantor, cardano, carrel, cassini, maathai, chadwick, chagas, chain,
chapman, chargaff, chatterjee, chebyshev, cherenkov, chern, church, clausius,
codd, compton, conway, cori, cormack, coulomb, crick, crookes, cruz, cuvier,
dalton, dana, davy, debye, dedekind, delbruck, descartes, dijkstra, diop,
dobzhansky, eddington, edison, ehrlich, eijkman, elion, engelbart, erdos,
erlang, erlenmeyer, fermat, fischer, fitzroy, florey, flory, foucault,
fourier, franck, frege, fresnel, friedmann, fukui, gabor, galois, molina,
gamow, geiger, germain, gilbert, glaser, godel, goddard, goeppert, golgi,
grassmann, grothendieck, wu, hahn, hale, haldane, hamilton, hamming, harriot,
harvey, hausdorff, hawking, haworth, zewail, henry, hess, hevesy, hilbert,
hodgkin, hofstadter, holley, holmes, hopkins, houssay, hoyle, humboldt,
hutton, ingenhousz, ito, jansky, janssen, jeans, jenner, joliot, mitchell,
kapitsa, karrer, katz, kekule, keldysh, kendall, khorana, kilby, kirchhoff,
klaproth, klug, koch, kolmogorov, korolev, koshiba, kovalevsky, kramers,
milstein, krogh, kuhn, kuiper, kurchatov, lamb, landau, landsteiner,
langmuir, laplace, larmor, lawrence, leakey, lebedev, lebesgue, lee, lehmann,
lemaitre, leloir, lister, lobachevsky, lyell
```

#### Frozen v1 animals (256)

```text
aardvark, agouti, albatross, alpaca, anole, antelope, badger, bandicoot,
barracuda, basilisk, bass, binturong, bison, bittern, blackbird, bluebird,
bluefin, bobcat, bobolink, bonobo, bongo, budgerigar, buffalo, bunting,
butterfly, caiman, camel, canary, capybara, caracal, caribou, cassowary,
chameleon, chamois, cheetah, chickadee, chinchilla, chipmunk, cicada, civet,
coati, cobra, condor, cormorant, coyote, crane, cricket, curlew, cuttlefish,
damselfly, deer, dhole, dolphin, dormouse, dove, dragonfly, dugong, eagle,
echidna, egret, elephant, eland, elk, emu, falcon, fennec, ferret, finch,
firefly, flamingo, flounder, flycatcher, gazelle, gecko, genet, gerbil,
gibbon, giraffe, goldfinch, goose, goshawk, grasshopper, grebe, groundhog,
grouper, guanaco, guineafowl, guppy, hamster, hare, harrier, hartebeest,
hedgehog, heron, hippopotamus, hoopoe, hornbill, hummingbird, hyrax, ibex,
ibis, iguana, impala, jackrabbit, jacana, jaguar, jerboa, kangaroo,
kingfisher, kinkajou, kiwi, koala, kookaburra, kudu, ladybug, langur,
lapwing, lark, lemur, leopard, lion, llama, lobster, lorikeet, lynx, macaw,
mallard, manatee, mandrill, manta, marmoset, marmot, marten, meerkat,
merganser, mink, minnow, mongoose, moose, moth, mouflon, nautilus, narwhal,
newt, nightingale, nilgai, numbat, nuthatch, ocelot, octopus, okapi,
opossum, orca, oriole, oryx, osprey, ostrich, otter, owl, panda, pangolin,
parakeet, parrot, peccary, pelican, penguin, petrel, pheasant, plover,
porcupine, porpoise, potoroo, pronghorn, puffin, puma, quail, quokka,
rabbit, raccoon, ray, redpanda, reindeer, rhinoceros, roadrunner, robin,
saiga, salamander, salmon, sandpiper, seahorse, seal, serval, shearwater,
skink, skylark, sparrow, squid, squirrel, starfish, starling, stingray,
stork, sturgeon, swan, swift, tamarin, tanager, tapir, tarpon, tenrec, tern,
tiger, tortoise, toucan, treefrog, trout, tuna, turaco, turtle, vicuna,
wallaby, warbler, waxwing, whimbrel, wombat, woodpecker, wren, zebra,
bluegill, bonito, bream, haddock, hake, pompano, sunfish, trevally, wallaroo,
anglerfish, arowana, barnacle, zebrafish, coralfish, darter, dragonet, goby,
halibut, lionfish, mackerel, marlin, remora, sailfish, tetra, wrasse,
sunbird, terrapin, waxbill
```

## Invariants

- **The vocabulary arrays are frozen and ordered.** Reordering, replacing, or
  removing an entry changes what the allocator derives for every future address and
  silently invalidates the mapping the version claims. A change requires a new
  generation version.
- **Issued addresses are persisted and never recomputed.** The stored address is
  authoritative; re-deriving one is how a vocabulary change would rewrite history.
- **An issued address is never recycled.** Allocator- and owner-sourced ledger
  rows are permanent tombstones, because a stale sender must never reach a
  different work stream or automation. A migration inference becomes a tombstone
  only after the regional owner verifies or corrects it.
- **The Global ledger stores a claim, not a lifecycle.** Whether mail is accepted
  is re-derived regionally from the owner's own row at delivery. A second copy of
  that state in Global could only ever disagree with it.
- **There is exactly one reservation namespace, in Global**, shared by every region
  and both owner kinds. A regional Worker never allocates from its own database and
  **fails closed** when the Global registry is unavailable — a second allocator is a
  second answer to a unique address.
- **The registry's full-address key is case-insensitive**, so claims and tombstones
  are shared regardless of casing, without collapsing two domains into one namespace.
- **Work-stream mail never starts an agent run.** It attaches as an untrusted
  resource and transcript entry, and nothing more.
- **An inbound address is a routing identifier, never an authenticator.** The From
  match is defense in depth; the actual protection is that inbound-email runs get no
  external connector writes and no outbound web tools.
- **A run never delivers a result Rally is delivering.** The active destinations
  travel in the automation prompt context as `resultDelivery`, and the platform
  policy renders a `# Result delivery` section telling the run to drop every
  recipient matching one before it sends anything. Removing either half puts the
  duplicate back: the compiler no longer writes a provider send, so nothing else
  stops a saved instruction that says "email me the briefing".
- **`resultDelivery` mirrors each sender's own predicate, not a third one.** Email
  delivers from `active` and only in production; Slack deliberately delivers from
  `needs_input` too and skips a member who turned that notification off. A
  convenient single predicate gets one of them wrong, and being wrong here is
  either a duplicate delivery or a result delivered nowhere. The loader and the
  two senders change together.
- **Outside production, an automation's result is not emailed at all** —
  `sendResendEmail` refuses to send transactional mail from a developer's machine
  or a staging Worker. That is why `resultDelivery` names no email destination
  there: a run told Rally has the email covered suppresses its own send, and
  since the compiler no longer writes a provider send either, a staging
  automation that used to mail through the connector would otherwise go quiet
  with nothing to explain it. If a staging automation stops emailing, this is the
  reason and it is working as intended.
- **A destination whose owner lost workspace membership is still listed.**
  `deliverAutomationResultEmail` re-checks membership against regional D1 and
  skips, so that result reaches nobody — the run stood down for a delivery that
  did not happen. It is left this way deliberately: mirroring the check would put
  a cross-region read on every automation run start for a case that is rare and
  self-correcting once the membership row is repaired. A future change that makes
  the destination set richer should reconsider it.
- **Its order is fixed.** The rows are rendered into the system prefix, which is
  re-rendered every turn and must be byte-identical across a retry; nothing
  constrains the order two rows come back in.
- **The result email carries a canonical HTTPS link, never `rallywithai://`.** Mail
  clients do not linkify a custom scheme, and most readers of a briefing are on a
  phone with no desktop app — see [`workstream-links.md`](workstream-links.md).
- **The outbound email destination is the literal address frozen when the target
  was created**, so a later account change cannot silently redirect results. The
  *set* of destinations is not frozen — an owner may turn one on or off from the
  automation — but a destination that survives an edit keeps its row, and with it
  the per-run fence that stops a workflow retry mailing the same result twice.
- **Every run lands in its own Rally work stream**, and that destination cannot be
  turned off — the copies are additions to the canonical record, never replacements.

## Boundary

This module owns the address format, its vocabulary, the allocator, the Global
registry, and what happens to mail addressed to one. It does not own:

| For | Read |
| --- | --- |
| The create path that awaits activation | [`workstream-creation.md`](workstream-creation.md) |
| Which connectors offer a personal delivery surface | [`connectors.md`](connectors.md#delivering-automation-results-to-a-person) |
| The Global/EU bridge this registry is reached through | [`regionalization.md`](regionalization.md) |
| Untrusted-input handling and the spoofing threat model | [`security.md`](security.md) |
| The `automation_delivery_targets` columns | [`data-model.md`](data-model.md) |
| The Resend receiving domain and its secrets | [`runbook.md`](runbook.md) |

## Failure modes and limits

- **A regional Worker fails closed when the Global registry is unreachable.** No
  address is issued rather than an address being issued twice.
- **Each automation atomically admits at most `AUTOMATION_EMAIL_MAX_RUNS_PER_HOUR`
  email-triggered runs per UTC hour** (30 by default). Excess deliveries are
  acknowledged without starting inference, which bounds model spend if an address
  leaks or a sender is spoofed.
- **An interrupted inbound delivery resumes after its lease expires.** Regional
  receipt rows carry reclaimable processing leases rather than a terminal failure.
- **A provider retry converges on the same run.** The Resend email ID is the
  idempotency key.
- **A v1 local part is at most 64 ASCII bytes**, and the namespace holds 1,048,707,072
  addresses — the expansion block in the HMAC input is what a v2 would use rather
  than widening v1.
- **An outbound send failure records `last_error_json` on the target and raises a
  retryable error inside the delivery step.** Because destinations are delivered
  independently, one failing channel does not hold back the other.
- **Non-production environments never send.**

## Testing

| Suite | Covers |
| --- | --- |
| `apps/api/test/workstream-email-address.test.ts` | The format, the frozen vocabulary indexes, the distinct-adjective rule, collision advance, and the 64-byte bound. |
| `apps/api/test/workstream-email-routing.test.ts` | Reservation, activation, disable/tombstone, and the regional fail-closed path. |
| `apps/api/test/resend-inbound-email.test.ts` | Idempotency by Resend email ID, the lease, the sender check, the tool omissions, and the hourly budget. |
| `apps/api/test/automation-result-email.test.ts` | The frozen destination, per-run idempotency, the suppressed-empty rule, and that the result's Markdown is rendered rather than mailed as markup. |
| `apps/api/test/email-markdown.test.ts` | The shared renderer: the structure these emails use, escaping, refused link targets, and the plain-text preview line. |
| `apps/api/test/automation-run-context.test.ts` | That a run is told its frozen destinations — email, Slack by id, a `needs_input` Slack target Rally still delivers to — told nothing when a target cannot deliver, and told them in a fixed order. |
| `apps/api/test/health-env-contract.test.ts` | That the probe says when notification mail is falling back to the transactional sender. |
| `apps/api/test/automation-delivery-target-edit.test.ts` | Turning a destination off, keeping a surviving row's per-run fence, and leaving delivery alone when an edit does not mention it. |
| `scripts/preview-automation-email.test.mjs` | The preview's flags, and that its sample still carries the constructs this email has rendered wrong. |

Run one with
`pnpm --filter @rally/api exec vitest run test/workstream-email-address.test.ts`
— the path is package-relative.

Two traps. The allocator is deterministic over a fixed vocabulary, so a test
asserting on a literal generated address is really asserting the array order. That
is intentional and those assertions should not be loosened when they fail: a
changed literal means the vocabulary moved, which is the thing that must not happen
inside a version.

And **the three vocabulary headings in this document are load-bearing**.
`workstream-email-address.test.ts` reads this file, locates each list by
`indexOf("## Frozen v1 <section> (")`, takes the fenced `text` block that follows,
and asserts it byte-for-byte against the arrays in code. Renaming one of those
headings, or moving a list out of its fenced block, fails the suite with a
missing-vocabulary error rather than a mismatch — the coupling is deliberate,
because it is what stops the document and the allocator drifting apart.

The subtlety, since it reads like a bug both ways: that is a **substring** search,
not a line-prefix match, so it is satisfied by any heading level of two hashes or
more. The headings here are `####`, nested under **The frozen v1 vocabulary**, and
`"#### Frozen v1 adjectives ("` contains `"## Frozen v1 adjectives ("` at index 2.
Deepening or flattening the nesting is therefore safe as long as at least two
hashes remain; changing the words after them is not.

## Changelog

### 2026-08-25 — Automation detail is regional and runs inherit automation scope

**What changed:** Opening automation detail now returns the stored regional
address without consulting the Global route registry. Manual, inbound-email,
scheduled, and activity-triggered runs copy the subscription's `personal` or
`workspace` scope onto the work stream they create.

**Why:** Address allocation and one-time route repair are lifecycle writes, not a
steady-state read obligation. Making every detail open re-verify an already
stored address added a cross-region dependency to an otherwise regional read.
Separately, the automation scope is its declared sharing boundary; forcing every
generated run to personal made a workspace automation visible while hiding the
work it produced from the workspace.

**Considered and rejected:** Retaining Global verification as defense in depth,
or authorizing every generated work stream through a separate automation rule.
The former makes Global availability and latency part of opening; the latter
creates a second reader model beside the work stream's own scope and participants.

**What a future change has to respect:** Route reservation, activation, and
repair must complete on the lifecycle path that owns them. Detail serves the
stored address. Every run producer must copy the automation scope, and every
email resource remains readable exactly where its attached work stream is.
Pre-change personal run objects keep their projected participant boundary in
automation history until their durable scope is explicitly migrated.

### 2026-08-25 — The Global claim key is the full email address

**What changed:** `workstream_email_routes` persists `email_address` as its
case-insensitive primary key. Allocation, owner reconciliation, and inbound
routing all use that full value; local parts may repeat on different domains.
Migration-inferred legacy rows may be verified or corrected exactly once from
the regional owner's stored address.

**Why:** Changing the minting domain made the local-part-only registry reconstruct
an old automation as `@automation.rallywith.ai` even though WorkspaceDO still
held its permanent `@automation.with-avalon.com` address. Opening that automation
then failed with `automation_email_address_conflict`. The same schema would also
make a future custom domain share one accidental local-part namespace with every
other domain.

**Considered and rejected:** Treating the two platform domains as equivalent at
the regional comparison. That masks this incident but keeps Global unable to
distinguish two real full addresses, so custom domains would reintroduce the
ambiguity. Also rejected: rewriting regional legacy addresses, which would break
addresses already saved outside Rally.

**Consequences:** A domain is part of permanent route identity. Future custom
domain support must make that domain accepted at ingress, but it does not require
a registry redesign. Migration provenance is the only state that permits an
address correction; after owner verification the tombstone is immutable. The
16-recipient ingress guard now counts complete addresses rather than deduplicated
local parts, matching the number of independently resolved and dispatched routes.

### 2026-08-25 — New addresses are minted on automation.rallywith.ai; the old domain keeps receiving

**What changed:** `WORKSTREAM_EMAIL_DOMAIN` is `automation.rallywith.ai`, and
`automation.with-avalon.com` joined a `LEGACY_WORKSTREAM_EMAIL_DOMAINS` list that
inbound routing still accepts. The domain a message arrived on is carried through
to the owning region instead of being replaced with the configured one.

**Why:** The rebrand to Rally moves every public hostname, and this one cannot be
switched. An address here is stored per work stream rather than derived, so
renaming the domain does not move the addresses already issued — and unlike a URL
we mint, those live in other people's mail clients, contacts, and forwarding
rules. Refusing them would discard real mail, and a discarded message looks
exactly like nobody having written. At the time, routing was keyed by local part,
so accepting a second domain cost only a set membership test; the newer entry
above records why that key was replaced.

Carrying the arriving domain through matters because the address is attached to
the work stream and shown back to the reader. Substituting the canonical domain
would have recorded that the sender wrote to an address they did not use.

**Considered and rejected:** Rewriting the stored addresses to the new domain in a
migration, the way `0021` corrected a typo. That comparison does not hold: `0021`
repaired a domain that had never accepted mail, so no address on it was in
circulation. These are, and rewriting them would break every sender at once with
no way to tell them.

**Consequences:** `configuredEmailDomain` now validates the configured value
against the accepted set rather than one literal, so a typo is still refused —
that guard is load-bearing and must not relax to a shape check. A domain leaves
the legacy list only when inbound mail to it has stopped; nothing measures that
automatically. `automation.with-avalon.com` must keep its MX record and its
Resend webhook for as long as it is on the list. See
[`domain-migration.md`](domain-migration.md).
### 2026-08-24 — Inbound mail inherits the generated work stream's privacy

**What changed:** Every automation-email run creates a personal work stream and
seats its owner. Email-resource authorization now uses the attached work stream's
scope and active participants for both automation and ad-hoc mail resources.

**Why:** The resource layer treated every non-automation attachment as
workspace-readable, and automation runs were workspace-scoped. A private
work-stream address could therefore turn private mail into a workspace resource;
the resource and transcript boundaries disagreed about the same content.

**Considered and rejected:** Looking up automation scope, special-casing ad-hoc
mail only, or hiding the resource just from list results. Automation sharing is
not execution-content visibility, and every resource surface must make the same
authorization decision.

**What a future change has to respect:** An inbound email is readable exactly
where its attached work stream is readable. Provider identity and attachment
state may narrow access further, but neither may widen it.

### 2026-08-23 — A destination that is switched off is retired, not deleted

**What changed:** `deliveryTargetStatements` no longer diffs against a set it
read a moment earlier. It now states the end state: one upsert per requested
destination keyed on `(automation_subscription_id, target_type)`, and one
statement retiring every other type to `status = 'disabled'`. Switching a
destination off keeps its row; switching it on again reuses that row. `PATCH`
validates the destination set through the same schema `POST` does, and a
destination already delivering is not re-resolved.

**Why:** Every dedupe layer is keyed on the target row's *id* — the
`last_delivered_workstream_id` fence, the Resend idempotency key, and the Slack
`client_msg_id` are all derived from it. The previous shape preserved the row
for a destination that survived an edit, which is what the entry below claims,
and quietly failed to for one turned off and on again: that deleted the row and
minted a new id with no fence and a fresh provider key, so a retry landing in
that window sent the result a second time. A feature added to remove a duplicate
had become a way to cause one.

Two smaller failures had the same root. Inserts were queued ahead of the
deletes, so replacing a Slack destination onto a reconnected connection tripped
the unique index inside the batch and failed the whole edit with a 500 — an
ordinary reconnect, not an edge case. And re-resolving destinations the edit was
not touching meant one lapsed Slack link rejected *every* subsequent edit,
leaving the dead destination impossible to remove.

**Considered and rejected:** Reordering the statements so deletes run first,
which fixes the 500 and neither of the others. Also rejected: deleting on
"off" and accepting the fence gap as a narrow window — the window is exactly
when somebody is most likely to be toggling, because a delivery that just
failed is what makes them look.

**Consequences:** A retired row still exists. Every sender names the statuses it
will deliver to and `disabled` is in none of them, and the detail query does not
return them, so it is off in every sense except forgetting — but a query written
against this table must filter on status rather than assume presence means
delivering. Re-choosing a retired destination re-resolves it, so a Slack
connection that lapsed while switched off is rejected at that point rather than
waking silently. Because each request states the whole set, two concurrent edits
resolve last-writer-wins instead of one deleting a row the other just added.

### 2026-08-23 — The destination is the compiler's answer, and it can be changed

**What changed:** A draft carries `requestedDelivery` — the destinations the
compiler understood the person to ask for — and the create screen pre-selects
from that rather than from a regex over the draft's prose. Destinations are also
no longer frozen for the life of the automation: `PATCH /automations/:id` accepts
a whole set, and the automation's own screen shows them with a toggle each.

**Why:** Two halves of the same mistake. The compiler already parsed the sentence,
so inferring intent again from its output was guessing at something already
known — and the guess pre-ticked a destination for "a ranked list of your most
important emails", a briefing *about* email. And a wrong tick could not be undone:
the only way to stop the mail was to delete the automation and build it again,
which made the guess expensive in exactly the case it was most likely wrong.

**Considered and rejected:** Keeping the prose heuristic and tightening the
pattern, which is what the previous change did — it narrows the false positives
without removing the class. Also rejected: replacing every target row on an edit,
which is simpler than reconciling but clears `last_delivered_workstream_id`, so an
edit between a run finishing and its delivery settling would re-send the result.
Reconciling as shipped here still lost that fence when a destination was switched
off and on again; the entry above records what it took to actually hold it.

**Consequences:** `requestedDelivery` is a *request*, never authority: the
destinations that actually deliver are the rows on the automation, and a draft
that asks for a destination still delivers nowhere until somebody accepts it. The
`update` path's owner check is defence behind the visibility fence rather than the
thing doing the work — a personal automation is not visible to anybody else — and
a change that widens automation visibility must keep it.

### 2026-08-22 — One result, rendered, from the notification sender

**What changed:** Three things that together decide what an automation's result
looks like in an inbox. The run is now told its frozen destinations
(`resultDelivery` in the automation prompt context) and forbidden by platform
policy from sending a copy to one of them; the compiler is told that a request to
be emailed or DMed names a destination rather than a step. The result email's body
goes through the shared Markdown renderer instead of being escaped with `<br>`
between lines, and `RESEND_NOTIFICATION_FROM_EMAIL` is now actually configured in
both Workers.

**Why:** A daily briefing automation delivered two emails — one the run sent
through the owner's own Gmail because its instructions told it to, and one Rally
sent to the frozen target — and both were unreadable: the first was Markdown in a
`text/plain` body, the second was Markdown escaped into HTML. The sender of the
second read `invites@`, because the notification sender this document already
claimed was used had never been set anywhere and silently fell back to the
transactional one. Configuring it moves the From address on every notification
sender — digests and mention emails as well as automation results.

**Considered and rejected:** Detecting the duplicate at delivery time — comparing
what the run sent through a connector against the frozen target — which needs a
per-run record of every outbound provider write and still only suppresses the
second copy after the first has left the mailbox. Telling the model is what stops
the work happening at all. Also rejected: rendering the connector's outbound mail
as HTML. `gmail.send` builds a `text/plain` body, that mail is sent as the person
rather than as Rally, and the tool guidance now says to write plain text; giving
it a second MIME part is a separate change with its own reasons.

**Consequences:** `resultDelivery` lists what each channel's sender will actually
attempt, and the loader and the senders are now three readers of two predicates:
a fourth reader, or a new delivery channel added to one and not the other, puts
the duplicate back for exactly the targets it disagrees about. A destination that
is not the owner's own address would also change what the policy is holding — it
is a de-duplication rule today, bounded by the fact that a miss annoys the person
who configured the automation, and it would become a confidentiality boundary.
Two things this deliberately did **not** do, both named so the next change can
take them up rather than rediscover them: the destination set is read at prompt
render rather than frozen with the run scope, so a target disabled mid-run leaves
the result delivered nowhere; and enforcement is the policy rather than a
`beforeToolCall` predicate over that frozen set, which is the mechanism the
harness already composes for read-only runs. `WORKSTREAM_PROMPT_VERSION` was
deliberately not bumped: it is inside the canonical run-scope hash, so bumping it
fails every in-flight run's resumed attempt across the deploy, and the policy
change is additive.

### 2026-08-22 — The work-stream gate reads the object, not the anchor

**What changed:** `activateWorkstreamRoute` reads `archived_at` through
`workstreamExecutionEnvironment` rather than `workspaceDatabase`.

**Why:** The entry below replaced a Global `status` filter with a read of the
owner's own row, and took the wrong database to it. `workstreams` is not in
`WORKSPACE_LOCAL_TABLES`, so the workspace facade passes the statement to
regional D1 — which after migration 0090 holds only the routing columns. The
gate would have thrown `no such column: archived_at` after the address was
already reserved, on the automation-run and Slack work-stream create paths that
call it. `ensureWorkstreamAddress`, two lines above, already read the same table
through the execution environment; this brings the pair back into agreement.

**Considered and rejected:** Adding `workstreams` to `WORKSPACE_LOCAL_TABLES`,
which would claim WorkspaceDO owns a table the work-stream object owns and
misroute every other reader of it. A future gate on work-stream state has to
take the execution environment; the anchor answers nothing about the product.

### 2026-08-22 — Global holds the claim, the region holds the lifecycle

**What changed:** `workstream_email_routes` lost `status` and `disabled_at`
(migration `0092`), and the regional mirror of the same value —
`automation_subscriptions.email_route_status` — was dropped with it (WorkspaceDO
migration 7). Every function that existed to move a route between `reserved`,
`active`, and `disabled` is gone: `setStatus`, `setAutomationStatuses`,
`activateMany`, their `…InGlobalRegistry` counterparts, `resolveActive`, and both
backfills. `activateWorkstreamRoute` and `activateAutomationRoute` now read the
owner's own row and either return the address or refuse.

**Why:** An address is never reused, so the only fact Global needs is that a local
part is taken. The status beside it was a second copy of state whose authority is
regional, and every reader already had the real answer next to it: inbound mail
resolves an automation with `status = 'active' AND lifecycle_state = 'visible'`
and a work stream with `archived_at IS NULL`, both derived from the owner rather
than the route. That made the Global copy unable to change any outcome, but able
to disagree — and reconciling it needed the periodic repair the desktop ran, plus
the backfills the list paths ran, to converge two records that could simply be
one.

**Considered and rejected:** Keeping `status` and fixing the repair, which buys a
denormalized copy of state nobody reads and keeps a cross-region write on every
pause; and keeping the regional mirror while dropping Global's, which leaves the
same duplication one layer down. A future change must not reintroduce a lifecycle
column here: if a route ever needs to be revoked independently of its owner, the
place to record it is the owner's region, where the decision is made.

### 2026-08-18 — Regional email product state moves into WorkspaceDO

**What changed:** Automation email receipts/rate windows, frozen outbound
targets, and external-delivery attempts are WorkspaceDO rows. The permanent
Global address registry remains an opaque pre-workspace routing/tombstone plane.

**Why:** The delivery lifecycle belongs to one workspace, while the friendly
address namespace must be globally unique before a regional object can be
resolved.

**Considered and rejected:** Moving the global address registry into a regional
object and retaining outbound delivery projections in D1. The former breaks
global uniqueness; the latter recreates split product authority.

**Consequences:** Global D1 still resolves an inbound address, but regional
idempotency, leases, payload hashes and provider receipts live with the owning
automation/digest/notification state in WorkspaceDO.
