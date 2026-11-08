# Sidekick email addresses

Every Sidekick (storage `automation`) from the moment it is accepted receives
one permanent address
on the domain configured when it is issued — `automation.rallywith.ai` today —
generated from a frozen vocabulary and reserved in a single Global registry that
configured deployments share. An address is never recomputed,
never recycled, and never reassigned — a deleted owner leaves a tombstone rather
than freeing the name, so a stale sender can never reach a different owner. The
addresses retired Threads (storage `workstream`) were issued stay in the
registry as tombstones of exactly that kind: mail to one is acknowledged and
dropped with `email_thread_retired`.

Read this before changing the local-part format, the vocabulary, the allocator, the
reservation path, or what inbound mail is allowed to do when it arrives.

## Explicit Sidekick email triggers

New version-2 Sidekick definitions receive email only when inbound_email is configured. Disabling that trigger leaves its permanent address reserved but rejects new mail admission. Legacy definitions retain implicit email behavior. Instruction-only Sidekicks do not reserve addresses.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/lib/workstream-email-address.ts` | The v1 format, the frozen vocabulary, and the HMAC allocator. |
| `apps/api/src/services/workstream-email-routing-service.ts` | The Global `workstream_email_routes` ledger: which addresses are taken, and by whom. |
| `apps/api/src/workstream-email-routing-bridge.ts` | The named RPC binding every non-Global region reserves through. |
| `apps/api/src/services/resend-inbound-email-service.ts` | Inbound delivery: the Global route lookup, the sender resolution, and the one `admitInboundEmail` call. A Thread's route is refused by name. |
| `apps/api/src/durable-objects/hosted-sidekick.ts` | A Sidekick's half of all of that: its `automation_directory` row holds the issued address, `apply` reserves it, and `admitInboundEmail` decides lifecycle, address, and sender in one call and writes the receipt (`sidekick_email_receipts`). |
| `apps/api/src/inbound-email-regional-bridge.ts` | The one verified Resend event handed to the owning region. |
| `apps/api/src/routes/resend.ts` | The Global receiving webhook. |
| `apps/api/src/services/email-markdown.ts` | The Markdown renderer both Rally emails share; owned by [`markdown-rendering.md`](markdown-rendering.md). |
| `apps/api/src/services/user-delivery.ts` | The connector-declared personal delivery surfaces beside it. |

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
`workstream_email_routes` registry; Global Sidekicks reserve
there directly, and every non-Global data plane reserves through the named
`WorkstreamEmailRoutingBridge` RPC binding. The registry's case-insensitive primary
key is the complete normalized email address. A claim is shared across all regions
and owner kinds on that domain, while the same local part may safely identify a
different owner on another platform or future custom domain.

**The ledger records the exact address that is taken and where it points.** It holds
no lifecycle: no `reserved`/`active`/`disabled` status, no `disabled_at`. Whether
mail is actually accepted is decided regionally, at delivery, from the owner's own
row — an automation's own object must be
`active` with an acceptance row and a matching stored address. Because a claim is
never released, there is
nothing for a pause, an archive, or a delete to write here.

An automation reserves its address
exactly once, inside acceptance, through `reserveAutomation`, and stores the
issued value in its `automation_directory.email_address` column (WorkspaceDO,
written by `HostedSidekick` in the acceptance's transaction). Whether mail is
accepted is decided by the agent when the mail arrives, from its own lifecycle
and acceptance rows, so no separate gate can disagree with what actually happens
to the message.

The regional owner also stores the exact issued address, and an owner claim
sends that full value to Global; it never combines a persisted local part with
the domain configured on the Worker today. Migration `0097` inferred the two domains
for pre-existing claims at the Rally cutover boundary and tagged those rows as
`address_source = 'migration'`. The owner may verify or correct such a row once,
changing the source to `owner`; allocator- and owner-sourced claims are immutable.
Until that verification, the inferred value is provisional rather than an issued
tombstone. Correcting it frees only the unissued inference; the owner's actual
address becomes the permanent tombstone.

An automation's address is not reconciled against Global on any read.
`GET /automations/:id` returns what `automation_directory.email_address` holds;
the sidebar's Sidekick rows carry `emailAddress: null` (`sidekick-directory-sql.ts`),
so only the detail carries the address. The address and the claim are
written in the same acceptance that reserved it, and neither is editable
afterwards, so there is nothing for a per-read verification to catch that the
reservation did not already settle. Both were once reconciled because the
regional row and the Global claim had independent writers.

### Inbound delivery

Mail sent to a retired **Thread's** address routes nowhere. The Global webhook
finds its route row, dispatches nothing, and marks the receipt terminal with
`email_thread_retired`, so Resend stops retrying; a dispatch of the old shape
already in flight across the deploy is refused by the region with the same
code before the message is fetched.

Mail sent to an active **automation** address starts a run: one child
conversation under the automation's hosted Sidekick, named by the run id, whose
only participant is the automation's run-as principal, whatever the
automation's own scope. A run is a nested execution record rather than a room,
and [`automation-lifecycle.md`](automation-lifecycle.md) owns that rule. The
received message is attached to the run's conversation as an `inbound_email`
resource and appended there as its opening `system` message, labelled as
untrusted external data before it reaches the model. A provider retry uses the
Resend email ID as the idempotency key, so it resolves to the same run.

**The automation decides once, after the message is stored.** The regional
ingress fetches the message, resolves the sender to an active member, writes
the payload to R2 and the resource, and then calls
`WorkspaceDO.sidekickAdmitInboundEmail` exactly once. The Sidekick answers a retry from
`sidekick_email_receipts` by Resend email id before deciding anything; a new
message is refused with `sidekick_not_active`,
`sidekick_email_route_mismatch`, or `email_sender_not_authorized`, and the
refusal is the receipt, so a retry never re-evaluates it. There is no pre-fetch
screen and no hourly window; the sender must be inside the message, so the
message is fetched first, and the address is a routing identifier every member
can see rather than a secret.

The receipt is a **`sidekick_email_receipts`** row keyed on the
Sidekick and the Resend email ID, and the run it admits is that Sidekick's own. The Global address
ledger remains only the opaque address-to-region/workspace/owner route needed
before the regional object can be selected; its column is still named
`automation_subscription_id` and holds the automation id.

For a personal automation, the normalized From mailbox must match its author or
its run-as principal. For a workspace or room automation, it must match an
active workspace member. Email From headers can be spoofed, and this screen is
the only control on a mail-started run: since 2026-09-03 an inbound-email run
holds the same connector and web tools as every other automation run, so what
stands between a spoofed From and a run that can write and send is membership
screening at ingress. [`security.md`](security.md) records the decision and what
a re-tightening would have to cover.

Pausing an automation changes nothing in Global: the claim stands and the
object's own lifecycle check refuses the mail with `sidekick_not_active`,
writing a refusal receipt rather than a run. Resuming makes the same address
deliverable again. An archived or deleted owner keeps its claim forever; the
row is the tombstone.

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

The addresses above are inbound. Rally no longer sends an automation's result
anywhere on its behalf.

Until 2026-09-03 a personal automation could freeze email to its owner's account
address and one connector-provided personal surface as `deliveryTargets`, edit
them through `PATCH /automations/:id`, and have a loop after each run mail the
result through Resend with a per-run per-target receipt. All of that is gone:
the request field, the frozen targets, the `PATCH` route, the desktop editor,
the result email and its template and preview script, and the child's delivery
loop. A run's final message is its row's reply in the Sidekick's shared
conversation, and `conversation_post`, which defaults to that conversation,
reaches a Canvas the Sidekick can reach; there are no delivery receipts and no
classifier.

What replaced it is the run itself. An automation's instructions say where a
result should reach, the run holds the connector tools it was bound, and sending
is part of doing the work, inside the loop. The system prompt's result-delivery
section says outright that nothing sends for it, so a run that merely
describes an email has not sent one.
[`automation-lifecycle.md`](automation-lifecycle.md) owns the reasoning; the
short form is that the judgement about where a result goes belongs with the
judgement about what it says, and the old shape could not express either
"email the finance team, and DM me only if it is urgent" or the case where the
person who would choose a connection is no longer in the flow.

Two consequences for this document's subject. The result email carried no
`Reply-To`, which was recorded here as a regression; there is no result email
now, so there is nothing to reply to and nothing to fix. And a permanently
rejected recipient address is no longer a state Rally can observe, because Rally
is not the sender: a run whose send fails sees the tool's own error and can say
so in its result, which the room or the person reads, rather than a receipt
nothing projected onto the automation.

### The frozen v1 vocabulary

The array order below is part of the v1 protocol. **Do not reorder, replace, or
remove entries.** Future vocabulary changes require a new generation version and do
not alter existing addresses.

**The generator has a second consumer.** A resource's short alias
([`agent-attachments.md`](agent-attachments.md)) is minted by the same function
over that resource's own coordinates, under a key domain-separated from this
one — one vocabulary, one set of collision odds, one place to change either. So
the array below is frozen for aliases too, and a reorder would rewrite the
mapping for both. The two *value spaces* are deliberately not disjoint: an
alias may equal some Sidekick's local part, which is harmless only because
nothing routes mail on an alias and nothing resolves a resource by one.

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
  different owner. A migration inference becomes a tombstone
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
- **Mail to a retired Thread's address reaches nothing.** It is acknowledged as
  terminal with `email_thread_retired`; the address stays a tombstone, so it
  can never be issued to another owner.
- **An inbound address is a routing identifier, never an authenticator.** The From
  match against active membership is the control; an inbound-email run holds the
  same tools as any other automation run, so ingress screening carries the weight.
- **A run posts its own results, and Rally posts nothing after it.** A run's
  final message is the reply on its row in the Sidekick's shared conversation,
  and the run's `conversation_post` tool is the one way a result reaches a
  Canvas the Sidekick can reach, once per call; a continued run may post again.
  There is no result email, no receipt, and no second path.
- **Every run lands in its own conversation under its Sidekick**, and that
  cannot be turned off; nothing reaches another conversation unless the run
  posts it. Anything the run sends
  elsewhere is its own tool call, and nothing in this module sends on its
  behalf.

## Boundary

This module owns the address format, its vocabulary, the allocator, the Global
registry, and what happens to mail addressed to one. It does not own:

| For | Read |
| --- | --- |
| When a Sidekick is accepted and its address reserved | [`automation-lifecycle.md`](automation-lifecycle.md) |
| Which connectors can carry a message to a person | [`connectors.md`](connectors.md#delivering-a-digest-to-a-person) |
| The configured deployment bridge this registry is reached through | [`regionalization.md`](regionalization.md) |
| Untrusted-input handling and the spoofing threat model | [`security.md`](security.md) |
| The Sidekick tables the address and the receipts live in | [`automation-lifecycle.md`](automation-lifecycle.md), [`data-model.md`](data-model.md) |
| The resource aliases this generator also mints | [`agent-attachments.md`](agent-attachments.md) |
| The Resend receiving domain and its secrets | [`runbook.md`](runbook.md) |

## Failure modes and limits

- **A regional Worker fails closed when the Global registry is unreachable.** No
  address is issued rather than an address being issued twice.
- **There is no per-address rate limit.** The hourly window the first automation
  object kept was cut with it; the sender screen is the whole control on model
  spend from a leaked or spoofed address. A limit here is a decision for when
  mail volume exists, and its number would be the team's to set
  ([`adding-security-defensive-and-other-limits.md`](adding-security-defensive-and-other-limits.md)).
- **An interrupted inbound delivery has no lease to resume.** Admission is one
  call that either writes the receipt and the run together or writes the
  refusal receipt alone.
- **A message an automation refuses is receipted, not dropped.** The outcome code
  (`sidekick_not_active`, `sidekick_email_route_mismatch`,
  `email_sender_not_authorized`) is stored against the Resend email ID, so a
  provider retry resolves to the same refusal instead of being re-evaluated
  against a lifecycle that has since moved. The message is fetched and stored
  before the object decides, so a refused message still costs one payload and
  one resource row; the address is a routing identifier every member can see.
- **A provider retry converges on the same run.** The Resend email ID is the
  idempotency key.
- **A v1 local part is at most 64 ASCII bytes**, and the namespace holds 1,048,707,072
  addresses — the expansion block in the HMAC input is what a v2 would use rather
  than widening v1.
- **An outbound send failure records a `failed` delivery receipt against that
  run and target, and raises inside the delivery step.** Because destinations are
  delivered independently, one failing channel does not hold back the other. A
  failed receipt is the only place the failure is recorded: nothing marks the
  destination, so a permanently rejected address repeats the same failure on
  every run without saying so on the automation.
- **Non-production environments never send.**

## Testing

| Suite | Covers |
| --- | --- |
| `apps/api/test/workstream-email-address.test.ts` | The format, the frozen vocabulary indexes, the distinct-adjective rule, collision advance, and the 64-byte bound. |
| `apps/api/test/workstream-email-routing.test.ts` | Reservation, owner claims, tombstones (a retired Thread's included), and the regional fail-closed path. |
| `apps/api/test/resend-inbound-email.test.ts` | Idempotency by Resend email ID, the sender resolution, the single admission call, and the refusal of a Thread's route. |
| `apps/api/test/email-markdown.test.ts` | The shared renderer: the structure these emails use, escaping, refused link targets, and the plain-text preview line. |
| `apps/api/test-workers/hosted-sidekick.test.ts` | On real workerd: that applying a revision reserves and stores the address, and that `admitInboundEmail` admits once, answers a retry from its receipt, and refuses a stranger. |
| `apps/api/test/health-env-contract.test.ts` | That the probe says when notification mail is falling back to the transactional sender. |

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

### 2026-11-07 — A Thread's address is a tombstone

**What changed:** The Thread arm of inbound delivery is gone: the Global
webhook acknowledges mail to a Thread's route as terminal with
`email_thread_retired` instead of dispatching it, and the region refuses an
in-flight Thread dispatch with the same code. The work-stream receipt lease
(`claimInboundEmailReceipt`, its renew/settle/failure RPCs and their storage),
the `INBOUND_EMAIL_PROCESSING_LEASE_SECONDS` setting, and the routing
service's Thread reservation, claim and activation (`reserve`, `reserveMany`,
`claim`, `ensureWorkstreamAddress`, `activateWorkstreamRoute`, with the bridge
methods) are deleted.

**Why:** Threads were retired by the Canvases-and-Sidekicks pivot
([PRD](PRDs/2026-11-06_canvases-and-sidekicks/prd.md)); nothing opens one, so
mail attached to one would be read by nobody. The Global route rows stay: they
are the tombstones that keep an issued address from ever pointing elsewhere.

**Considered and rejected:** Dispatching to the region and letting it answer
404 as before. That costs a cross-region hop for an answer Global already has
from the route row. The `workstream_email_receipts` table is dropped with the
other Thread tables in the WorkspaceDO data migration, not here.

### 2026-09-03 — One admission call, no screen, no window

**What changed:** Automation mail is admitted by one `AutomationDO.admitInboundEmail`
call after the message is fetched and stored; `screenInboundEmail`, the
pre-fetch screen, and the hourly rate window are gone with the first automation
object, and a mail-started run is a child conversation under the automation
rather than a work stream. The owning room is reached by the run's own
`automation_post_result` tool; the delivery receipts and the disposition
classifier are gone.

**Why:** [`automation-lifecycle.md`](automation-lifecycle.md) records the
rebuild. For this document: the double screen existed so a refused message
cost no storage, and the rate window existed to bound spend from a leaked
address; both were guards on a product with no mail volume, each with a number
nobody here could set, and each doubled a check the admission call already
makes. One call that writes one receipt is what the receipt-by-Resend-id
idempotency needed all along.

**Considered and rejected:** Keeping the pre-fetch screen alone. It decided
lifecycle and address from the webhook without the sender, so it could refuse
early but never admit, and the admission call re-ran its checks anyway.

**Consequences:** A refused message costs one payload in R2 and one resource
row; a leaked address costs a refused receipt per message and nothing more
until a limit is decided, and that number is the team's to set. `apps/api/test/workstream-email-address.test.ts`
still proves the address contract unchanged.

### 2026-09-03 — Rally stops sending automation results

**What changed:** The outbound half of this document is retired. Automation
delivery targets, `PATCH /automations/:id`, `automation-email-service.ts`,
`automation-email-content.ts`, `scripts/preview-automation-email.mjs`, and the
child's external delivery loop are deleted; the "Outbound automation results"
section now records that and what replaced it. Inbound addressing, screening,
and receipts are unchanged. `email-markdown.ts` stays, owned by digests.

**Why:** an automation has no destinations of its own any more — a run sends
what its instructions ask for, with the connector tools it was bound, inside the
loop. The full reasoning, the security trade, and the migration that made it
safe are in [`automation-lifecycle.md`](automation-lifecycle.md)'s entry of the
same date; this entry exists so a reader of the email document is not left with
a section describing a sender that no longer exists.

**Consequences:** the missing `Reply-To` recorded above as a regression is moot,
and a permanently rejected recipient is no longer something Rally can mark,
because Rally is no longer the sender.

Shipped in #541.

### 2026-08-29 — The inbound receipt lease becomes one typed claim

**What changed:** The work-stream inbound path's receipt handling moved from
statements through the workspace runtime facade to typed `WorkspaceDO` methods.
`claimInboundEmailReceipt` performs the insert, the duplicate read and the
expired-lease takeover in one transaction and mints the lease token inside the
object; renew, settle and failure recording present that token and answer with
outcomes (`renewed`/`lease_lost`, `processed`/`lease_lost`) read from
`RETURNING` witnesses. `upsertInboundEmailResource` creates or refreshes the
email's resource in one critical section, and it writes only when something
changed: the old follow-up refresh re-assigned versioned columns — which
fires the semantic-version trigger even when their values are unchanged —
recording a phantom second version on first ingestion and again on every
lease-takeover replay, whose values re-derive byte-identical from the same
retrieved message.

**Why:** Part of the facade-to-RPC stack: the facade routes SQL by the table
names in it, and `workstream_email_receipts` answered `no such table` from the
regional database the moment its entry was missing. The claim was also three
separate critical sections, and the gap between them is where two concurrent
deliveries of one message could both proceed; the object's serialization makes
the reading at the call site true. The 503 the old path returned when a
conflicted insert found no row on re-read is unreachable in one transaction.

**Considered and rejected:** Letting the caller keep minting the lease token.
The token fences every later transition, so the object that enforces the fence
mints it; the lease *length* stays the service's, because it is an
environment-configured limit the object has no reading of.

**Consequences:** The receipt tests in `resend-inbound-email.test.ts` seed and
read a real WorkspaceDO's `workstream_email_receipts` rather than a fixture
map, and the lease-expiry cases pin the wall clock because the object compares
expiry against its own clock, not a caller-supplied timestamp.

### 2026-08-28 — An automation owns its address, its receipts, and its refusals

**What changed:** An automation reserves its address once, inside acceptance, and
stores it in its own `automation_email_route`; `ensureAutomationAddress` and
`activateAutomationRoute` are gone, and so is the per-read Global reconciliation
of an automation's address. The inbound path now asks the agent twice before
storing anything — once from the webhook, once after the sender resolves — and
`admitInboundEmail` writes the receipt and consumes the hourly budget in one of
the object's own transactions. Frozen delivery destinations moved to the
acceptance row, delivery receipts to `automation_delivery_receipts` keyed on
`(run, target)`, and the idempotency key from *(target, work stream)* to
*(automation, run, channel)*. Every `PATCH` re-resolves the whole destination set.

**Why:** The automation half of this document described tables that the durable
automation lifecycle removes. Beyond following the authority, two things got
better on the way. Screening before the fetch closes a hole the old order left
open: the address is a routing identifier every member can see, so anyone holding
one could make Rally retrieve and store an R2 payload and a titled resource for a
message admission was always going to refuse. And keying delivery on the run
rather than the work stream is the same identity the rest of the run context uses,
so a receipt cannot be attributed to a work stream the run no longer owns.

**Considered and rejected:** Keeping a separate `activateAutomationRoute` gate.
It existed to make the answer to "can this automation receive mail" agree with
what happens when mail arrives, by reading the same row. With one object owning
both, a second reader can only disagree. On the outbound side, re-targeting a
result to the author's *current* account address instead of skipping it. A frozen
destination is a decision somebody made about a named address; following an
account change is a different decision that nobody made.

**Consequences:** Two behaviors did not survive the move and are recorded above
rather than quietly lost. The result email no longer carries a `Reply-To` back to
the automation's own address, so replying reaches the notification sender. And a
permanently rejected destination is no longer marked `needs_input` on the
automation — the failure lives only in a receipt nothing reads back — so the same
send fails silently on every run. Both are regressions the frozen-context
delivery path did not carry across; restoring the second means projecting a
failed receipt into the attention code the directory already has.

Shipped in the pull request for this change. Design:
[the durable automation lifecycle PRD](PRDs/2026-08-25_durable-automation-lifecycle/prd.md).

### 2026-08-28 — The address generator gains a second consumer

**What changed:** Resource aliases are minted by this module's generator, over
a resource's coordinates and under a domain-separated key. Nothing about
addresses changed; what changed is who else depends on the frozen vocabulary.

**Why:** A second four-word namespace would have been a second vocabulary, a
second set of collision odds, and a second place to get the reservation loop
wrong — for a value that wants exactly the properties this one already has.

**Considered and rejected:** Sharing the key as well. Separate keys make the
two mappings independent, so an alias reveals nothing about a work stream's
address; sharing one would have made them derivable from each other for no
benefit.

**Consequences:** The frozen array is now frozen on behalf of two features. The
value spaces overlap by design — an alias may equal some work stream's local
part — which stays safe only while nothing routes on an alias.

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
