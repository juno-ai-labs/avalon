# Work-stream and automation email addresses

Every work stream and every automation subscription receives one permanent address
at `automation.with-avalon.com`, generated from a frozen vocabulary and reserved in
a single Global registry that both regions share. An address is never recomputed,
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
luminous-tidal-structured-curie@automation.with-avalon.com
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

There is exactly one authoritative reservation namespace for every Avalon region
and both owner kinds. The Global control plane owns the historical
`workstream_email_routes` registry; Global work streams and automations reserve
there directly, and every non-Global data plane reserves through the named
`WorkstreamEmailRoutingBridge` RPC binding. The registry's case-insensitive primary
key is the local part, so a claim is shared across all regions and owner kinds,
and a name can never be reused by another work stream or automation.

**The ledger records only that an address is taken and where it points.** It holds
no lifecycle: no `reserved`/`active`/`disabled` status, no `disabled_at`. Whether
mail is actually accepted is decided regionally, at delivery, from the owner's own
row — a work stream must not be archived, an automation must be `status = 'active'`
and `lifecycle_state = 'visible'`. Because a claim is never released, there is
nothing for a pause, an archive, or a delete to write here.

`activateWorkstreamRoute` and `activateAutomationRoute` therefore reserve the
address and then read that regional row, returning the address or refusing with
`workstream_email_owner_archived` / `automation_not_active`. They are
a gate, not a transition.

### Inbound delivery

Mail sent to a **work-stream** address is attached to that existing work stream as
an untrusted resource and transcript entry. It does not start an agent run.

Mail sent to an active **automation** address creates a new automation run and a
new work stream. The received message is its explicit opening input and attached
resource, labelled as untrusted external data before it reaches the model. A
provider retry uses the Resend email ID as the idempotency key, so it resolves to
the same work stream and run. Receipt rows use reclaimable processing
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
exfiltration channel. Connector reads and Avalon's internal work-stream tools
remain available.

Pausing an automation changes nothing in Global: the claim stands and the
resolver's `status = 'active'` test refuses the mail. Resuming makes the same
address deliverable again. An archived or deleted owner keeps its claim forever —
the row is the tombstone.

### Outbound automation results

The addresses above are inbound. Separately, a personal automation may copy each
run's result outward. Every run always lands in its own Avalon work stream — that
is the canonical record and is not a destination the creator can turn off. On top
of it the creator may freeze email to their own account address and one
connector-provided personal surface, chosen once on the create screen and stored in
`automation_delivery_targets`. Which connectors offer such a surface is the
connector's own declaration rather than a list held by the create screen; see
[connector architecture](connectors.md#delivering-automation-results-to-a-person).
Slack's Agent DM is the one shipped today.

Email delivery resolves the owner's account address when the automation is saved
and stores that literal address, so a later account change cannot silently redirect
results. Each result is sent through Resend from the notification sender, keyed for
idempotency on the delivery target and the run's work stream, and the target records
the work stream it last received so a workflow retry cannot mail the same result
twice. Empty results and the "nothing qualified" phrasings suppressed for Slack are
suppressed for email too.

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
- **An address is never recycled.** A ledger row is a permanent tombstone, because
  a stale sender must never reach a different work stream or automation.
- **The Global ledger stores a claim, not a lifecycle.** Whether mail is accepted
  is re-derived regionally from the owner's own row at delivery. A second copy of
  that state in Global could only ever disagree with it.
- **There is exactly one reservation namespace, in Global**, shared by every region
  and both owner kinds. A regional Worker never allocates from its own database and
  **fails closed** when the Global registry is unavailable — a second allocator is a
  second answer to a unique name.
- **The registry's key is case-insensitive**, so claims and tombstones are shared
  regardless of how a name is cased.
- **Work-stream mail never starts an agent run.** It attaches as an untrusted
  resource and transcript entry, and nothing more.
- **An inbound address is a routing identifier, never an authenticator.** The From
  match is defense in depth; the actual protection is that inbound-email runs get no
  external connector writes and no outbound web tools.
- **The outbound email destination is the literal address frozen when the automation
  was saved**, so a later account change cannot silently redirect results.
- **Every run lands in its own Avalon work stream**, and that destination cannot be
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
| `apps/api/test/automation-result-email.test.ts` | The frozen destination, per-run idempotency, and the suppressed-empty rule. |

Run one with
`pnpm --filter @avalon/api exec vitest run test/workstream-email-address.test.ts`
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

### 2026-08-22 — Global holds the claim, the region holds the lifecycle

**What changed:** `workstream_email_routes` lost `status` and `disabled_at`
(migration `0091`), and the regional mirror of the same value —
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
