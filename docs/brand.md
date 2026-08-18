# Bench creative guide

This is the creative guide for **Bench** — the brand Avalon is becoming. It
exists so that every artifact we make — landing pages, product copy, launch
posts, error messages, sales notes — sounds and looks like it came from one
author with one point of view, no matter who or what wrote it, or when.

Naming status: the product currently ships as Avalon; "Bench" is the leading
candidate and this guide is written as if it were final. If the name changes,
the positioning, core idea, and character sections survive intact; the lexicon,
wordplay policy, and any name-dependent lines are rewritten.

## How to use this document

- **Read it before writing anything a user or prospect will see** — marketing
  pages, product UI copy, onboarding, emails, social, feature names.
- **Put it in the context of every AI generation of brand material.** Generic
  output is what a model produces when nothing constrains it; this document is
  the constraint set. Do not generate a hero, an email, or a tagline without it.
- **Check judgment calls against the rules, not against taste.** You should be
  able to point at any sentence and name the rule it breaks. If a call can't be
  checked against this guide, the guide is missing a rule — add it, with a
  changelog entry saying why.
- **Copy from the proof artifacts.** The examples in
  [section 8](#8-proof-artifacts) are the reference implementations of the
  voice. Imitating them propagates consistency faster than re-reading rules.

## 1. Positioning

**What Bench is:** the **collaborative AI workspace** — the validated
descriptor; removing any one of the three words loses meaning. People do their
AI work in Bench the way they do it today in ChatGPT or Claude, with one
difference that is the whole product: the work is on a shared surface.
Colleagues enter the stream itself — the context, the iterations, the
reasoning — not a pasted final answer.

**The problem it exists for.** Valuable knowledge work now happens inside LLM
sessions, and the only way to share it is copy-paste. That amputates
everything that made the work trustworthy: how the number was derived, what
was searched, which options were rejected. Colleagues see an output with no
provenance, and the mess scales quadratically with every collaborator. Bench
brings people into the work instead of mailing them its residue.

**What leads and what stays quiet.** For the first ~12 months Bench leads with
best-in-class collaborative sessions. Automations exist in the product and are
**submarine**: present, discoverable, never the marketing hook. Builders find
them on their own. No marketing artifact leads with automation until suggested
automations are turned on. (Why: see the 2026-08-18 collaboration-first
changelog entry.)

**Who it's for — the Operator.** Our umbrella term for the AI-forward
knowledge worker at a small or mid-sized company: already a daily ChatGPT or
Claude user, comfortable prompting and re-prompting, carrying a heavy digital
workload — recruiting, GTM, marketing, IT, ops, finance. Two tiers matter:

- **The spearhead** — the curiosity-driven builder who will bang their head
  against a wall for a payoff, adopts first, and mandates the tool for
  colleagues ("if you get a SAFE note, you're uploading it here, full stop").
- **The AI-forward colleague** — uses AI daily but doesn't self-generate
  automations or think in workflows. Thinks in tasks. Smart, not less capable
  than an engineer — just never trained to automate, because no trade outside
  software engineering trains that reflex.

Gatekeeping by terminology is deliberate: the target already knows what an LLM
is, and we do not spend copy teaching anyone what one is.

**Who it's not for (deliberately):** engineers — for them, collaboration on
work-in-progress is a solved problem; it's called GitHub. Bench is that shared
floor for everyone else in the building. ("GitHub for the rest of the company"
is a useful internal shorthand; don't use it in public copy.) Also not yet:
users who need to be sold on AI itself.

**The 90/10 mechanic — why collaboration is the wedge.** For a non-builder,
90% done is 0% done: if the output isn't fully right, they abandon and never
retry. The fix isn't better automation — it's a colleague. The spearhead takes
the last 10% and hands back a win; the first win creates the habit. Handoffs
are the beating heart of the product, and proof-of-work is what makes a
handoff trusted: a reviewer who can see twenty iterations believes the work; a
reviewer who sees one prompt and one output suspects laziness. **Deliver the
workstream, not just the artifact.**

**What it displaces:** private ChatGPT/Claude sessions (the explicit wedge —
"session stealing" — is people doing their daily AI work *here*), and
copy-paste-into-Slack as the team's sharing mechanism. Slack stays a delivery
and on-ramp surface — the summary lands there, the work lives on the bench.

**A copy insight worth keeping:** the question that finds real value is not
"what do you do repeatedly?" — it's **"what didn't you do yesterday because
you didn't have time?"** High-importance tasks get artisanal treatment; the
untouched backlog (the LinkedIn posts, the BD outreach) is where Bench earns
its keep. Write to the backlog, not the routine.

**Onlyness statement:** Bench is the only workspace where AI-forward teams do
their AI work on a shared surface — context, reasoning, and handoffs included
— instead of alone in private chats.

## 2. Core idea

> **Your AI work belongs on the bench — a shared surface, not a private chat.**

A bench is the one surface in a shop everyone can walk up to. Work in progress
sits on it, visible: you can see what's done, how it got there, and what's
left, and anyone on the floor can pick it up. That is the product, and it's
what the name means.

The before: everyone's best thinking happens alone, in a private chat tab.
What the team gets is a pasted final answer with the reasoning amputated, and
a sidebar of vaguely-titled sessions nobody can navigate. The after: the work
sits on the bench. A colleague opens the stream, sees how you got here, takes
the last 10%, hands it back. No copy-paste, no "wait, what's the context?"

**The rule:** every artifact must be traceable to this idea. Before shipping
anything, ask: *does this show work coming out of a private chat onto a shared
surface — seen, picked up, or handed off?* If the answer is no, the artifact
doesn't ship until it does.

**The metaphor stack** — three meanings of "bench", each with an assigned job.
Use one per artifact; don't stack them in a single line.

| Metaphor | Job | Where it lives |
| --- | --- | --- |
| **Workbench** (the shared surface where work sits visible and anyone can pick it up) | The primary metaphor. It *is* the product description. | Everywhere — core copy, product, sales, visuals. |
| **Bench press** (strength, the gym) | Campaign spice only. | See [section 6](#6-wordplay-policy). |
| **Bench strength** (your depth, the players off the sideline) | **Reserved.** It described a fleet of agents we deliberately don't build. May return if/when automations become the story. | Nowhere, for now. |

## 3. Character: the foreman

Bench's voice is a person: **a foreman, talking to a smart new hire he
respects.** Voice is not a list of adjectives — it's this character speaking
consistently. When a line feels off, don't ask "is this on-brand?"; ask *would
the foreman say it?*

**Who he is.** A working leader promoted from the floor. He came up through
every station in the shop, so his authority is earned through competence, not
conferred by title — and he still has tools on his belt. His pride is a
well-run floor: work sits out on the bench where everyone can see its state,
not locked in somebody's locker, and handoffs are clean — the next person
picks a job up without asking what happened before they arrived. He teaches by
demonstration — "here, watch" — then hands you the tool. He speaks
economically and in specifics, because on a shop floor vague instructions cost
fingers. He's unimpressable: he's seen everything, so he never hypes and never
panics. He is judged by exactly one thing — whether the job shipped — and he
knows it.

**Who he is not.** Not a boss (he works), not a founder (he doesn't pitch), not
a bro (see below), not a wizard (nothing here is magic, and he'd be insulted
by the suggestion — it's skill and a well-organized floor, and he can show you
both).

**His stance toward the reader.** The reader is smart and capable and has
simply never been shown these tools. He never talks down, never over-reassures,
never performs enthusiasm. His respect shows as directness: he assumes you can
handle a plain sentence about what went wrong and what to do next.

**On masculine.** The brand is masculine the way a well-run shop is masculine:
sturdy, plainspoken, organized, load-bearing. Carhartt and DeWalt, not the
locker room. This is a recorded boundary, not a vibe: the buyer population
(recruiters, marketers, GTM) is a mixed room, and the spearhead has to bring
colleagues along — gym-bro voice makes them spend social capital apologizing
for us. Craftsman-masculine reads as competence to everyone; locker-room
masculine reads as a club with a door policy.

**The foreman would never say:**

- Anything ending in an exclamation mark.
- "Simply" or "just" before an instruction. (If it were simple they wouldn't
  need showing.)
- "Don't worry" / "sit back and relax". (He doesn't manage your feelings; he
  shows you the work.)
- "Magic", "magical", "like magic". (It's work on a surface, and he can show
  you exactly how it got there.)
- "Oops!", "Uh oh!", or any cutesy error copy.
- Any word on the banned list in [section 5](#5-lexicon).

## 4. Voice rules

Five rules. Each with rewrite pairs, because the pairs are the actual
specification — the prose just explains them.

### 4.1 Name the actual work

Operators recognize their tasks; nobody recognizes a "workflow". Concrete nouns
from a real week beat category words every time. And per
[section 1](#1-positioning), aim at the backlog, not the routine.

> ✗ Streamline your team's AI-powered collaboration.
> ✓ The blog post that's been "this week" for three weeks. Put it on the
> bench.

> ✗ Share AI-generated insights across your organization.
> ✓ Simon opens your deck draft, sees the three versions you already tried,
> and doesn't suggest any of them again.

### 4.2 Show before you claim

The brand's core move is the foreman's: "here, watch." Demonstrate, then let
the reader conclude. A claim is what you make when you can't show. The product
makes the same move — a colleague trusts work because the iterations are
visible — so the copy that sells it must work the same way.

> ✗ Bench transforms how modern teams collaborate with AI.
> ✓ Watch Maria hand half-finished work to Simon — and watch him finish it
> without asking a single "wait, what's the context?" Two minutes.

> ✗ Our intelligent workspace understands your business context.
> ✓ The brand voice doc, the customer definition, last quarter's decisions —
> on the bench, where every draft gets checked against them.

### 4.3 Short declaratives. No hype.

Periods, not exclamation marks. One strong claim beats three weak ones.
Confidence is quiet — the foreman doesn't hype the table saw; he says what it
does and lets you watch it cut.

> ✗ Unleash seamless AI collaboration and 10x your team's productivity!
> ✓ One link. They see the work, not just the answer.

> ✗ Say goodbye to messy copy-paste workflows forever!
> ✓ Nothing to paste. The work is already where your team is.

### 4.4 Talk to a smart new hire

Respect the reader's intelligence; supply the tools. Never reassure them about
a difficulty you just implied. Explaining the tool is respect; explaining their
job is condescension. Our reader already runs daily ChatGPT sessions — write
to that, never beneath it.

> ✗ Don't worry — it's just like ChatGPT, but even easier! Anyone can use it!
> ✓ If you run ChatGPT sessions all day, you already know how to use Bench.
> The difference is your team's in it.

> ✗ Even non-technical users can collaborate with AI!
> ✓ Engineers have had a shared floor for years. This one doesn't require
> being one.

### 4.5 Bench tasks, never people

In common usage, getting benched means being pulled out of the game — so the
verb points at work, always. The Operator stays in the game and stays the
hero. Judgment calls always stay visibly with the reader: Bench drafts, flags,
and lays the work out; the person decides.

> ✗ Let AI take over your team's work.
> ✓ Bench flags the ten conflicts. You resolve eight, tag your CEO on two.

> ✗ Bench replaces hours of manual effort.
> ✓ On Bench, you don't get benched. The busywork does.

### Tone by surface

The voice is constant — one character — but he modulates by where he's
standing:

| Surface | Register |
| --- | --- |
| Campaigns and social | Most swagger. Wordplay allowed per [section 6](#6-wordplay-policy). |
| Marketing pages | Confident, demonstrative, zero spice in the hero. |
| Product UI | Quietest. Plain instructions, no personality performance — a good tool doesn't chat. Automation surfaces are the quietest of all: submarine features never announce themselves. |
| Errors and failures | Plainest of all. Say what happened, own it, give the next step. Never joke in an error. |
| Docs and onboarding | Instructional. "Here, watch" energy: demonstrate, then hand over. |

## 5. Lexicon

Consistent nouns do more for identity than any tone guidance. These are the
words Bench owns, and the words it refuses.

### Owned words

| Word | Use | Rule |
| --- | --- | --- |
| **Bench** (capital B) | The product — and **the actor** in copy. | "Bench drafts the reply", "Bench flags the conflicts". Never "the AI", "the agent", or "the assistant" as the actor. |
| **the bench** (lowercase) | The shared surface. "On the bench" = visible, in progress, where the team can see it. | The physical heart of the metaphor; use it literally. |
| **bench** (verb) | To move a piece of work onto Bench. | **You bench tasks, never people.** No exceptions, including jokes. The verb is also the behavior we measure: a session started here instead of in a private chat. |
| **workstream** | One piece of work and everything it took — the context, the iterations, the reasoning, the result. | Delivered whole: the workstream is the unit of sharing, not the artifact at the end of it. |
| **handoff** | Passing live work to a colleague with all of its context attached. | The product's hero moment; prefer it over "share", which implies a dead copy. |
| **show** | How you bring someone into the work, and how you teach Bench a task. | "Show, don't paste." Never "configure", "set up a workflow", or "train". |
| **run** | One execution of an automation. | Product vocabulary only. Submarine: never in marketing while sessions lead. |
| **ship** | Finishing real work. | Sparingly, where it's literally true. |

**Retired: "crew."** It reads as a fleet of agents — an abstraction Bench
deliberately does not have, because managing a swarm is exactly the
mad-scientist overhead the Operator doesn't want. There is one Bench in the
room and it doesn't need a headcount. Do not use "crew" in any copy; see the
2026-08-18 collaboration-first changelog entry.

### Feature naming

Functional, descriptive names, lowercase seriousness: *workstreams*, *runs*,
*handoffs*, *projects*. No cute names, no portmanteaus, no "-ify", no mascots
— and **no "AI-" prefixes on features**: labeling a feature "AI-powered"
measurably lowers purchase intent for high-stakes products (Washington State
University study), and it violates 4.2 besides — it's a claim where a
functional name would be a demonstration. "AI" earns its place in exactly one
spot: the category descriptor, "collaborative AI workspace", where it
self-selects the audience we want.

Not every name needs to be shop-themed. "Workstream" is a functional name that
passes every rule here; renaming it to something bench-flavored would be
metaphor-stacking. The metaphor is the frame, not a costume for every noun.

### Banned words

Each of these is banned because it's a claim wearing a costume — the
statistical signature of AI-generated SaaS copy, and the opposite of showing:

*supercharge, unleash, empower, seamless, effortless, revolutionize,
game-changing, transform (as hype), magic/magical, superpowers, 10x,
"AI-powered" (as praise), copilot, sidekick, "the future of work",
next-generation, cutting-edge, delve, elevate.*

Banned as category jargon in user-facing copy (fine in engineering docs):
*agent, bot, workflow, harness, LLM* (as a product word — the audience knows
the term; our copy names the work instead), *orchestrate, swarm, fleet,
multi-agent.* The Figma test: Figma says "collaborative design", not what the
rendering engine is. Bench says **collaborative knowledge work**, not what the
model layer is.

Also banned: exclamation marks anywhere, sparkle/rocket/robot emoji, and ✨ as
an AI signifier in UI or marketing.

If a banned word appears in a draft, the fix is never a synonym — it's to
replace the claim with the demonstration it was standing in for.

## 6. Wordplay policy

The gym double-entendre is real equity — and it is **campaign spice, not brand
voice**. The joke presumes the reader already knows what Bench is; the surfaces
that *create* that knowledge can't run on it.

**Where spice is allowed:** social posts, paid campaigns, swag, billboards and
OOH, event booths, launch moments.

**Where it never goes:** the homepage hero, product marketing page core copy,
product UI, onboarding, docs, error messages, pricing, sales collateral.

**The flagship line — "What do you bench?"** — is the one piece of wordplay
with standing approval, because it can be answered in workload, which makes the
joke do product work instead of just being a joke:

> What do you bench?
> "The whole candidate pipeline — and Simon can pick any of it up."
> "Every investor update in the building."

**Second-tier lines** — "You don't need a spotter", "show me how much you
bench" — usable in campaigns at the copywriter's judgment, subject to the
spearhead test.

**Swag-only:** "Do you even bench?" It's the funniest and the most locker-room;
on a t-shirt at a conference it's charming, in a feed it's a door policy.

Two standing rules: the answer to any gym line must resolve to *work*, never to
actual lifting culture; and no spice may break the "bench tasks, never people"
rule — nobody gets benched in a Bench joke.

## 7. Visual direction

This is direction for the design system, not the system itself. The design
language is derived from the same character as the voice: the well-run shop.

**The defining motif — the shadow board.** A pegboard where every tool has a
drawn outline showing where it belongs. It is the whole brand in one image:
organization made visible, a place for everything, and shared context you can
see at a glance. Use it structurally (layouts with drawn "homes" for content),
not just decoratively.

**The second motif — work on the surface.** The bench itself: work-in-progress
laid out flat where the whole floor can see its state. Proof-of-work is a
design principle, not just a product feature — show the iterations, the
margins, the flags, not a lone polished output. A screenshot that shows one
pristine answer is off-brand; one that shows the work getting there is the
brand.

**Materials:** graph paper, birch ply, steel, stencil lettering, chalk lines,
masking tape. Texture that implies weight and use, applied with restraint — the
shop is *clean*. Ruthless simplicity and organization are the brief; clutter is
off-brand even when it's on-material.

**Color:** paper off-white grounds, charcoal and steel neutrals, and one
**shop-safety-yellow accent used like a chalk line, not a paint job** — it
marks the thing that matters on a screen and nothing else. No gradients as
identity.

**Type:** an industrial grotesque with DIN/stencil flavor for headlines; a
plain, highly readable grotesque for body; monospace for data, runs, and
receipts. Nothing rounded-friendly, nothing sci-fi.

**Imagery:** technical linework and isometric drawings; real product
screenshots showing real named work (an actual pipeline report, an actual
draft with flags on it). Never abstract 3D blobs, orbs, neural-network art, or
robots.

**Banned outright** — the visual equivalents of the banned-word list, i.e. the
default AI-startup look: purple-to-blue gradients, glassmorphism, floating
glowing orbs, sparkle iconography, dark-mode-neon "AI aesthetic", robot
mascots.

**Motion:** mechanical and precise — things snap, slide, and seat like machined
parts. Nothing floats, nothing bounces, nothing shimmers.

## 8. Proof artifacts

The voice, demonstrated. These are reference implementations: when writing
something new, start from the nearest one. Each notes the rules it exercises.

**Homepage hero** *(core idea; sessions lead, zero automation, zero spice)*

> **Your best work is happening in a chat window. Alone.**
>
> Bench is the collaborative AI workspace: the same sessions you already run,
> on a surface your team can see. Simon opens your draft, sees how you got
> here, takes the last mile — no copy-paste, no "what's the context?"
>
> [ Put something on the bench ]  [ Watch a handoff — 2 min ]

**Empty state, first session** *(4.1 name the work; 4.4 smart new hire)*

> Nothing on the bench yet.
>
> Start with the thing you'd normally take to ChatGPT. Same work — but here,
> your team can pick it up where you leave it.

**Handoff notification** *(proof-of-work; 4.5 judgment stays with the reader)*

> Maria handed you the launch post. Eight conflicts resolved, two need your
> call — the whole trail is on the bench.

**Slack delivery** *(Slack as on-ramp: summary lands there, work lives here)*

> Done — 32 follow-ups drafted, 3 flagged for review. Full work on the bench:
> [link]

**Error message** *(tone-by-surface: plain, owned, next step; no jokes)*

> This run stopped — the spreadsheet it reads was moved. Point it at the new
> location and it picks up where it left off.

**Launch post, social** *(spice per section 6; answered in workload)*

> What do you bench?
>
> Maria benches her whole candidate pipeline. Dev benches every investor
> update in the building — and their teams can pick any of it up.
>
> Bench — collaborative AI workspace, for people with real work to do.

**The spearhead's message** *(the artifact the whole brand is tested against:
what the first adopter pastes into the team Slack. If our copy can't sound
like this, it's overwritten.)*

> Been running Bench for two weeks — it's where I do my ChatGPT stuff now.
> The difference: Dev opened my pricing session yesterday, saw how I got the
> numbers, and finished the doc himself. Ten minutes to see it — worth a look.

## Changelog

### 2026-08-18 — Collaboration-first: the crew is out, the shared bench is in

**What changed:** The core idea is replaced — "Bench gives every Operator a
crew" is overturned in favor of **"your AI work belongs on the bench — a
shared surface, not a private chat."** The workbench is promoted from visual
world to primary metaphor; bench strength is demoted to reserved; "crew" is
retired from the lexicon and *agent, bot, workflow, orchestrate, swarm, fleet*
are banned in user-facing copy. Positioning now leads with collaborative
sessions for ~12 months with automations as submarine features; the ICP is
sharpened to AI-forward daily LLM users in two tiers (spearhead builders, and
AI-forward colleagues who think in tasks, not workflows). Feature naming adds
the no-"AI-"-prefix rule. The proof artifacts are rewritten to sell the shared
session, and Bench (the product) becomes the named actor in copy.

**Why:** The same-day ICP/positioning session overturned two assumptions this
guide was built on that morning. First, **Bench will not have multiple
agents** — a fleet is the wrong abstraction; managing a swarm is mad-scientist
overhead the Operator explicitly does not want — so "crew" and "bench
strength" described a product we refuse to build. Second, **the target lacks
the automation-first mindset**: software engineering is the only trade that
trains automation as a reflex, and even AI-forward users think in tasks. An
automation-led brand markets to a reflex the audience doesn't have, and an
over-exposed automation (one runaway emailing 100 people) is a trust-killer.
The observed pain is different and sharper: valuable work happens inside LLM
sessions, the only sharing mechanism is copy-paste, and the reasoning chain is
lost — while for non-builders 90% done is 0% done unless a colleague can take
the last 10%. Collaborative handoff, not automation, is the wedge. The
"AI-powered" feature-naming ban follows a Washington State University finding
that AI labels lower purchase intent for high-stakes products.

**Considered and rejected:**

- *Keeping "crew" as a humans-only word* (your colleagues as the crew). Too
  contaminated: in this market "crew" reads as agents first, and the one word
  can't carry a meaning the category actively subverts.
- *Renaming "workstream" to a shop-themed noun.* Functional names beat themed
  ones (the naming discussion and the WSU finding point the same way), the
  team likes the word, and theming every noun turns the metaphor into a
  costume. Recorded as guidance; final call on the name stays open.
- *Leading with automation anyway.* No usage data yet to make suggested
  automations good, and the failure mode is trust-fatal. Automations stay in
  the product, submarine, until the data exists (~12 months).

**Consequences:** No marketing artifact leads with automation until suggested
automations turn on. "Crew" appears nowhere; the AI is called "Bench," never
agent/bot/assistant. Bench-strength is reserved, not deleted — it may return
as the frame if and when automations become the story, and whoever revives it
should reread this entry first. The previous entry's core idea stands below as
the record of what was believed that morning, not as guidance. The proof
artifacts changed with the body, per the standing rule that changing the voice
means changing them in the same change.

Drafted in the Bench rebrand working session, 2026-08-18, from the marathon
ICP/positioning meeting notes of the same day. PR link to be added when opened.

### 2026-08-18 — Guide created; founding brand decisions recorded

**What changed:** This document — the first codification of the Bench brand:
positioning around the Operator and the spearhead, the core idea ("Bench gives
every Operator a crew"), the foreman character, five voice rules, the lexicon
and banned list, the wordplay policy, and the visual direction.

**Why:** The rebrand from Avalon to Bench is in motion, and every prior attempt
at brand artifacts (the current with-avalon.com hero included) came out
generic and recognizably AI-generated. The diagnosis: artifacts were being
generated with no core idea, no character, and no banned list, so the model
filled the vacuum with the average of every SaaS page ever written. This guide
is the constraint set that prevents that, and it precedes the new homepage
deliberately — the page is written *from* it.

**Considered and rejected:**

- *Gym-bro meme energy as the core voice.* The wordplay is genuinely strong
  equity, but the buyer room is mixed and the adoption motion runs through a
  spearhead spending social capital on us; locker-room voice taxes that
  capital. Kept as campaign spice under an explicit policy instead.
- *"Workbench" as the primary metaphor.* Sturdy and right as a visual world,
  but it describes an aesthetic, not the product. "Bench strength" — agents as
  your crew/depth — describes what Bench actually does, so it took the center
  and the workbench became the material world.
- *"Benching" as an unqualified verb.* Getting benched means being pulled from
  the game; unmanaged, the verb points at the user. Resolved with the standing
  rule: you bench tasks, never people.

**Consequences:** Every future brand artifact — human- or AI-written — is
generated with this guide in context and checked against it; an artifact that
can't be traced to the core idea doesn't ship. Judgment calls that this guide
can't settle mean the guide grows a rule, with an entry here saying why. The
proof artifacts are the reference implementations; changing the voice means
changing them, in the same change. If the product name moves off "Bench",
sections 1–3 survive; 5 and 6 are rewritten.

Drafted in the Bench rebrand working session, 2026-08-18. PR link to be added
when opened.
