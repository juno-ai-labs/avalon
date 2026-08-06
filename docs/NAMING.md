# Feature naming study

Avalon's features are currently named descriptively: *work stream*, *automation subscription*,
*agent harness*, *elicitation*, *inspector rail*, *inference ledger*. Accurate, but none of them
are brands. This document takes the full feature inventory and renames it six times, once in each
of six house styles, so a naming direction can be chosen before anything is renamed in code.

Nothing in this document is applied. It is a menu.

## 1. What we have today

Thirty-four nameable features, grouped by where they live.

### Product surface

| # | Current name | What it is |
| --- | --- | --- |
| 1 | Work stream | The durable, multiplayer container for one task, investigation, deliverable, or automation run |
| 2 | Avalon (the agent) | The agent inherent in every work stream; never a removable participant |
| 3 | Transcript | The shared, readable message log |
| 4 | Composer | The restrained bottom input |
| 5 | Inspector rail | The contextual 320–380px right panel |
| 6 | Presence / "Viewing now" | Ephemeral viewers, distinct from persisted participants |
| 7 | Resources | Attached provider objects and uploads, hydrated lazily |
| 8 | Elicitation | A typed question block that pauses the run until a human answers |
| 9 | Activity suggestion | An in-stream offer to route a connector event into work |
| 10 | Work-stream email address | The globally unique inbound address per stream |
| 11 | Artifacts / Outputs | Produced deliverables surfaced as transcript blocks |

### Automation

| # | Current name | What it is |
| --- | --- | --- |
| 12 | Automations | Natural-language, versioned, scheduled work |
| 13 | Automation template version | Immutable, shareable behavior |
| 14 | Automation subscription | A pinned version plus scope, principal, connector bindings, overrides |
| 15 | Automation architect | The agent that compiles natural language into a validated draft |
| 16 | Triggers | Calendar, interval, connector-activity, semantic, and manual starts |
| 17 | WorkspaceScheduler | One Durable Object holding one alarm for the earliest due item |
| 18 | Run history | The per-automation record of past runs |

### Agent engine

| # | Current name | What it is |
| --- | --- | --- |
| 19 | Harness run | One bounded, leased, server-side tool-using loop |
| 20 | Run scope / run authority | Immutable frozen principal, connections, capabilities, limits |
| 21 | Plugin catalog / progressive loading | Bounded discovery plus `load_plugin` activation |
| 22 | Tool receipts | Durable pre-execution plans and post-execution results; idempotency |
| 23 | Inference ledger | Immutable per-attempt record of provider, route, outcome, tokens, cost |
| 24 | Classified fallback routing | Deterministic route plan, defect retry, circuit breaker |
| 25 | Inline subagents / "Background tasks" | Read-only durable children for parallel investigation |
| 26 | Scoped memory | Prose facts scoped to stream, automation, user, or workspace |
| 27 | Memory tables | Typed structured collections with natural keys and revisions |
| 28 | Context checkpoint / compaction | LLM continuation summary replacing the live tail |

### Platform

| # | Current name | What it is |
| --- | --- | --- |
| 29 | Connectors / connections | Typed provider adapters behind a registry |
| 30 | Smart ingress | Signature-verifying webhook front door with regional fanout |
| 31 | Regions | Global and EU deployments plus the named RPC bridges between them |
| 32 | WorkstreamRoom | Hibernating sockets, bounded replay, resync |
| 33 | Web tools | Firecrawl-backed public search and clean-markdown fetch |
| 34 | Audit + inference logging | Audit events and the opt-in full request capture |

## 2. The six systems

Each column below is internally consistent. Names are not interchangeable across columns — the
grammar is the point, not the individual word.

| # | Current | Tesla | SpaceX | Palantir | Nike | Apple | Anduril |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Work stream | Lane | Mission | Case | Track | Space | Theater |
| 2 | The agent | Autopilot | Dragon | Seer | Pacer | Assist | Ghost |
| 3 | Transcript | Timeline | Flight Log | Case Record | Splits | Transcript | Tracklog |
| 4 | Composer | Console | Flight Deck | Command Bar | Starting Line | Compose | Terminal |
| 5 | Inspector rail | Side Display | Telemetry | Object Explorer | Vitals | Inspector | Scope |
| 6 | Presence | Occupancy | Crew | Roster | Squad | Live Presence | Callsigns |
| 7 | Resources | Cargo | Payload | Objects | Gear | Shared Items | Assets |
| 8 | Elicitation | Hands-On Request | Go/No-Go | Decision Point | Baton | Quick Ask | Hold |
| 9 | Activity suggestion | Lane Change | Course Correction | Signal | Cue | Suggestions | Contact |
| 10 | Stream email address | Mail Drop | Uplink | Intake | Dropline | Mail Drop | Inlet |
| 11 | Artifacts | Delivery | Recovery | Finished Products | Results | Results | Effects |
| 12 | Automations | Summon | Falcon | Aegis | Flyplan | Shortcuts | Sentry |
| 13 | Template version | Build | Block | Doctrine | Last | Blueprint | Mark |
| 14 | Subscription | Install | Booster | Standing Order | Fit | Setup | Emplacement |
| 15 | Automation architect | Autobuilder | Starfactory | Blueprint | By You | Shortcut Builder | Arsenal |
| 16 | Triggers | Launch Conditions | Launch Criteria | Tripwires | Start Signals | Triggers | Detects |
| 17 | Scheduler | Scheduled Departure | Launch Control | Watch Officer | Timekeeper | Scheduler | Cadence |
| 18 | Run history | Trip Log | Flight Record | After Action | Streak | Run History | Sortie Log |
| 19 | Harness run | Drive | Burn | Operation | Rep | Session | Sortie |
| 20 | Run scope | Valet Mode | Flight Envelope | Rules of Engagement | Flywire | Sandbox | Leash |
| 21 | Plugin loading | Upgrade Store | Payload Bay | Armory | Adapt | Extensions | Loadout |
| 22 | Tool receipts | Service Record | Cargo Manifest | Chain of Custody | Timing Chip | Receipts | Tally |
| 23 | Inference ledger | Black Box | Flight Recorder | Lineage | Sensor Log | Activity Report | Recorder |
| 24 | Fallback routing | Auto Reroute | Engine-Out | Contingency | React | Handoff | Divert |
| 25 | Inline subagents | Smart Summon | Grasshopper | Task Force | Relay | Sidecar | Wisp |
| 26 | Scoped memory | Driver Profile | Ground Station | Ontology | Muscle Memory | Memory | Cache |
| 27 | Memory tables | Logbook | Inventory | Object Sets | Statline | Collections | Registry |
| 28 | Context compaction | Range Mode | Stage Separation | Rollup | Taper | Optimize Context | Jettison |
| 29 | Connectors | Adapters | Docking Ports | Sources | Laces | Accounts | Mounts |
| 30 | Smart ingress | Charge Port | Range Safety | Checkpoint | Turnstile | Gatekeeper | Perimeter |
| 31 | Regions | Grids | Launch Sites | Enclaves | Turf | Storage Regions | Bastions |
| 32 | Live room | Live Link | Comms Loop | Common Operating Picture | Slipstream | Continuity | Lattice |
| 33 | Web tools | Scout | Starlink | OSINT | Trail | Spotlight | Sweep |
| 34 | Audit + inference log | Sentry Mode | Flight Data | Full Take | Full Replay | Model Report | Overwatch |

## 3. Tesla

**Grammar.** Plain English compounds, no mythology, no Latin. `Mode` suffix for states you toggle.
`Auto-` and `Smart ` prefixes for things that act without you. Superlatives as tier names. The
occasional deadpan joke. Every name is something a driver could guess the meaning of.

Signature picks:

- **Autopilot** — the agent. Always on, always yours, does the boring part, still expects your hands.
- **Summon** / **Smart Summon** — automations, and the inline subagents that go do a job alone and
  come back. The pair reads as one family, which is exactly the parent/child relationship.
- **Valet Mode** — the frozen run scope. Tesla's Valet Mode is a restricted authority envelope that
  someone else operates inside. That is precisely what an immutable run scope is.
- **Sentry Mode** — the opt-in full inference capture. Off by default, records everything when on.
- **Range Mode** — context compaction. Shed what costs you distance, keep going further.
- **Driver Profile** — scoped memory. Sit down and it already knows your settings.
- **Charge Port** — the smart ingress. One physical door, verified, everything enters through it.

Risk: `Autopilot`, `Sentry Mode`, `Smart Summon`, and `Valet Mode` are Tesla's own live marks.

## 4. SpaceX

**Grammar.** Birds of prey and dragons for vehicles, star-compounds for networks, deadpan-literal
nicknames for mechanisms, and immutable numbered design revisions. Operational vocabulary borrowed
wholesale from launch control.

Signature picks:

- **Mission** / **Burn** — the work stream and one bounded agent loop inside it. A mission contains
  many burns; each burn is discrete, bounded, and either completes or is aborted.
- **Falcon** / **Block** / **Booster** — automations, the immutable versioned design, and the
  specific flight-proven vehicle built to it. This maps to template/version/subscription exactly,
  including why a Booster keeps flying the same Block until you re-certify it.
- **Go/No-Go** — elicitation. The countdown stops, every station polls, a human says go.
- **Engine-Out** — classified fallback routing. Lose an engine, redistribute thrust, complete the
  mission anyway. The best available metaphor for graceful model failover.
- **Stage Separation** — context compaction. Drop the spent mass, keep the payload, keep climbing.
- **Grasshopper** — inline subagents. Goes up, does the thing, lands back where it started.
- **Flight Envelope** — the frozen run scope. Well understood as a boundary you narrow, never widen.

Risk: `Falcon`, `Dragon`, `Starlink`, and `Starfactory` are SpaceX marks.

## 5. Palantir

**Grammar.** Two registers running at once. Grand mythic single words for platforms and products,
and brutally literal compound nouns for components. Heavy intelligence-community and operational
vocabulary. `Ontology` as the load-bearing abstraction everything else hangs from.

Signature picks:

- **Ontology** — scoped memory. Palantir's own central idea: the durable, authorized, shared model
  of your world that every application reads through. Avalon's scoped memory is structurally the
  same thing, and the name would carry real weight.
- **Rules of Engagement** — the frozen run scope. Established before the operation, may be tightened
  mid-operation, may never be loosened. It is already the exact concept.
- **Chain of Custody** — tool receipts. Immutable, per-item, proves what happened, when, by whom,
  and that it happened exactly once.
- **Common Operating Picture** — the live room. The shared, replayable, consistent view every
  participant works from.
- **Standing Order** / **Doctrine** — subscription and template version. Doctrine is written once and
  versioned; a standing order binds a specific unit, with specific authorities, to execute it.
- **OSINT** — the public-web tools. The correct term of art, and it sorts the public web firmly below
  authorized connector data, which is the actual prompt-authority policy.
- **Full Take** — the opt-in inference capture. Unfiltered, everything, deliberate.
- **Enclaves** — Global and EU. Palantir's own word for isolated sovereign deployments.

Risk: `Foundry`, `Apollo`, `Gotham`, and `Object Explorer` are Palantir product names, and
`Ontology` is strongly associated with them.

## 6. Nike

**Grammar.** Fused compounds. Named technologies that travel across products. Suffix and prefix
families. Body, motion, and training metaphors. Energetic and slightly aspirational — the feature
name implies you are better at your job for having it.

Signature picks:

- **Pacer** — the agent. Runs beside you, sets the pace, never runs the race for you.
- **Rep** — one bounded agent run. Short, countable, repeatable, and it makes limits legible: a
  session has a rep count.
- **Last** / **Fit** — template version and subscription. A last is the immutable form every pair is
  built on; your Fit is the specific pair, broken in to you, with your gear tied to it. This is
  genuinely the cleanest template/instance metaphor of the six.
- **Flywire** — the frozen run scope. Nike Flywire is structural cabling that locks the foot down
  under load. A scope is containment that holds tighter the harder the run works.
- **Relay** — inline subagents. Parallel legs, each runner independent, baton returns to you.
- **Taper** — context compaction. Shed volume, keep fitness, arrive at the event sharper.
- **Baton** — elicitation. The agent hands off to a human; nothing moves until it is taken.
- **Muscle Memory** — scoped memory. Self-explanatory, and it correctly implies the agent gets
  better at recurring work without being retrained.

Risk: `Flywire`, `React`, `Adapt`, and `Nike+` are Nike marks; `React` also collides with Meta and
`Flywire` with a payments company.

## 7. Apple

**Grammar.** Two ordinary English words used with unusual precision. No mythology, no acronyms, no
jargon. A small set of modifiers reused across the system: `Quick`, `Live`, `Universal`, `Private`,
`Smart`, `Shared`. The name describes the experience, never the mechanism.

Signature picks:

- **Spaces** — work streams. Ordinary, plural, already Apple's word for a bounded place you work in.
- **Shortcuts** — automations. Apple's actual automation product, and the closest existing consumer
  concept to a natural-language versioned automation.
- **Quick Ask** — elicitation. Sits in the `Quick Look` / `Quick Note` family and reads as low-cost,
  which is the right expectation for a one-question interrupt.
- **Gatekeeper** — the smart ingress. Verifies every inbound signature before anything is allowed to
  run. Apple's existing name for this is already correct.
- **Continuity** — the live room. State stays consistent as you move between surfaces and sessions.
- **Handoff** — classified fallback routing. The work moves to another route and carries on from
  where it was, with no visible seam.
- **Sidecar** — inline subagents. Offload work to a second surface that reports back.
- **Sandbox** / **Extensions** — run scope and progressive plugin loading. Apple's own vocabulary for
  bounded authority and opt-in capability, used correctly.
- **Optimize Context** — compaction, modelled on Optimize Storage. Reclaims room, keeps what matters
  reachable, requires no explanation.

Risk: nearly every strong pick here is a live Apple feature name — `Shortcuts`, `Handoff`,
`Continuity`, `Sidecar`, `Spotlight`, `Gatekeeper`, `Mail Drop`, `Quick Look`.

## 8. Anduril

**Grammar.** Short, hard, one word wherever possible. Mythic weapons and predators for autonomous
systems. Aviation and mil-ops vocabulary for procedures. Versioned `Mark` designations for hardware.
One grand connective noun for the layer everything else plugs into. Nothing cute, nothing explained.

Signature picks:

- **Ghost** — the agent. Goes out, operates on its own, comes back with the result.
- **Sortie** — one agent run. Bounded, briefed, flown, debriefed, counted.
- **Leash** — the frozen run scope. One syllable, and it carries the entire semantic: it can be
  shortened mid-run, never lengthened, and the run cannot outrun it.
- **Loadout** — progressive plugin activation. You carry what the sortie needs, chosen before launch
  from what you are authorized to carry.
- **Lattice** — the live room. The shared mesh every participant and system reads the same state
  from.
- **Sentry** / **Mark** / **Emplacement** — automations, immutable versions, and the specific
  installed instance with its own authorizations. Emplace it once; it watches and acts.
- **Wisp** — inline subagents. Small, detached, expendable, returns what it saw.
- **Bastions** — Global and EU. Sovereign, hardened, isolated by design.
- **Overwatch** — audit and inference logging. Always watching, records everything, says nothing.
- **Divert** — fallback routing. Primary is unusable; go to your alternate; the flight continues.

Risk: `Lattice`, `Ghost`, `Sentry`, `Wisp`, and `Menace` are Anduril's own; `Lattice` also collides
hard with a well-known HR platform and `Sentry` with a major developer-tools company.

## 9. Names with no collision problem

If a direction is chosen and the flagship names have to survive trademark review, these are the
picks from across all six columns that are distinctive, descriptive of Avalon's actual mechanics,
and not already someone else's mark in an adjacent category:

| Feature | Name | From |
| --- | --- | --- |
| Frozen run scope | **Leash** | Anduril |
| One agent run | **Sortie** | Anduril |
| Plugin activation | **Loadout** | Anduril |
| Context compaction | **Taper** | Nike |
| Context compaction | **Stage Separation** | SpaceX |
| Tool receipts | **Chain of Custody** | Palantir |
| Elicitation | **Go/No-Go** | SpaceX |
| Elicitation | **Baton** | Nike |
| Fallback routing | **Engine-Out** | SpaceX |
| Inline subagents | **Relay** | Nike |
| Template version | **Last** | Nike |
| Subscription | **Standing Order** | Palantir |
| Regions | **Enclaves** | Palantir |
| Live room | **Common Operating Picture** | Palantir |
| Inference capture | **Full Take** | Palantir |
| Scheduler | **Watch Officer** | Palantir |

## 10. If a direction is chosen

Renaming is layered, and the layers do not have to move together:

1. **Marketing and docs only.** README, `docs/`, and site copy. Zero code risk.
2. **User-facing strings.** Renderer labels, menus, empty states, error copy. Touches renderer tests
   that assert on visible text; no contract or storage change.
3. **Internal identifiers.** Type names, file names, plugin IDs, service names. Large mechanical
   diff, contained within the repository.
4. **API routes and storage columns.** Requires contract versioning and numbered D1 migrations, and
   migration files are immutable after deployment. This layer should be assumed permanent.

Layers 1 and 2 are reversible. Layer 4 is not. A sensible rollout renames the product vocabulary
first and leaves `workstreams`, `harness_runs`, and `automation_subscriptions` alone in storage
indefinitely.
