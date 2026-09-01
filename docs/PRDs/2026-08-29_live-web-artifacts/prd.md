# Live web artifacts

> Created 2026-08-29.
>
> A work stream's participants can ask Rally for a working web page or small
> web application — a landing page, a dashboard, a calculator, a poll — and
> get a hosted, openable, revisable site rather than a code listing. The model
> builds the site in the Terminal sandbox and publishes it with the existing
> Terminal publish tool — widened to accept a directory, no new publish
> tool; the agent reads a stateful site's data through one new two-tool
> read family — and
> Rally serves it from an isolated per-artifact origin on Cloudflare's Worker
> Loader (Dynamic Workers), statically or with model-written server code as
> the request demands — statefully, when the site exports a storage class
> Rally runs as a Durable Object facet with its own isolated SQLite.
> Companions:
> [state](state.md),
> [site authoring skill draft](site-authoring-skill.md) (the complete
> loadable-skill text the Agent behavior section commissions),
> [research](research.md) (directions deliberately not taken, kept so
> they are not rediscovered expensively). Siblings:
> [terminal artifact generation](../2026-08-27_terminal-artifact-generation/prd.md)
> (the document pipeline this extends),
> [resource versioning](../2026-08-27_resource-versioning/prd.md) (the history
> beneath republishes),
> [inline resource citations](../2026-08-27_inline-resource-citations/prd.md)
> (how the chat references what was built). Subsystem references:
> [Terminal work spaces](../../terminal-workspaces.md),
> [architecture](../../architecture.md), [security](../../security.md),
> [access revocation](../../access-revocation.md),
> [regionalization](../../regionalization.md),
> [domain migration](../../domain-migration.md),
> [Durable Object SQLite](../../durable-object-sqlite.md) (required
> reading for the facet data plane, implementers and reviewers alike),
> [Durable Object migration tracking](../../durable-object-migration-tracking.md),
> [branded identifiers](../../branded-ids.md),
> [choosing queues or RPC](../../choosing-queues-or-rpc.md),
> [agent tools](../../agent-tools.md),
> [writing skills](../../writing-skills.md),
> [feature flags](../../feature-flags.md). This PRD creates a subsystem
> no existing document owns; the implementing change adds
> `docs/live-web-artifacts.md` to the shape in
> [module documents](../../module-documents.md) and registers it in
> [the documentation index](../../README.md). Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

Today a document-shaped request becomes a published Markdown resource. This
PRD gives the same treatment to a *site-shaped* request: "make a landing
page for the launch", "build a little dashboard over these numbers", "put
up a poll for the offsite date". The model writes the site's
files in the work
stream's Terminal sandbox exactly as it writes a document, then publishes the
directory with the same `terminal_publish_resource` call that publishes a
document — the tool widens to accept a directory, and gains no new
parameters. The publish creates a **live artifact**: a
generated resource of a new site kind that Rally also *serves*, at a stable
per-artifact HTTPS origin, to every participant who opens it.

The model chooses the artifact's nature per request, and expresses the
choice entirely in what it writes to disk — there is no mode parameter to
drift out of agreement with the files. An `index.js` at the directory root
publishes an **active** artifact: that module is model-written JavaScript
Rally executes per request as a Cloudflare Dynamic Worker inside a
capability-fenced sandbox — no network egress, no ambient bindings, only an
asset binding Rally hands it. An active artifact that only computes —
routing, search and filtering over data bundled at publish, a small API
the page calls — exports nothing else and stays **stateless**. An active
artifact that must **remember between visits** — a poll, an RSVP list, a
sign-up sheet — additionally exports one storage class, and Rally runs it
as a **Durable Object facet** of the artifact's supervisor object: the
model's class gets its own isolated SQLite database, storage survives
across requests and versions, and two participants opening the same poll
see and move the same tally. This is the architecture Cloudflare's own
platform runs in production — every Cloudflare OS gadget is a dynamic
worker whose class runs as a facet of its workspace's Durable Object —
and the data is never an opaque side pocket: Rally wraps the model's
class so the same rows back a **Data** view and CSV export in the rail
and two read-only agent tools, which is how "who hasn't voted?" is
answerable in chat. No
`index.js` but an `index.html` at the root publishes a **static** artifact —
assets only, served from the region's bucket. A directory with neither entry
publishes as one downloadable **archive** resource rather than failing, with
a single deliberate exception — a directory that reaches the archive
branch carrying exactly one file is refused with instructions, because
that shape is almost always a mistaken document publish — so
publishing a directory is total everywhere the intent is unambiguous.

Viewing and revising are both multiplayer in the way the work stream already
is. Every participant with visibility of the work stream can open the
artifact — rendered live in the right rail's artifact detail, popped out
into the desktop's isolated artifact window, or in their browser — and
always sees the current version. Anyone can ask Rally to change it, in
chat, in their own words; the model edits the files and republishes the same
directory, which updates the same artifact in place, records the superseded
version through the resource versioning layer, and is what the next open
serves. Editing is model-mediated in V1; a direct source editor is
deliberately out of scope, on the seam the versioning PRD reserved for it.

## Motivation

The document pipeline shipped and immediately exposed its own boundary.
Models are at their strongest producing working HTML, CSS, and JavaScript —
it is the single densest competence in their training data — and
participants ask for exactly that: prototypes, internal pages, small tools.
What Rally does with such a request today is the worst of both worlds. The
model writes excellent files into the sandbox, and then the only exit is
`terminal_publish_resource`, which lands `index.html` in the rail as a
*text* resource: source code in a preview pane, nothing rendered, nothing
runnable, nothing another participant can click through. The alternative —
streaming the markup into chat — is the wall-of-text failure the document
PRD just eliminated, with the added insult that the text is code.

The gap is not generation; it is hosting. A site is only real at a URL. And
the platform Rally already runs on now sells exactly the missing piece:
Cloudflare's Worker Loader lets a Worker Rally deploys load and execute
model-written code at request time, in a fresh isolate, with
capability-based sandboxing (`globalOutbound: null`, bindings injected by
the loader) — no deploy pipeline, no per-artifact Cloudflare resources, no
container fleet. The 2026-08-12 Terminal research already reached this
conclusion from the other side: it rejected Dynamic Workers for the
*stateful, long-lived* coding sandbox and noted the mechanism fits "deployed
tenant programs" — which is precisely what a published artifact is. This PRD
is that reserved use case, built now because the document pipeline finished
the hard half (generation, publish identity, versioning, citations) and the
remaining half is one serving surface.

The expectation cost of waiting is real, if unmeasured: every mainstream
assistant surface ships runnable artifacts, and a workplace product whose
agent can *write* an app but not *show* it reads as broken to the people
Rally is dogfooding with. There is no incident ledger behind this — the
motivation is structural, and stated as such.

## Goals

1. A site-shaped request produces a hosted artifact a participant can open
   and use — never a code listing in the rail or markup streamed into chat.
2. The model decides, per request, whether the artifact is static or active,
   and an active artifact's server code executes only inside a
   capability-fenced runtime: request-scoped, no network egress, no
   authority beyond the bindings Rally injects.
3. An artifact is one durable resource with a stable identity: revisions
   republish the same directory, update the same artifact and URL in place,
   and record history through the existing resource versioning layer.
4. Every participant with visibility of the work stream, and only such a
   person, can open the artifact; all viewers see the current version, and
   a stateful artifact's stored data is one dataset shared across its
   viewers.
5. A stateful artifact's data is platform data, not a side pocket: it is
   visible in the rail (a **Data** view and CSV export) and readable by
   the agent through two read-only tools, so questions about what the
   artifact collected are answerable in chat.
6. Any participant can revise the artifact by asking in the work stream;
   concurrent asks serialize through the run loop that already serializes
   the work stream's agent work — and a revision never destroys stored
   data: the facet's database survives every republish.
7. Model-authored site content is never same-origin with the Rally
   application, with the regional API, or with any other artifact.
8. The serving surface is regional from day one: an artifact's bytes,
   stored data, and execution stay in its workspace's region.

## Non-goals

1. **A direct source editor or collaborative editing surface.** Deferred,
   deliberately, to the seam [resource
   versioning](../2026-08-27_resource-versioning/prd.md) non-goal 1
   reserved: live editor state lives wherever that future system puts it
   and materializes into the same version history. V1 edits are asks in
   chat.
2. **Public or anonymous sharing.** Deferred. An artifact is reachable only
   by authorized workspace viewers through Rally-minted access; there is no
   "anyone with the link", no unauthenticated mode, and no share-outside-
   the-workspace affordance until identity on the web exists to authorize
   it.
3. **Network egress from artifact code.** Rejected for V1 outright:
   `globalOutbound` is `null`, and `fetch()` from a server module throws.
   The capability-binding pattern (a fenced gateway binding Rally injects)
   is the only future path, and it is its own PRD when something needs it.
4. **Custom domains, custom subdomain names, or vanity URLs.** Rejected.
   An artifact's hostname label is its own id on the artifact serving
   domain; naming is a product surface this change does not open.
5. **A general application platform.** Rejected. No build pipelines, no
   npm installs at serve time, no frameworks resolved server-side, no
   Python modules (the platform supports them; they are slow to start and
   nothing needs them), no per-artifact Cloudflare resources, no
   Workers-for-Platforms dispatch namespaces. One loader, one asset
   store, one facet per stateful artifact.
6. **Background execution.** Rejected, and load-bearing for the product
   contract: artifact code runs only inside a viewer's request. No alarms,
   no cron, no timers that outlive a response, no artifact-initiated model
   calls. This is what keeps a live artifact on the right side of the
   contract's "no background service runtime".
7. **Push-based live reload and viewer presence.** Deferred. Viewers see a
   new version on next load or reload; nothing pushes a refresh into an
   open preview pane or artifact window, and nobody sees who else is
   viewing.
8. **Model-facing runtime log access.** Deferred. Server-module errors are
   captured (see Product behavior) and surfaced to people; a typed tool
   that lets the model read its artifact's logs is real and wanted, and it
   is a tool with its own contract, so it waits for the follow-up rather
   than riding this PRD half-specified.
9. **EU availability at launch.** Deferred with the same honesty as the
   document PRD: generation requires the Terminal sandbox, which is
   explicitly `unsupported` in the EU today. The serving surface deploys
   to both regions in parity (staged, like the EU Daytona bindings), and
   EU artifacts arrive with EU Terminal support, not before. The team
   has directed that **enabling EU Terminal is pursued as its own
   workstream now** rather than left indefinite — so this deferral is
   expected to be short-lived, and nothing in this PRD needs to change
   when it lands: EU artifacts follow automatically.
10. **Defensive numbers are the team's, and three are already set.**
    Per the open-limit rule, the guards this design names ship open
    with the handover arithmetic — bundle size, file count,
    per-request body size, the visibility-cache interval (key design
    decision 6 — how stale a work-stream visibility answer may be, and
    so how long a viewer keeps artifact access after losing it),
    query-tool row and time bounds, and error-log retention. Three
    were handed over and answered during this PRD's review, so they
    ship as values rather than open: the viewer-session lifetime is
    24 hours and the per-session request-rate ceiling is 300 requests
    per minute (both decision 6), and the per-artifact storage quota
    is 100 MB (decision 12).

    **The rate ceiling was answered rather than opened, deliberately,
    because the sleep guarantee depends on it.** Decision 6 bounds
    compute per open at rate ceiling × session lifetime × concurrent
    viewers; left open, that product is unbounded and the guarantee
    the design leans on does not hold at launch. The limit rule admits
    exactly this route — a number the team was asked for and
    answered — so it is a value here rather than a placeholder to be
    discovered by a bill.
11. **Any artifact storage mechanism other than the facet.** Rejected for
    V1: no Rally-mediated key-value binding (a curated `STORAGE` API was
    designed and dropped — with a real database available, a KV facade in
    front of it is a second storage contract to teach and quota for
    strictly less power), and no writes into workspace-owned resource
    storage (the deeper platform tie is held in [research](research.md)).
    The facet is the one place artifact state lives, and the platform tie
    V1 ships is the read side: the rail's Data view, CSV export, and the
    agent's read-only query tools over the same rows.
12. **External write paths into artifact data — agent tool and rail
    edits alike.** Deferred, as the team's explicit call: in V1 the
    *only* thing that writes artifact data is the artifact's own
    request paths. The agent changes data by revising the artifact
    (adding an admin route to the page when moderation is needed), and
    the rail's Data view stays browse-and-export. Both alternatives
    were put to the team and declined for V1: *a row-delete action in
    the Data view* (human-fast moderation, but a Rally-authored write
    authority into model-designed schemas with its own audit story)
    and *a typed agent write tool* (the same problem plus receipts, as
    the versioning layer's deferral precedent). The accepted cost is
    that fixing a rude RSVP is a model round-trip; if dogfooding shows
    that cost is real, the rail row-delete is the first path to
    revisit.
13. **Live rendering of prior versions of a *stateful* artifact.**
    Accepted limitation, not a choice to revisit lightly: one facet runs
    one class, so serving V3's code would mean aborting the live facet
    under current viewers, and running old code against the live schema
    is undefined behavior besides. A prior version of a stateful artifact
    opens as *source* through the versioning layer's preview; prior
    static and stateless-active versions still render live per key design
    decision 11.
14. **Page export of artifacts (PDF, image).** Deferred — and the
    ownership principle is fixed now so the deferral does not grow
    in-page workarounds: when page export arrives, it is
    platform-owned chrome (the message-export machinery — hidden
    window, per-page splash and footer — is the natural owner), never
    UI inside the artifact. The skill forbids Print/Save/Export
    buttons in pages today and teaches `@media print`-friendly
    layouts, so pages built before export exists render well when it
    lands. The rail's per-table CSV export of a stateful artifact's
    *data* ships in V1 and is unrelated to this deferral.

## Product behavior

**Creation.** A participant asks for something site-shaped — "put up an
RSVP page for the offsite". The run, steered by an extension of the
document-generation standing policy:

1. Loads the Terminal plugin and writes the site as ordinary files in a
   stable directory beneath the sandbox's resource-output directory —
   `offsite-rsvp/index.html`, `offsite-rsvp/style.css`, and, because
   RSVPs must be remembered between visits, an `offsite-rsvp/index.js`
   that exports the storage class (`SiteData`) serving the page and
   owning its rows.
2. Publishes the directory with `terminal_publish_resource`, exactly as it
   publishes a document; the root `index.js` is what makes the publish an
   active site, and the result returns the artifact's URL.
3. Says, in chat, a short framing with an embed citation of the artifact —
   "The RSVP page is live in this work stream — open it and tell me what
   to change." — and none of the site's code.

Participants see the standard tool-activity rows (files written, site
published), then the message. The artifact appears in the right rail under
**Artifacts** as a site resource; its detail renders the site itself, live,
in a preview pane, above the URL, a **Pop out** action, a **Copy link**
action, the error log, and — via the versioning layer — the version list.
A stateful artifact's detail additionally shows **Data**: the tables the
site keeps, browsable read-only, with a CSV export per table — the same
rows the site itself reads and writes, so what participants see in the
page and what they see in the rail can never disagree.

**The model's choice of static versus active** is expressed in file layout,
never in a parameter: the policy steers it to write only assets (an
`index.html` root) when the page has no server behavior; to add a root
`index.js` when the request needs request-time computation — search or
filtering over data published with the site, or a small API the page
calls; and to export the storage class from that `index.js` only when the
request's essence is *remembering* between visits — a poll, an RSVP list,
a sign-up sheet. State is never added speculatively: a page that only
computes gets no database. A directory with
neither entry — a folder of generated outputs, say —
publishes as one downloadable archive, which is also how "zip that folder up
for me" becomes a single call. A participant can override the
site/document/archive shape in plain words, exactly as the document policy's
overrides work.

**Viewing.** Selecting the site resource in the rail *is* opening it: the
detail's preview pane renders the served artifact live — the real HTTPS
URL, rendered by Electron in an isolated embedded view the main process
owns (the mechanics are locked down in key design decision 10 and the
Security and trust model), not a screenshot and not a sanitized re-render.
The pane is a fixed region of the detail view with a reload control;
interacting with the site inside it is interacting with the artifact, so
the signups page can be searched without leaving the rail. **Pop out** opens the same
artifact in the dedicated artifact window when the rail is too small for
the site. **Copy link** copies the canonical artifact URL — which carries no
session, deliberately, and is useful precisely because of that: a
recipient who follows it lands on the neutral page, and a recipient
inside Rally opens it through the ordinary authorized flow, since the
canonical form is the same
`https://rallywith.ai/app/workstreams/<uuid>`-shaped link the rest of
the product already resolves. A recipient without work-stream
visibility gets the same denial they would get anywhere else in Rally.
**Open in
browser** mints a fresh access code and hands the system browser the
open URL that carries it in a fragment (decision 6).
The canonical URL always serves the most recent version, and so does every
default entry point: a chip or embed citation in chat, the rail preview,
the pop-out window, and a link someone saved all resolve to current — a
viewer who was reading V3 when V4 published sees V4 on their next load or
reload. A prior version is reachable only on direct request, from the rail
detail's version list: opening one renders *that* version read-only,
plainly labeled as not current with one action — back to current — and no
chip, embed, or shareable link ever pins a version. Opening the bare URL
without Rally-minted access shows a neutral page saying the artifact must
be opened from Rally — knowing a URL grants nothing, which is the house
rule for every other resource identifier and holds here. While an app
overlay is open above the rail — a dialog, the command palette, a
lightbox — the preview pane shows a quiet placeholder and the embedded
view is hidden (decision 10 explains why this is a rule, not a bug).

An **active** artifact behaves like a small application: every authorized
viewer's requests reach the same module. A *stateless* one computes per
request over the data published with it and holds nothing between
requests. A *stateful* one — its `index.js` exports the storage class —
is backed by one isolated SQLite database that all viewers share and
every version keeps: the RSVP page's list is one list, a republish never
resets it, and answering the poll from two laptops moves one tally.
Every request carries the viewer's workspace identity as trusted
headers (decision 13), so the page needs no name field and no seat
picker — your RSVP is yours because you sent it, votes deduplicate per
member, and the list shows real display names. A
**static** artifact is simply the current files.

**Revising.** "Make the header orange and add a maybe option" — from any
participant, at any time — leads the model to edit the files in the sandbox
(re-importing the current source from the published artifact first if the
sandbox was recycled) and publish the same directory again. Same artifact,
same URL, new version; the superseded version lands in the rail's version
list with agent provenance. From that list a prior version opens on direct
request — rendered read-only per the Viewing rules above for static and
stateless-active artifacts, source-only for stateful ones (non-goal
13) — with its *source* always readable through the versioning layer's
existing preview. A republish of a stateful artifact restarts its
running class on the next request (the facet is aborted and reloaded
with the new code — the reference platform's exact update lifecycle) and
touches none of its rows; schema evolution across versions is the
model's responsibility, taught by the skill as additive-only. Two participants asking
for changes at once are serialized by the substream run loop as any two
asks are; the versioning layer records whichever landed second as the later
version, and nothing is lost.

**States and failure.**

- *Terminal unavailable* (EU, origin rules): the site guidance does not
  render; behavior is today's. Same asymmetry, and same honesty, as the
  document PRD.
- *Publish fails* (empty directory, size guard, or a republish that would
  silently downgrade a live site to an archive — the kind rules under Agent
  behavior): the standard tool failure surfaces on its activity row with a
  recovery instruction, and the model repairs and retries per its ordinary
  loop. A multi-file directory that merely lacks a site entry is not a
  failure at all: it publishes as an archive, and the result says so
  plainly, so a misnamed entry is a one-step rename-and-republish
  recovery. A directory that reaches the *archive* branch carrying
  exactly one file is the exception — it is refused with the instruction
  to publish that file's own path, because the shape is almost always a
  document publish that grabbed the folder by mistake. A one-file
  directory whose file *is* a site entry is an ordinary static site, not
  a refusal: `launch-checklist/index.html` alone publishes and serves.
- *Server module throws at serve time*: the viewer gets a plain Rally
  error page from the serving Worker (never a stack trace); the error —
  message, stack, request path — is recorded to a bounded per-artifact
  error log shown in the rail's artifact detail, so a participant can
  paste it back into chat and the model can fix it. (A typed model-facing
  log tool is non-goal 8's follow-up.)
- *Viewer loses work-stream visibility*: their next request to the
  artifact origin is refused and their viewer session is not renewed —
  the same posture as every other resource surface; artifact access
  checks current visibility, not a grant frozen at open time.
- *Offline*: an artifact is a hosted page; it does not open offline, and
  the rail says so rather than pretending.

## Impact on the product contract

**One clause moves, and this PRD says so rather than squinting past it.**
The brief's agent clause reads: "An ordinary work-stream run may load the
Terminal plugin and execute bounded file/command operations inside one
isolated, authority-fenced, workspace-network-policy-governed sandbox when
code is useful. Rally still exposes no user-visible terminal, host shell,
PTY, background service runtime, or user-authored workflow runtime."

A live artifact keeps every item in that denial list — execution is
request-scoped only (non-goal 6), there is no daemon, no PTY, no workflow
runtime, and nothing user-visible resembling a terminal — but it creates a
**second execution locus for model-authored code**: the artifact runtime,
outside the Terminal sandbox, running in response to viewers rather than to
the model. That is a genuine extension of what the agent's output *is*, and
the brief should say it. Proposed amendment, to be made to the brief in the
change that implements this PRD: after the sandbox sentence, add — "A run
may also publish model-authored web artifacts that Rally serves to
authorized participants and executes request-scoped inside an isolated,
capability-fenced artifact runtime with no network egress."

Everything else refines existing contract: an artifact is a resource (a
named persistent kind); viewing one is viewing and creates no
participation — opening a page never adds anyone to the work stream,
even though artifact code learns who is viewing (key design decision
13); interacting with a stateful artifact writes attributed rows the
way posting a message writes an attributed message; the publish is a
typed, authorized, receipted tool write.

## Decision log

None yet.

## Key design decisions

1. **Worker Loader over every alternative serving mechanism.** The serving
   Worker holds a `worker_loaders` binding and materializes an artifact on
   demand with `LOADER.get(id, callback)`, per Cloudflare's Dynamic Workers
   API. Rejected alternatives: *static-only R2 serving* (kills active
   artifacts, the server-computed half); *Workers for Platforms
   dispatch namespaces* (a deploy pipeline and per-artifact upload API to
   manage, for tenancy Rally does not have — the loader's runtime callback
   plus the region's bucket is the whole pipeline); *rendering model HTML
   inside the desktop renderer* (violates the standing invariant that a
   document built out of model output is never same-origin with the
   application, and produces no URL two people can share). The isolate ID
   is `artifact:<artifact-id>:v<version>` — content-changes mint a new ID,
   unchanged republishes reuse the warm isolate, exactly the caching
   contract `get()` documents.
2. **A dedicated serving Worker per region, on a dedicated artifact
   domain.** Serving is a new Worker (`avalon-artifacts-global` /
   `avalon-artifacts-eu`) — not routes on `avalon-api-*` — so untrusted
   execution shares nothing with the API origin, its secrets, or its blast
   radius.

   **What "dedicated" means here is the deployed unit, not the source
   tree.** The serving Worker is a second entrypoint inside `apps/api`
   with its own Wrangler configuration, its own routes, and its own
   binding set — a separate Worker, separately deployed, on a separate
   origin. It is not a second app, because the thing it most needs is
   `durableObjectStubForRegion`: the one supported resolver for product
   Durable Objects, which lives in `apps/api/src/lib/` and encodes the
   jurisdiction-before-`idFromName` rule that decision 4 depends on. A
   second app would mean either moving that resolver into a shared
   package — a rename across every call site in `apps/api`, plus the
   two ESLint rules that name paths and bindings — or reimplementing it,
   which would put a second authority on jurisdiction routing in the
   tree and make a wrong-jurisdiction artifact object a live
   possibility. Sharing a source tree costs the isolation argument
   nothing: it is about which bindings the deployed Worker holds and
   what a compromise of it reaches, and the waistline below is
   unchanged. What the implementing change owes is the check that keeps
   it honest — the artifact Worker's build must not pull API bindings,
   secrets, or D1 in through a shared import, and that is asserted, not
   assumed.

   Artifacts are served from per-artifact subdomains of
   **`rallyusercontent.com`** — a domain the team already owns, in the
   `*usercontent.com` idiom the industry uses for exactly this
   isolation — as `<artifact-id>-g.rallyusercontent.com` and
   `<artifact-id>-eu.rallyusercontent.com`, wildcard-routed per region.

   **The region rides in the label, one level deep, deliberately.**
   Cloudflare's Universal SSL covers the apex and a *single* level of
   subdomain, so `*.rallyusercontent.com` is certificated for free
   while `*.g.rallyusercontent.com` — two labels deep — is not, and
   would fail the TLS handshake on every artifact open until Advanced
   Certificate Manager or Total TLS was bought and configured. Folding
   the region into the label keeps one wildcard, keeps the
   region-distinct routing decision 8 depends on, and costs nothing
   recurring. The alternative — the dotted `<artifact-id>.g.…` form plus
   ACM — is a live option if the team would rather pay for the nicer
   shape, and it is named in Provider configuration so the cost is
   visible rather than discovered at first handshake. Rejected:
   *paths on `rallywith.ai`* (every artifact same-origin with every other
   and cookie-adjacent to the product domain — the standard user-content
   mistake); *subdomains of `rallywith.ai`* (cookie scoping and PSL
   adjacency to the product apex; the industry norm for hosted user
   content is a separate registrable domain, and it is cheap). This is the
   repository's first wildcard route; `domain-migration.md` takes the new
   domain in the same change, and the no-wildcard-origins rule for
   `ALLOWED_ORIGINS` is untouched — artifact origins never call the API.
3. **Assets in the region's existing bucket, keyed by artifact and
   version.** Published site files land in `PAYLOADS`
   (`avalon-global-payloads` / `avalon-eu-payloads`) under
   version-immutable keys the serving Worker reads directly; there is no
   KV in this repository and this PRD does not introduce one (Cloudflare's
   own guidance prefers R2 for larger assets, and version-immutable keys
   make long asset cache TTLs safe). The publish stores a manifest —
   paths, content types, hashes, the resolved mode — beside the assets;
   the serving Worker's asset binding resolves requests against the
   manifest, static-site conventions included (`/` → `/index.html`).
   The manifest records `index.js` as *module, not asset*: a request
   for `/index.js` on an active artifact 404s through the asset
   binding rather than serving the server module's source — no secret
   can be in it (the sandbox guarantees that), but serving it is
   surface nobody asked for.
4. **One supervisor Durable Object per artifact, addressed by the
   artifact id its hostname carries, hosting the model's storage class
   as a facet.** A new
   jurisdiction-pinned `ArtifactHostDO` owns the artifact's
   serving-side truth: current version
   pointer, viewer-session issuance and checks, the bounded error log —
   and, for a stateful artifact, one **Durable Object facet** (`"data"`)
   running the model's exported storage class with its own isolated
   SQLite database. Facet isolation is symmetric: the model's class
   cannot read the supervisor's tables, and the supervisor cannot read
   the facet's except through the wrapper (decision 12). This is the
   production-proven shape — Cloudflare OS runs every gadget as a
   dynamic-worker facet of its workspace DO — and two of its constraints
   are adopted as rules rather than rediscovered: **requests to a
   stateful artifact route through the supervisor** (the serving Worker
   already consults it per request for the session check, and facet
   stubs cannot travel over RPC, so the supervisor forwards
   `facet.fetch(request)` itself); and **a version update is
   `facets.abort(reason)` then re-`get` with the new class** on the next
   request — storage survives the abort, and aborting a facet that is
   not running is a no-op, so the supervisor aborts defensively when its
   own in-memory tracking is cold (post-hibernation), exactly as the
   reference does. Artifact deletion calls `facets.delete`, which
   permanently removes the facet's database through the same lifecycle
   that deletes the resource.

   **The hostname is the address, the label is the artifact's own UUID,
   and that combination is what makes serving possible without a
   lookup.** The serving Worker holds no D1 (see Security and trust
   model), so given nothing but `Host:
   <artifact-id>-<region>.rallyusercontent.com` it must reach the right
   object with nothing else in hand. It takes the id straight from the
   host, parses it as a UUID, and resolves the stub through
   `durableObjectStubForRegion` — **the same resolver every other
   Durable Object in this repository comes from** — under the name
   `artifactHostDOName(region, artifactId)`, which is
   `<region>:artifact:<artifact-id>`. No index, no directory hop, no
   per-request database read on the hot path; the DO itself holds the
   resource linkage, so everything else (which work stream, which
   version, which bucket prefix) comes from the object once it is
   addressed.

   Three consequences of using the house resolver rather than a private
   one, each of which an implementation would otherwise get wrong:
   - *The name is opaque by construction, and the allowlist must say
     so.* `isOpaqueDurableObjectName` admits region tokens, UUIDs, and
     a closed set of fixed role words, so `artifact` joins
     `block-dashboard` in `FIXED_SEGMENTS` — the one-line change that
     file's own comment invites. Without it the object's migration
     report silently degrades to `objectName: null`
     (`migration-reporting.ts`), which is what happens to
     `AutomationAgent` today: `automation` was never added, so every
     one of its reports has been losing the operator-facing name. Fix
     that in the same change; it is the same line.
   - *The location hint comes from the publish, not from serving.*
     `durableObjectStubForRegion` wants a hint, and the serving Worker
     has no D1 to read the workspace's placement affinity from. It does
     not need one: an artifact object's **first** `get()` happens at
     publish, from the API Worker, which resolves it through
     `durableObjectStubForWorkspace` with the workspace's own affinity.
     Cloudflare honours a hint only on first lookup, so the serving
     Worker passing the regional fallback afterwards is a no-op against
     an object already placed. Get this wrong and artifact objects are
     minted a continent away from the work streams they check
     visibility against.
   - *The lint rule has to learn the binding.*
     `durable-object-region-routing` matches a hardcoded set of binding
     names, so `ARTIFACT_HOSTS` is added to it or the new namespace is
     simply not covered by the rule that forbids raw namespace access.

   **Using the artifact's own id as the label deletes the allocator
   this design first reached for.** An earlier draft minted a short
   random label from a regional `ArtifactLabelDO` and rejected
   "addressing by artifact id" along with it — but what that rejection
   was actually about is a *hostname→id index*, not the id. There is no
   index here: the host **is** the id. Region-wide uniqueness, the only
   property the allocator existed to guarantee, is what a UUID already
   is; `artifact_registry` in WorkspaceDO is a **per-workspace**
   database and could never have provided it, which is the whole reason
   an allocator was reached for. So the allocator goes, and with it a
   region-wide singleton sitting in the write path of every publish,
   its collision-regenerate loop, and a second DO class to migrate and
   name. The `artifact_id` column carries an `ArtifactId` brand per
   [`branded-ids.md`](../../branded-ids.md), because it is now used to
   build a Durable Object name — the exact confusion that document
   exists to prevent. The one thing paid for it is a 36-character
   hostname label, which no participant types: the address people hold
   is the canonical `rallywith.ai` link, and **Copy link** hands them
   that, never the artifact origin. Rejected: *a short random label
   plus the allocator* (machinery, a new DO class, and a widened name
   allowlist, all bought with a prettier hostname nobody reads);
   *a Rally-mediated key-value binding backed by this DO* (non-goal
   11 — a KV facade over a real database is a second storage contract
   for less power); *artifact state in workspace-owned resource
   storage* (the deeper platform tie, held in [research](research.md)).
5. **Active artifacts are one module with at most two shapes, and one
   injected binding.** The server module is the directory's root
   `index.js` — the loader's `mainModule`, under the single most
   conventional entry name in the training data. A *stateless* site
   default-exports `fetch(request, env)` and runs in the serving
   Worker's loader isolate. A *stateful* site instead exports
   `class SiteData extends DurableObject` — a fixed name, the same
   convention the reference platform uses (`getDurableObjectClass` with
   a fixed class name) — whose `fetch(request)` serves every request
   from inside the facet, with the same assets fallback; when both
   shapes are present, `SiteData` serves and the default export is
   ignored, a rule the activation message states. Either way the
   environment is injected by the loader per Cloudflare's bindings
   pattern (`ctx.exports` entrypoint stubs with per-artifact `props`):
   `env.ASSETS.fetch(request)`, serving the artifact's own published
   files, and nothing more — plus, inside `SiteData`, the Durable Object
   storage API (`this.ctx.storage.sql`, `storage.kv`) over the facet's
   own database. `globalOutbound: null`. No secrets and no Rally
   bindings: requests reach the module with Rally's viewer cookie
   stripped. What every request *does* carry is the viewer's workspace
   identity, as two trusted headers the serving side injects on every
   request regardless of method — `x-rally-viewer-id` (the stable member
   id) and `x-rally-viewer-name` (the display name, percent-encoded
   UTF-8; a header value is ASCII-only by RFC 7230, so a name needs
   *some* encoding, and this one is deliberately the `decodeURIComponent`
   idiom rather than RFC 8187's `UTF-8''…` form — chosen for how
   reliably a small model decodes it, and called out here and in the
   injection code so nobody mistakes a house convention for a standard
   header encoding) — after first stripping any inbound headers of those names,
   so a page or proxy can never forge them (decision 13).

   **The names are the house ones, which is not cosmetic here.**
   `packages/contracts/src/http-headers.ts` owns the product header
   prefix — every product header is minted `x-rally-*` and listed in
   `RALLY_HEADERS`, with `x-avalon-*` still honoured inbound under the
   rename's *switch what is written, widen what is read* rule. These
   two join that table rather than inventing a parallel `Rally-…`
   spelling beside it. The consequence lands on the strip, which is the
   anti-spoof mechanism: it must remove the **superseded aliases too**
   (`x-avalon-viewer-id`, `x-avalon-viewer-name`, via
   `rallyHeaderAliases`), because a header family whose readers widen
   and whose stripper does not is a family with a forgeable back door.
   Header names are case-insensitive, so the lowercase spelling here
   and the `request.headers.get("x-rally-viewer-id")` the skill teaches
   are the same header. The plugin
   prompt carries the TypeScript declarations, headers included, per
   Cloudflare's own advice that typed declarations are how an agent
   learns a binding. Rejected: *a Cap'n Web RPC contract between page and
   server* (the reference platform's choice, made for its code-mode
   agent) — Rally's artifacts keep plain HTTP `fetch`, the single most
   pretrained server contract there is, and the one that works
   identically in a browser tab.
6. **Viewer access is Rally-minted, short-lived, redeemed out of the
   URL, and re-checked against the two authorities that own the
   answers.** Opening an artifact calls the regional API
   (`POST /artifacts/:id/open`, authorized against current work-stream
   visibility), which returns a single-use, purpose-scoped access
   **code**. The code never travels in a request URL: the desktop (or
   the browser hand-off) lands on
   `https://<artifact-id>-<region>.rallyusercontent.com/__rally/open#<code>`,
   where a tiny Rally-served bootstrap page — not artifact code — reads
   `location.hash`, `POST`s the code to `/__rally/redeem` in the request
   body. **That endpoint never serves artifact content**: it consumes
   the code, sets the cookie, and answers with a redirect to the
   canonical artifact URL, so no artifact document is ever loaded at a
   location that held the code — nothing lands in history, in a copied
   URL, or in a screenshot, and same-origin model code has no
   `location` to read it from. Artifact responses also carry
   `Referrer-Policy: no-referrer`, and the redeem endpoint's own
   request is excluded from request logging. A fragment is
   never sent to a server, so the proof stays out of Cloudflare's
   invocation log, the Logpush export, and trace spans. This is
   `security.md`'s standing rule — *a new ticket audience never issues a
   ticket in a URL* — and an artifact origin is exactly such a new
   audience; single-use redemption bounds replay but does not keep a
   secret out of a log, so it is not on its own compliance. Redemption
   sets an `HttpOnly`, `Secure`, `SameSite=Lax` viewer-session cookie
   scoped to that one artifact origin, and the serving Worker then
   serves.

   **Revocation is two questions with two mechanisms, and this design
   answers both** — `access-revocation.md` is explicit that they must
   never be merged, and an artifact host that answered neither would
   hold a removed viewer's access open for the session's whole life:
   - *Session and membership revocation is a D1 fact*, so it arrives the
     way every other one does: `ArtifactHostDO` joins the existing
     access-revocation queue's fan-out and drops the named principal's
     sessions when the message reaches it. No new mechanism, one new
     hop in a walk that already exists.

     **It hangs off the workspace hop, not the work-stream hop, and
     that follows from where the registry lives.**
     `access-revocation.md`'s rule is that only an object knows its own
     children, from its own SQL — and `artifact_registry` sits beside
     the resource authority in **WorkspaceDO**, so `WorkspaceDO` is the
     object that can name artifacts and `WorkstreamDO` is not. This is
     the `AutomationAgent` shape exactly: a sibling of the work streams
     under a workspace, named from a workspace-owned directory table,
     and a leaf of its own. The alternative — a second artifact list in
     `WorkstreamDO`'s SQL, so the work stream could name its own
     children — was rejected for being a duplicate of a fact
     `WorkspaceDO` already owns, which is the divergence that rule
     exists to prevent. The cost is a wider fan-out: a membership
     change wakes every artifact object in the workspace rather than
     one work stream's. That is the cost the walk already accepts and
     names — "a hop that finds nothing to close costs one call" — and
     the lists there are deliberately generous for the same reason.
     One thing `ArtifactHostDO` does *not* inherit: the four existing
     `revokeSocketAccess` implementations walk `state.getWebSockets()`,
     and an artifact host holds no sockets. It drops rows from
     `viewer_sessions` instead, under the same method name and the same
     child-naming contract, and returns no children. Choosing the queue
     for this hop rather than a direct RPC is recorded in
     [`choosing-queues-or-rpc.md`](../../choosing-queues-or-rpc.md),
     which owns that decision.
   - *Work-stream visibility is not a D1 fact* — it lives in the owning
     object's own SQL, and the same document rejects routing it through
     the queue. So the artifact host does not guess: it asks the
     authority that owns the scope. `ArtifactHostDO` resolves each
     viewer's continued visibility against its owning `WorkstreamDO`,
     which answers from its own SQL exactly as it does for a socket,
     and caches that answer for a bounded interval (an open limit)
     rather than per request, so a live artifact does not put a DO hop
     in front of every asset byte.

   The session's lifetime is
   **fixed from mint, never sliding** — and that shape, not just its
   number, is the artifact platform's sleep guarantee: nothing about an
   artifact executes without a viewer request (non-goal 6), so compute
   per open is bounded by rate ceiling × session lifetime, whatever a
   page's client code does. The lifetime is **24 hours** — a team-set
   value, not an author's guess: one re-open per day at most for a
   person actually working, and an abandoned-but-visible page burns at
   most a day of modest polling. The ceiling is **300 requests per
   minute per session** — also team-set: a poll page refreshing its
   tally every five seconds needs about twelve, so 300 leaves room for
   a page firing several parallel fetches per interaction without
   anyone meeting the guard by accident, and it caps a runaway loop at
   432,000 requests per viewer-session per day rather than at whatever
   a `setInterval` bug can emit. A well-behaved page goes
   quiet at expiry (the skill's polling rules stop on auth failure); a
   buggy or hostile one is bounded by that ceiling answering 429
   (non-goal 10). Re-minting is the desktop's
   seamless open flow when a person is actually there; the accepted
   casualty is a wall dashboard left up past expiry, which is a
   deliberate future exception if ever wanted, not a default. One cost
   is named rather than hidden: an expired session's stray requests
   still wake the DO just to be refused — bounded and accepted at this
   scale, and the standing open question on edge-verifiable session
   tokens is the future fix, since an expired signed cookie could be
   rejected at the Worker without a DO wake. Rejected: *capability
   URLs* ("anyone with the link") — they contradict the house rule that
   knowing an identifier grants nothing; *any access proof in a request
   URL*, single-use or not — Cloudflare records whole URLs into the
   invocation log, Logpush, and traces, and no redaction in this
   repository reaches them; *sliding renewal* — it reads as viewer
   convenience and quietly deletes the compute ceiling, since an
   abandoned-but-visible page would then poll forever.
7. **Publish identity is the file rule, unchanged, covering directories.**
   The artifact's identity is `(work stream, normalized path)` — the same
   frozen derivation `terminal_publish_resource` already applies to files,
   with the path now allowed to name a directory. Republish updates in
   place; equal-content republish (manifest hash) returns the artifact
   untouched, which also absorbs replays; version capture rides the same
   pointer-swap site the versioning layer already owns. What a path
   published *as* is recorded on the resource, not encoded in the
   identity — and a republish is never allowed to silently downgrade it
   (decision 9).
8. **Serving stays in-region end to end.** The two wildcard hosts are
   region-distinct (`*-g.…` to the Global Worker, `*-eu.…` to the EU
   Worker), so an EU artifact's bytes never transit a Global Worker and
   no cross-region bridge is added. Rejected: a single global router
   fanning out over RPC — it would move workspace content across the
   boundary that regionalization says has no path.
9. **No new tool: `terminal_publish_resource` widens to directories, and
   file layout is the whole contract.** The tool's input does not change
   by a single property; what a directory publishes as is decided by
   what the model wrote — root `index.js` → active site, else root
   `index.html` → static site, else a downloadable archive that Rally
   compresses server-side (the model never tars its own bundle; the
   sandbox holds no path to the bucket anyway). Rejected: *a dedicated
   `publish_site` tool* — a tenth family member whose path rules,
   identity derivation, and publish semantics would be identical to the
   ninth's, added only to carry two parameters this design deletes;
   *mode and server-module parameters* — a parameter restating what the
   files already say is a parameter that can disagree with them.
   Two consequences are accepted with eyes open. First, the archive
   fallback trades a sliver of fail-loud for totality: a model that
   meant a site but named its entry `app.js` gets an archive, not an
   error. That is *visibly* wrong rather than silently wrong — the
   result names the kind it published — and recovery is one rename and
   republish under the same identity, so the trade is taken. But the
   trade is narrowed where the mistake is most likely: before this
   widening, passing a directory where a file was meant was a hard
   error, and the models Rally routes to for cost — which under-read
   successful results — would otherwise convert that guardrail's most
   common firing into a success-shaped wrong outcome, a zip in the rail
   where the announced document should be, durable under its own
   identity. So a directory on the archive branch containing exactly
   one file is refused (`single_file_directory` below): a one-file zip
   is almost never a deliberate bundle, and it is near-exactly the
   mistaken-document shape. Genuine bundles stay total; the accepted
   residue is a document wrapped in a folder *with* auxiliary files,
   which is rarer, visible in the rail, and left to dogfooding to
   size. Second,
   kind changes across republishes of one path are asymmetric by rule:
   archive→site upgrades freely, but a republish that would turn a live
   site back into an archive fails loudly — a URL participants hold is
   never killed by an accident of file layout. The archive format is
   **zip**: Rally's ideal customer is nontechnical, and a zip
   double-clicks open on macOS and Windows with nothing to install or
   look up. The rejected alternative, tar.gz, is the engineer's default
   and the cheaper streaming write, and both advantages lose to the
   recipient not knowing what to do with the file.
10. **The rail preview is a main-process `WebContentsView`, never
    renderer DOM.** The right rail's live preview renders the artifact's
    HTTPS URL in an Electron `WebContentsView` created, owned, and
    positioned by the main process over the rail's preview region — the
    renderer never embeds, fetches, or parses artifact content, and the
    renderer's strict CSP (bundled content plus the regional API, nothing
    else) is untouched. Locked down, because each of these is a place an
    implementation would otherwise improvise:
    - *Who does what.* The renderer requests access from the regional API
      as it performs any authorized read, then asks the main process over
      validated IPC to present the artifact: artifact id, the access URL,
      and the preview region's window-relative bounds. The main process
      parses every argument as IPC rules require, verifies the URL is
      `https:` on the artifact serving domain before any load, clamps
      bounds to the window, and owns the view's lifecycle. The renderer
      can never navigate the view; it can only ask for an artifact.
    - *One view, fixed pane.* At most one live preview view exists per
      window, attached while a site resource's detail is showing and
      destroyed when the detail closes, the work stream changes, or the
      flag is off. The preview region is a fixed pane of the detail view
      rather than content that scrolls beneath other rail content, so
      bounds updates happen on layout changes only — a composited view
      that chases a scrolling rectangle jitters, and the fix is layout,
      not synchronization.
    - *Overlays hide the view.* A `WebContentsView` composites above the
      renderer's DOM, so any app surface that can overlap the rail —
      dialogs, the command palette, lightboxes, menus — triggers hide;
      the renderer reports overlay open/close over the same IPC and the
      detail shows a placeholder meanwhile. This is the classic embedded-
      view pitfall, and it is a rule here so no reviewer has to
      rediscover it.
    - *Same isolation contract as the artifact window, one
      implementation.* The view and the pop-out window share the
      creation path: no preload, no Node, sandbox on, a per-artifact
      session partition (which also carries the viewer cookie between
      rail and pop-out so the participant authorizes once), navigation
      locked to the artifact's origin, `window.open` denied with
      external links handed to the system browser, permission requests
      (camera, microphone, geolocation, notifications) denied, DevTools
      closed outside development.
    Rejected: *an `<iframe>` in the renderer* — it would widen the
    renderer CSP to a wildcard artifact host and graft remote,
    model-authored content into the application DOM as a navigable,
    `postMessage`-reachable child, the exact adjacency the backdrop
    rules exist to forbid; *the `<webview>` tag* — disabled by default
    and discouraged by Electron's own documentation; *a screenshot or
    server-rendered thumbnail* — a dead image of a live thing, which is
    the failure mode this PRD exists to end.
11. **The canonical URL is never version-addressed; prior versions render
    under the serving Worker's reserved namespace, read-only.** Version
    viewing reuses machinery this design already has: version bundles
    are immutable in the bucket, and loader isolate IDs are
    version-scoped (`artifact:<id>:v<n>`), so serving V3 is the same
    `get()` with an older ID. A prior version is addressed only under
    the serving Worker's reserved path namespace on the artifact's own
    origin (the namespace `/__rally/open` already establishes — the one
    prefix the server module never sees), which keeps one origin, one
    cookie, and one access flow per artifact, and keeps every
    participant-shareable address — the canonical URL, chips, embeds,
    copied links — pointing at current.

    **A prefixed mount has to be made invisible to the page, in both
    directions, or it silently serves the wrong version.** Two rules,
    because neither is free and both are easy to miss:
    - *Inbound, the serving Worker strips `/__rally/v<n>` before
      forwarding.* A frozen module routes on `url.pathname` and knows
      nothing of versions; handed `/__rally/v3/api/search` it would
      match no route and fall through to assets. It must see
      `/api/search`, exactly as it did when it was current — which is
      what "the one prefix the server module never sees" has to mean
      operationally, not just descriptively.
    - *Outbound, the page must not escape the mount.* A page's own
      client code written against root-absolute paths — the skill's
      worked example literally calls `fetch("/api/search?q=…")` —
      resolves `/api/search` against the origin, not the mount, so a
      read-only render of V3 would query **V4's** live handler. The
      prior-version mount is therefore served at a trailing slash with
      an injected `<base href="/__rally/v3/">`, and the skill's path
      rule widens from relative *assets* to relative *everything,
      including the page's own API calls*.
    - *And the mount is enforced, not merely encouraged.* `<base>` and
      relative paths fix well-behaved pages; they do not stop old code
      from reaching the live artifact deliberately or by accident, and
      an old page shares an origin — cookies, storage, service-worker
      scope — with the current one. So under a version mount the
      serving Worker refuses any request that escapes the prefix,
      refuses unsafe methods outright (a historical render has nothing
      to write), and refuses service-worker registration, whose scope
      would outlive the view and interpose on the canonical origin.
      "Read-only" then describes what the request path enforces rather
      than what frozen bytes are assumed to do — the same reasoning
      non-goal 13 applies to stateful artifacts, which are source-only
      because no request-path rule can make old code safe against a
      live schema. What renders depends on what the
    version was: a prior *static* version serves its frozen assets
    exactly, and a prior *stateless-active* version runs its frozen
    module over its frozen assets — nothing shared exists for old code
    to corrupt. A prior version of a *stateful* artifact opens as
    **source only** (non-goal 13): one facet runs one class, so serving
    old code live would abort the facet under current viewers, and old
    code against the live schema is undefined besides — looking at V3
    must never disturb the artifact everyone else is using. The desktop
    chrome labels the state (viewing V3, read-only, back to current),
    mirroring the versioning layer's prior-version contract. Rejected:
    *pinned version links* — a shared link that silently shows a stale
    site is the confusion this rule exists to prevent; *serving prior
    versions at distinct hostnames* — a second origin per version
    multiplies the access flow and mints a supervisor object per
    version, for no product gain.
12. **The data plane: one Rally host class inside the facet backs the
    rail, the export, and the agent tools — composed with the model's
    class, never subclassing it.** Rally assembles the dynamic worker's
    `modules` map, so the facet never loads the model's class directly:
    a Rally-authored bootstrap module imports `SiteData` and the facet
    runs a Rally-authored host class that **instantiates** it and holds
    it as a field, passing it the same `ctx`. Both objects address the
    same `ctx.storage` — the same database — while living on separate
    prototype chains, so the host answers supervisor RPCs the model's
    code never defined: a schema describe
    (tables, columns, row counts, sampled values), a read-only query
    that executes SQL **inside a transaction that always rolls back**
    (see below — the rollback is the last line, not the only one), a
    table page/CSV stream
    for the rail's Data view and export, and a database-size read for
    the storage quota.

    **The page and export paths need a dynamic table name, which the
    house SQL rule forbids by the obvious route.**
    [`durable-object-sqlite.md`](../../durable-object-sqlite.md) — which
    both implementer and reviewer must read for this change — is
    explicit that a parameter cannot bind an identifier and that any
    dynamic identifier comes from a closed, code-owned allowlist. Here
    the table names are the *model's*, so no code-owned allowlist can
    exist and the rule cannot be satisfied as written. What satisfies
    its intent instead: the allowlist is built at request time from the
    facet's own `sqlite_master`, the caller's table name is admitted
    only by exact match against that list, and the matched name is
    quoted as an identifier rather than interpolated. The list is the
    database's, not the caller's, so a name that is not a real table in
    this facet never reaches SQL — and this is written down because the
    naive implementation is a string template and it would pass review
    from anyone who had not read this paragraph. `query_artifact_data`
    is the one deliberate exception to "bind all values", since its
    whole contract is model-authored SQL; that is what the admission
    check below is for.

    That quota is **100 MB per artifact**, a
    team-set value — orders of magnitude above any legitimate V1
    artifact, small enough to contain a runaway writer — and it is
    honestly a **threshold, not a hard cap**: the model's class holds
    the native `ctx.storage` handle, so Rally observes size between
    requests rather than intercepting each write, and a single request
    can overshoot by whatever it manages to write before the next
    check. Crossing it refuses *further writes* loudly at serve time,
    never truncating and never blocking reads — the page keeps
    rendering what it already stored, and the rail says why writing
    stopped. Bounding the overshoot rather than the total is what the
    platform actually permits today; a genuine cap would mean taking
    the native handle away and mediating every write through Rally,
    which buys a smaller number at the cost of the whole reason facets
    were chosen. The workerd proofs therefore include a single
    threshold-crossing write and a constructor-time write, so the
    overshoot is measured rather than assumed. One
    read path, three consumers — the two agent tools, the Data view,
    and the export — so they can never disagree. The host class is the
    load-bearing mechanism of the whole stateful design and is proven
    on real workerd before anything rides it; the reference platform's
    workerd test pattern applies directly (a facet class carrying
    `ctx.props` is reachable only via `ctx.facets`, so tests reach it
    through a test-hooks DO).

    **Composition rather than subclassing is the load-bearing detail,
    not a style preference.** A Rally subclass of `SiteData` would put
    Rally's method names into the model's own namespace and win every
    collision: the model's `fetch`, running as inherited code on the
    same instance, would resolve `this.query(...)` to Rally's
    implementation with a different signature — and `query`, `describe`,
    `page`, `csv`, and `size` are precisely the names a model reaches
    for when it factors a SQL helper out of a handler. That failure is
    invisible at publish (decision 9 promises no publish-time code
    validation) and surfaces as a broken site at serve time in code
    that reads correctly. Composition removes the hazard outright:
    separate objects, separate prototype chains, no reserved names for
    the skill to teach and none for a model to trip over. Rejected:
    *querying the facet from the supervisor directly* — facet isolation
    is symmetric and forbids it, which is exactly why a host class
    inside the facet exists; *subclassing with namespaced method names*
    (`__rallyQuery`, …) — it works, but it keeps a shared namespace and
    a rule to remember for no benefit composition does not already
    give; *exposing the model's own class methods as the agent surface*
    (the reference platform's pattern, via its RPC-native gadget
    contract) — Rally's agent speaks typed tools, not arbitrary
    model-defined RPC, and SQL over a described schema is the contract
    that survives a hostile or clumsy class.
13. **Viewer identity rides every request as trusted headers.** Rally
    is multiplayer-native — every artifact request is already
    authenticated against a workspace member, and the workplace
    expectation is that a poll knows who voted, the way every message
    already carries its author. So the serving side injects
    `x-rally-viewer-id` and `x-rally-viewer-name` into **every** request it
    forwards to artifact code, all methods alike, immediately after the
    session check that established who the viewer is — and immediately
    after stripping any inbound headers of those names, which is the
    entire anti-spoof mechanism and is tested as such. Static assets
    ignore headers, so this is meaningful only to active artifacts. What
    it buys: attribution without seat-picking UI (your vote is yours
    because you cast it), duplicate prevention as an upsert on the
    member id, and an exact answer to "who hasn't voted?" — roster
    minus attributed voters — instead of fuzzy-matching self-typed
    names. What it costs, stated plainly: artifact code can now record
    *presence* — who opened the page and when — not only submissions.
    Two things keep that honest rather than covert: everything a
    stateful artifact records lands in the facet, where the rail's
    Data view and the query tools expose it to every participant
    (sunlight, structurally — there is nowhere hidden to put a log);
    and the skill's manners say to record identity only where the
    request calls for it. Rejected: *writes-only attribution*
    (anonymous reads) — considered at length, preserved the
    no-presence-logging property, and lost to the product judgement
    that a multiplayer workplace tool should behave like the rest of
    Rally, where being in the room is not anonymous; *identity as an
    opt-in per-artifact flag* — a per-page privacy toggle nontechnical
    users would have to reason about, and a parameter-shaped contract
    everywhere else in this design is layout-shaped.
    The contract is born guest-ready, because public sharing (non-goal
    2) is deferred, not rejected: **an anonymous viewer is represented
    by the absence of both headers**, so
    `request.headers.get("x-rally-viewer-id")` returns `null` — the real
    value, via the single most pretrained header idiom there is — and
    the natural falsy check a model writes today handles guests
    correctly the day they exist. In V1 the headers are always present
    (every viewer is an authenticated member); the declarations and the
    skill still teach the null branch now, so no artifact needs a
    retrofit later. Rejected: *a `"null"` sentinel string* — truthy, a
    footgun that passes every `if (viewerId)` check and leaks the
    literal word into data; *an empty-string value* — empty header
    values behave inconsistently across clients and runtimes, and the
    absent-vs-empty distinction is exactly the confusion absence alone
    avoids.

**Implementation notes from the reference platform.** Cloudflare OS
(`cloudflare/cloudflare-os`, read at `af56a9d`) runs this architecture
in production — every gadget is a dynamic worker whose class runs as a
facet of its workspace DO — and its code and agent docs carry gotchas
worth having before they are rediscovered:

- *Snapshot state synchronously with the loader cache key.* The
  `LOADER.get` callback runs asynchronously; any state the load depends
  on (the version pointer above all) is captured in the same
  synchronous step that computes the isolate ID, or a concurrent
  republish can flip it mid-load.
- *Facet stubs do not travel over RPC* — the supervisor forwards
  requests itself (decision 4 already adopts this as the routing rule).
- *Abort defensively.* `facets.abort` on a facet that is not running is
  a no-op, so the supervisor aborts whenever its in-memory tracking of
  what code the facet runs is cold — after hibernation, before serving
  a version it cannot confirm — rather than assuming.
- *Capture logs with a `tails` loopback.* The loader's `tails` option
  delivers the dynamic worker's console output and exceptions to a
  Rally entrypoint (`ctx.exports` with the artifact id in `props`) —
  the right feed for the error log, richer than catching thrown
  exceptions at the forward site alone.
- *`ctx.props`, not constructor arguments*, for anything a
  `WorkerEntrypoint` or facet class needs — stubs restore from `props`.
  Call `.dup()` before storing any stub received as an RPC parameter
  (Cap'n Web disposes call parameters on return), and declare every
  RPC parameter a receiver accepts even when unused — argument
  validation rejects undeclared ones.
- *Only Rally's own DO classes need Wrangler migration entries*; facet
  classes are dynamic and never appear there. The workerd test suite
  reaches a `ctx.props`-carrying facet class only through `ctx.facets`,
  so tests go through a test-hooks DO, per the reference's own test
  layout.

## Data model

Sketch level; the migration and [`data-model.md`](../../data-model.md) are
authoritative.

- `resources` gains the site kind: `resource_type = 'generated_site'`,
  provider `avalon_generated`, provider identity
  `terminal:<workstream-id>:<normalized-path>` — the same derivation file
  publishes use, unchanged; the row's resource type, not its identity,
  records what the path published as. A site resource's `content_ref`
  points at the version's manifest — not at any single page — so its
  MIME type is the manifest's:
  **`application/vnd.rally.site-manifest+json`** (the brand word is the
  team's decided call — a brand-new stored identifier carries the
  product's real name rather than joining the rebrand inventory's
  someday list; the type is stored forever). `text/html` would misroute the
  resource into single-document read paths and converters;
  `application/zip` would make sites indistinguishable from archive
  publishes, whose behavior is the opposite. The registry maps this
  exact type to the `site` attachment kind (see Agent behavior); the
  fail directions still justify the precision — an unrecognized precise
  type fails closed into `other`, a familiar wrong one fails open into
  a converter. A directory that publishes as an
  archive is an ordinary `generated_file` row holding the zip Rally
  produced, MIME `application/zip`. The existing slug, version-number,
  and lifecycle columns apply unchanged.
- A new `artifact_registry` table beside the resource authority in
  WorkspaceDO: `artifact_id` (an `ArtifactId`, and the artifact's
  hostname label — region-wide unique because it is a UUID, so this
  table needs no uniqueness machinery and is not an allocator),
  `resource_id`, `workstream_id`, `mode` (`static` | `active`, derived
  at publish from the directory's root entry), `current_version`,
  `manifest_ref`, timestamps. It is also what names the artifact
  children of the workspace's access-revocation hop (key design
  decision 6).
- Version history: the existing versioning layer's rows, unchanged — a
  site republish is one more pointer swap at the same capture site, with
  `storage_kind` naming the manifest-shaped reference.
- `ArtifactHostDO` (new DO class, both regions, jurisdiction-pinned):
  `artifact_state` (current version, resource linkage, whether a
  `SiteData` class is present), `viewer_sessions` (hashed session,
  principal, issued/expires, single-use code redemption, and the
  bounded-interval cache of that principal's last confirmed
  work-stream visibility — decision 6), `error_log` (bounded ring;
  retention an open limit). The supervisor's own tables never hold
  artifact data.
- The `"data"` facet (stateful artifacts only): the model's `SiteData`
  class under the Rally wrapper (decision 12), one isolated SQLite
  database per artifact with a model-designed schema. It rides the
  supervisor's Durable Object storage envelope — no separate namespace,
  no migration entry (facet classes are dynamic; only `ArtifactHostDO`
  itself appears in the Wrangler migrations) — and `facets.delete`
  removes it with the artifact.
- R2 `PAYLOADS`: `artifact/<artifact-id>/v<version>/assets/<path>` and
  `…/manifest.json`, immutable per version; deletion rides the existing
  cleanup outbox with the sweeper's version-liveness rule.

## Regional impact

Generation is Global-only at launch because the Terminal sandbox is
(non-goal 9). Serving deploys to both regions in configuration parity —
Worker, wildcard route, DO namespace, bucket prefix — with the EU half
staged and dormant, mirroring how the EU Daytona bindings are staged. An
artifact's assets, manifest, stored data (the facet's SQLite rides its
supervisor's storage), sessions, and error log all rest in
the workspace's region; the region-distinct wildcard hosts mean serving
never crosses the boundary; nothing new is added to the Global control
plane. EU inference remains unarchived, so prompt-policy tuning cohorts
stay Global, as with the document rollout.

## Security and trust model

The new trust surface is the point of this PRD, so it is stated in full.

- **Two sandboxes, not one — the server fence does not reach the
  page.** `globalOutbound: null` fences the *server module*; it says
  nothing about the HTML and JavaScript that module serves, which run
  in a browser with ordinary network access. Model-authored page code
  could otherwise `fetch` any host, load a remote script, beacon, open
  a WebSocket, or point a form off-origin — carrying whatever the page
  can see with it. So the serving Worker attaches a **platform-owned
  Content-Security-Policy to every artifact response**, static and
  active alike, which the artifact cannot relax (a page's own
  `<meta>` CSP can only further restrict, and a conflicting header
  loses to the stricter policy): `default-src 'self'`, `connect-src
  'self'`, `form-action 'self'`, `base-uri 'self'`, `object-src
  'none'`, `frame-ancestors 'none'`, `img-src 'self' data:`, and
  `script-src`/`style-src` of `'self' 'unsafe-inline'`. This is what
  actually makes the skill's "no network" and "carry your own assets"
  rules true rather than merely advisory, and it is why the skill
  forbids CDN links: under this policy they would not load anyway.

  **Two of those directives are written out rather than left to
  `default-src`, because inheriting it would break every page V1
  builds.** `'self'` does not permit inline code: with no `script-src`
  or `style-src` of their own, the inline `<script>` and `<style>`
  block the skill's worked examples teach would both be refused, and
  every artifact would fail on its first load. So `'unsafe-inline'` is
  named explicitly and deliberately — the threat this policy exists to
  stop is *egress*, not injection into a page whose author is already
  the model, and the egress directives (`connect-src`, `form-action`,
  `default-src`) are untouched by it. Per-response nonces are the
  tighter design and stay a deliberate follow-up; they mean rewriting
  model-authored HTML on the serving path, which is not worth doing for
  a threat that is not V1's. `img-src` likewise gains `data:`, since a
  model embedding a small inline image is ordinary and `'self'` alone
  would drop it silently.

  `frame-ancestors` is `'none'` rather than an allowlist of Rally
  surfaces, because key design decision 10 leaves nothing to allow: the
  rail preview is a top-level `WebContentsView` and the pop-out is a
  window, so no Rally origin ever frames an artifact. An allowlist here
  would be a standing invitation to reintroduce the `<iframe>` that
  decision rejects.
- **Artifact code is untrusted, and the server sandbox is
  capability-based.**
  `globalOutbound: null` — `fetch()` and `connect()` throw. The module's
  `env` contains exactly one injected entrypoint stub (`ASSETS`), whose
  `props` (artifact id, region) are set by the serving side and
  invisible to the module. A stateful artifact's class additionally
  holds the Durable Object storage API over *its own* facet database and
  nothing else — facet isolation is symmetric, so it can never read the
  supervisor's tables, another artifact's facet, or anything beyond its
  rows. No secret, Rally binding, D1, R2, queue, or provider
  credential is reachable; stubs cannot be forged, only received. CPU,
  memory, and isolate lifetime are the platform's own limits — platform
  numbers, not Rally's to restate; the facet database's size is Rally's
  one added guard, 100 MB per artifact (team-set), enforced between
  requests as a loud refusal of further writes — a threshold with
  bounded overshoot rather than a hard cap, for the reason decision 12
  states plainly.
- **Origin isolation, three ways — plus the same-site gap it does not
  close on its own.** Every artifact has its own origin on a domain that
  is not `rallywith.ai`; artifacts are therefore never same-origin with
  the application, the API, or each other (goal 7), so a hostile
  artifact cannot read another's storage, cookies, or DOM. The
  viewer-session cookie is per-artifact-origin and `HttpOnly`; it is
  stripped from the request before the request reaches the server
  module, so artifact code never sees a credential at all.

  What separate origins do **not** buy, because every artifact is a
  subdomain of one registrable domain: two artifacts are same-*site*.
  `SameSite` is a site-level control, so it does not stop script in
  artifact A from sending a **credentialed** request to artifact B —
  B's cookie rides along, and while CORS stops A reading the response,
  a simple `POST` needs no preflight, so B's model-written handler
  still runs and can still write to B's database. Cross-artifact CSRF
  is therefore a real attack this domain layout invites, and origin
  separation alone would leave it open.

  **The serving Worker closes it before untrusted code runs**, which is
  the only place it can be closed once, for every artifact, without
  trusting model-written handlers to defend themselves: every
  authenticated request is admitted only when its fetch metadata says
  it belongs to this artifact — `Sec-Fetch-Site: same-origin`, or
  `none` for a genuine top-level navigation — and an `Origin` header,
  when present, that matches the artifact's own origin exactly. A
  `same-site` or `cross-site` request is refused before it reaches the
  module, GETs included, because artifact code may treat any method as
  a write and nothing about a model-written handler makes it safe by
  method. Fetch metadata is unforgeable by page script (it is a
  browser-set forbidden header); a client that sends none, such as a
  non-browser caller, is treated as not same-origin and refused.
- **The desktop viewers extend the export-window pattern, visibly.** Both
  presentation surfaces — the rail's embedded `WebContentsView` and the
  pop-out artifact window — are main-process-owned web contents sharing
  one creation path: no preload, no Node, sandbox on, a per-artifact
  session partition, navigation locked to that artifact's origin —
  off-origin navigation and `window.open` denied, external links handed
  to the system browser — permission requests denied, DevTools closed
  outside development. This is the message-export window's isolation
  contract with visibility turned on, and it preserves the invariant that
  model-authored documents are never same-origin with the app. The
  renderer itself never embeds, fetches, or parses artifact content — the
  embedded view is composited by the main process over the rail, the
  renderer's CSP does not change, its IPC surface grows only the
  validated present/hide/bounds requests of key design decision 10, and
  the main process refuses to load anything but `https:` URLs on the
  artifact serving domain. The backdrop iframe rules are untouched.
- **The embedded view grants the artifact nothing the browser tab would
  not.** Artifact code cannot tell the rail preview from a browser: no
  `postMessage` channel to the application exists in either direction, no
  preload API is present, and the only identity in the partition is the
  artifact's own viewer cookie. A hostile artifact confined to the pane
  can draw whatever it likes inside its rectangle and nothing outside it;
  it cannot navigate the app, open windows, or reach another artifact's
  partition.
- **Authorization is current-visibility, at whichever authority owns
  the answer.** Open mints access against work-stream visibility now,
  and every artifact request is admitted by `ArtifactHostDO` against a
  live session. Staying admitted is the part that needs the two
  mechanisms of key design decision 6, because the host owns neither
  fact: membership and session revocation reach it through the existing
  access-revocation queue, and continued work-stream visibility is
  resolved against the owning `WorkstreamDO` on a bounded cache — never
  inferred from the session's own existence, which is precisely the
  regression `access-revocation.md` records. URLs grant nothing, and no
  access proof ever travels in one; codes are single-use, short-lived,
  and redeemed from a fragment through a request body.
- **The serving Worker is a new deployment surface with a minimal
  waistline.** It holds the loader, the bucket, the DO namespace, and
  nothing else — no D1, no provider secrets, no Flagship. A compromise of
  artifact code is contained by the isolate; a compromise of the serving
  Worker exposes artifact content and viewer sessions, not workspace
  authority.
- **Viewer identity enters artifact code as trusted headers, and
  nothing a page can send can forge them** (key design decision 13).
  Every forwarded request carries `x-rally-viewer-id` and
  `x-rally-viewer-name`, injected after the session check and after
  stripping inbound headers of those names — the strip is the security
  property and has its own test. The identity is workspace member
  identity (id and display name), never a credential: the viewer
  cookie is still stripped, and holding a member's name grants nothing
  anywhere else in Rally. The consequence is stated, not hidden: a
  stateful artifact can record who opened it, and everything it
  records is exposed to every participant through the Data view and
  the query tools — presence logging is possible but structurally
  incapable of being covert.
- **Artifact data is untrusted content with a trusted container.** The
  facet's rows were written by model code and page visitors, so their
  *contents* get the same untrusted handling connector payloads get —
  in the rail's Data view, in CSV exports, and in the agent tools'
  results. The *container* is Rally's: the host class's describe,
  query, page, and export methods are Rally-authored and, because the
  host **composes** the model's class rather than extending it
  (decision 12), a hostile `SiteData` cannot override or shadow any of
  them — it holds no reference to the host at all. The query path is
  structurally read-only (always-rollback transaction). What a hostile
  class *can* still do is write misleading rows, which no
  artifact-owned store could prevent and which is why contents are
  treated as untrusted; what it cannot do is reach beyond its facet,
  mutate anything through a read, or change what the host reports.
- **Nothing that protects data is scoped by the feature flag.** The flag
  below gates presentation; authorization is structural.

## Agent behavior

This PRD adds no plugin and no publish tool. It widens one existing
tool — `terminal_publish_resource` accepts a directory — extends
`terminal_import_resource` to materialize what that widening publishes,
extends the document-generation standing policy, and adds **one
two-tool read family** to the work-stream plugin for stateful
artifacts' data: `workstream_describe_artifact_data` and
`workstream_query_artifact_data`, both read-only. Everything below
lands in the [`agent-tools.md`](../../agent-tools.md) registries and
the plugin prompts in the implementing change; the house rule that a
*changed* tool carries the same registry, schema, and test burden as a
new one applies in full, and the two new tools carry it outright.

**Plugin contract (Terminal).** Same nine tools, same availability,
regions, origins, lease, and frozen authority; loading still starts
nothing. The plugin's activation message gains one short paragraph — the
kind conventions: a published directory with `index.js` at its root is a
live site with server behavior (`index.js` is an ES module
default-exporting `fetch(request, env)`, with `env.ASSETS` as declared —
the message carries the typed declarations verbatim); a site that must
remember between visits instead exports `class SiteData extends
DurableObject` from that `index.js`, whose `fetch(request)` serves the
page and whose storage (`this.ctx.storage.sql` / `storage.kv`) is the
site's own private database — when both shapes are present, `SiteData`
serves; with `index.html` and no `index.js`, a static live site; with
neither, a downloadable archive. The paragraph closes with the one
sentence aimed squarely at the smallest routed model: a document is
published by its file path, never by its folder.

**Tool contract — `publish_resource`, widened.**

- Everything declared today stands: name, capability, `mode: "write"`,
  `idempotency: "record_before_execute"`, serial execution, timeout,
  and the strict input `{ filePath: string, displayName?: string,
  description?: string }` with the family's path rules. The one widening
  is that `filePath` may now name a directory beneath
  `AVALON_RESOURCE_DIR`. No parameter is added: the publish kind is
  resolved from the directory's root entry per key design decision 9.
- Successful `output` becomes **a discriminated union on
  `resourceType`, and that is a contract change worth stating as one**
  rather than a shape that quietly varies. Today the tool has one
  output; after this widening it has three, and a model reading the
  registry must be able to tell which it got without guessing. Every
  member carries `resourceType`, `attachmentKind`, `resourceId`,
  `title`, `provider: "avalon_generated"`, and `createdAt`, so the
  discriminant and the identity are always in the same places:

  - *File* — `resourceType: "generated_file"`, unchanged
    byte-for-byte from today: `{ resourceId, title, resourceType,
    provider, mimeType, sizeBytes, sourceSha256, attachmentKind,
    contentMode, derivativeStatus, createdAt }`. No field is added,
    removed, or renamed; a caller that never publishes a directory
    cannot observe this change.
  - *Site* — `resourceType: "generated_site"`,
    `attachmentKind: "site"`, adding `{ slug, url, mode: "static" |
    "active", version, fileCount, totalBytes, manifestSha256 }` and
    carrying `mimeType` as the site-manifest vendor type the Data
    model fixes. `sizeBytes` is `totalBytes` and `sourceSha256` is
    `manifestSha256` — named for what they actually hash rather than
    reused, because a manifest hash is not a file hash and a caller
    comparing them would be wrong. `contentMode` and
    `derivativeStatus` are **absent**: a site has no single content
    body to read and no derivative to wait on. `url` and `slug`
    because the model's next step is citing the artifact; `version`
    because revision narration wants it.
  - *Archive* — `resourceType: "generated_file"`,
    `attachmentKind: "other"`: today's file shape exactly, over the
    zip Rally produced, plus `{ fileCount, totalBytes }` describing
    what was bundled. It shares its `resourceType` with the file
    member because it *is* a generated file; `fileCount` is what
    distinguishes it, and nothing downstream needs to.

  In every case the result names the kind it published, which is what
  makes the archive fallback recoverable at a glance. Persisted values
  on replay, per the family rule.
- Identity and replay: `(work stream, normalized path)` per key design
  decision 7, files and directories alike. Equal content (manifest hash
  for a directory) returns the existing resource untouched; a different
  hash updates in place and returns the same `resourceId` with the
  incremented `version`. `createdAt` stays the first publish's timestamp
  and is not a witness that this call's bytes landed — today's caveat,
  unchanged. Kind transitions across republishes of one path follow
  decision 9: archive→site upgrades freely; site→archive is refused.
- Failures: the family's existing vocabulary carries almost everything —
  `not_found` / `path_outside_root`, `resource_empty` (now also an empty
  directory), `limit_exceeded` / `resource_limit_exceeded` (reduce or
  split the bundle; the guard's value is an open limit),
  `resource_not_ready`, `tool_receipt_missing` and retryable provider
  failures (retry the exact call so the receipt reconciles). Two codes
  are added. `site_entry_removed` — "This path serves a live site and
  the republish has no `index.js` or `index.html` at its root. Restore
  an entry file, or publish the files under a different path."
  `single_file_directory` — "This directory holds one file and no site
  entry. Publish that file's own path to publish it as a document, or
  name it `index.html` to publish a static site; a directory publishes
  as a zip only when bundling multiple files." It fires only on the
  archive branch, so a lone `index.html` or `index.js` never trips it. No
  `missing_index` exists, because a missing entry on a multi-file
  directory is not an error; and no publish-time code validation is
  promised — `index.js` is executed at serve time, never at publish.
- Discovery and sequencing: the directory is discovered with the CLI the
  model already has (`ls`, `find`), and the revision loop stays
  list → import → edit → republish the same path. Nothing needs an id
  the family does not already return.

**Tool contract — `import_resource`, widened.** This is the other half
of the revision loop and a *changed* tool, so it carries the same
registry treatment as the publish side rather than a passing mention.

- Input is unchanged in shape — today's union of `{ resourceId }` and
  `{ resourceId, destinationPath, overwrite? }` — with the meanings
  widened where the resource is a directory-shaped one:
  - `destinationPath`, which today names a *file*, names the
    **directory root** to materialize into for a site resource. Omitted,
    the deterministic placement is a directory named for the resource's
    published path beneath the sandbox's resource-output directory —
    the same path a republish then targets, so import → edit →
    republish round-trips without the model choosing anything.
  - `overwrite` is **whole-tree replacement, never a merge**: with it,
    an existing destination tree is removed and replaced; without it, a
    non-empty destination is refused with `destination_exists`. Merging
    is the dangerous default this rules out — it leaves files a prior
    version deleted lying in the tree, and the next publish silently
    ships them back.
  - An archive resource materializes as the single zip file, as today's
    file behavior implies.
- `index.js` **is** materialized. It is "module, not asset" to the
  *serving* path (decision 3, so a viewer's `/index.js` 404s), but it
  is ordinary source to the sandbox — a model that could not see its
  own server could not revise it, and acceptance flow 13 walks exactly
  that path when a participant asks to see the source.
- Output names what landed, and **reuses `filePath` for the destination
  root rather than adding a key beside it**: a site import returns
  `{ resourceId, filePath, outcome, mimeType, sizeBytes, sourceSha256,
  fileCount }`, where `filePath` is the directory root the tree
  materialized into and is exactly the path a republish then passes to
  `terminal_publish_resource`. That is the whole reason not to
  introduce a `destinationRoot`: the round-trip is `filePath` in,
  `filePath` out, and a second name for the same value is a second
  thing a model can pick wrongly. `fileCount` is the one added field
  and is what marks the result as a tree. `mimeType` is the
  site-manifest type, `sizeBytes` the tree's total, `sourceSha256` the
  manifest hash — the same renaming discipline the publish side
  applies, in reverse. `outcome` stays the family's existing
  vocabulary (`created`, `replaced`, or deterministic `reused`); for a
  tree, `replaced` means the whole-tree replacement below, never a
  merge. A file or archive import is unchanged and returns no
  `fileCount`.
- Failures reuse the family's codes — `destination_exists`,
  `destination_not_regular`, `resource_not_ready`, `limit_exceeded` —
  with no new vocabulary for the directory case.

**Attachment rails and the site kind.** The join between "the artifact"
and "a resource in this work stream" is one token — the same
`resourceId`/`slug` flows through publish, listings, and import — and
the revision loop is the document loop the routed models already
practice. What must not be left undefined is the natural next call a
model makes after connecting them: a content read on the site resource.
The attachment registry therefore gains a ninth natural-language kind,
**`site`**, keyed on the manifest MIME type per the Data model — chosen
over `website` (heavier than the family's terse single-noun style) and
over `artifact` (internal jargon that collides with the rail's
**Artifacts** section, which holds documents too). Sites become
first-class in listings — "list the sites in this work stream" is an
ordinary kind filter — and the four content tools
(`workstream_read_resource`, `_view_`, `_search_`, `_summarize_`)
answer a site with the registry's bounded wrong-tool remediation
carrying `suggestedCall: terminal_import_resource` — "a site's source
is edited in the terminal workspace; import it there to read or revise
it" — so even the failure path teaches the connection instead of
dead-ending it. The registry change carries its full documented cost,
paid together in one change per the registry's own rules: the kind
enum in contracts, the kind explanation added to every list tool's
description, the classifier mapping and its tests, and the
structured-failure sanitizer — whose kind vocabulary widens to nine,
and whose `suggestedCall` allowlist grows by one member.

That allowlist is a four-member discriminated union today, not two:
`workstream_read_resource` and `workstream_view_resource` alongside
`automation_read_resource` and `automation_view_resource`, chosen at
throw time by the tool family's `modelToolPrefix`.

**Adding `terminal_import_resource` widens what a remediation is
allowed to suggest, and the widening is deliberate rather than an enum
bump.** All four members today are read-only, `resourceId`-shaped calls
a model can safely make blind; import materializes a directory tree on
the sandbox filesystem and accepts `overwrite`. What makes it
acceptable is that the suggestion carries `{ resourceId }` alone — the
create-only form, which refuses a non-empty destination with
`destination_exists` rather than replacing anything — so the suggested
call is destructive in neither its shape nor its default, and a model
that follows it blind cannot lose work. `overwrite` remains reachable
only when the model asks for it itself. The sanitizer validates the
member like any other, so a suggestion carrying `overwrite` is
rejected as an undeclared field rather than forwarded.

The remediation is
also **prefix-aware**, because the same failure fires from
automation-prefixed runs and the tool it names is a Terminal one:
- a `workstream`-prefixed run gets `suggestedCall:
  terminal_import_resource`, the redirect described above;
- an `automation`-prefixed run gets the same explanatory sentence with
  **no** `suggestedCall`. Automation runs do not hold Terminal — the
  site policy does not render for them at all — so naming a tool the
  run cannot call would trade one dead end for a worse one, and the
  sanitizer would drop an unrecognized entry anyway.

**Tool contract — the artifact-data read family, new.** Two tools on
the work-stream plugin (model-facing `workstream_describe_artifact_data`
and `workstream_query_artifact_data`), available wherever the
work-stream attachment tools are — deliberately *not* on the Terminal
plugin, because reading a poll's tally must not require a sandbox.
Both are backed by the facet wrapper of key design decision 12.

- `describe_artifact_data`: strict input `{ resource: string }` — a
  site resource's slug or id, resolved through the same visibility
  loader as every attachment tool, so nonexistent, foreign, and
  invisible ids collapse to `resource_not_found`. Output: the tables —
  name, columns with declared types, row count, and a few sampled
  values per column — plus the artifact's slug and mode. Discovery
  first, per the family rule: the run answering a data question may be
  post-compaction, a different run, or a smaller routed model that
  never saw the schema it is about to query. `mode: "read"`,
  `idempotency: "safe"`.
- `query_artifact_data`: strict input `{ resource: string, sql: string,
  params?: (string | number | null)[] }`. **Read-only is enforced on
  the statement, not by the transaction**, because an always-rollback
  transaction is not an authorization boundary: caller-supplied SQL
  can end or subvert the very transaction meant to contain it, and
  SQLite's exec surface accepts more than one statement at a time. So
  admission is positive rather than subtractive — the tool accepts
  **exactly one statement**, which must parse as a `SELECT` (a leading
  `WITH` whose body is a `SELECT` included), and rejects everything
  else outright: multiple statements, transaction control (`BEGIN`,
  `COMMIT`, `ROLLBACK`, `SAVEPOINT`), any DML or DDL, `PRAGMA`, and
  `ATTACH`. The rollback stays as the second line of defence, not the
  first, and where the platform offers a storage-level read-only
  authorizer that is preferred to parsing outright. Adversarial tests
  cover the escape shapes, not merely a bare `INSERT`: a statement
  sequence that commits mid-payload, a `PRAGMA`, and a CTE wrapping a
  write. Returns `{ columns, rows, rowCount, truncated }`, bounded
  by row and byte caps with a visible truncation marker (both caps and
  the query-time bound are open limits). `mode: "read"`,
  `idempotency: "safe"`. Failures, designed as loop repairs:
  `resource_not_found` (as above); `no_artifact_data` — "This site
  keeps no stored data; its content is its published files" — for
  static, stateless-active, and archive resources, with the
  `terminal_import_resource` suggestion when reading source was the
  likely intent; `sql_error`, carrying SQLite's own message plus
  "describe the data first, then rebuild the statement";
  `limit_exceeded` — narrow the query with `WHERE`, `LIMIT`, or fewer
  columns. Results are artifact data: untrusted content under the same
  handling as connector payloads, quoted as data, never followed as
  instructions.
- No write tool exists in this family (non-goal 12), and the two tools
  render only where the work-stream attachment tools already do.

**Standing-policy extension.** The document-generation policy gains the
site trigger and manners: a request whose natural output is a web page or
small application — explicitly named ("build a page/app/dashboard"), or
implied by interactivity a document cannot carry — becomes a directory
with its entry at `index.html`, adding `index.js` only when the behavior
needs request-time computation, and exporting the storage class only
when the request must remember between visits — a poll, sign-ups, a
list visitors add to — published with the ordinary publish tool; chat
narration stays short and code-free and the artifact is announced
with an embed citation. The policy also carries the one
disambiguation the reference platform's prompt learned to state
outright: people ask for *things* — a tracker, a page, a poll — and a
request for a new thing is a new artifact at a new path, even in a
work stream that already has one; only a request *about* an existing
artifact is a revision of it. When a participant later asks about
what the artifact collected, the policy steers the model to the data
read tools, never to guessing from the transcript. Participant overrides win in all directions ("just show me the
code" publishes files as ordinary resources; "make it a real page" builds
the site; "zip that up" publishes the directory as an archive). Same
render conditions as the document policy — ordinary participant-triggered
runs with Terminal available — and the same byte-budget discipline.

**The build craft ships as a loadable skill.** The guidance splits
across the three layers the harness already has, each carrying what it
is cheapest to carry: the *standing policy* holds the trigger and the
manners (above — always rendered, evaluated on every request); the
*plugin activation message* holds the mechanics (the kind conventions
and the typed `ASSETS` declaration — present whenever the tools are);
and the deep build craft — static-versus-active-versus-stateful
judgement, directory layout, the fetch-handler shape and asset-fallback
route pattern, the `SiteData` storage-class shape with its
additive-forever schema discipline, the statelessness rules and their
anti-patterns, the viewer-header attribution patterns (guest branch
included) and freshness-by-polling, narrow-pane-first UI,
data-as-files, the revise-in-place loop — ships as a new loadable
skill,
**`building-live-sites`** (`ownerPlugin: rally:terminal`, so it is
offered only where the Terminal plugin is in scope), loaded when the
model is about to write a site's files. That keeps hundreds of lines of
craft out of the every-request byte budget while making them available
at exactly the moment they matter, and it is the pattern Cloudflare's
own Dynamic Workers guidance models: teach the handler shape and the
bindings with typed declarations and one worked example. The complete
skill text — catalog line, body, worked-example resource — is authored
in [`site-authoring-skill.md`](site-authoring-skill.md) in this folder
and is normative for the implementing change, written to
[`writing-skills.md`](../../writing-skills.md)'s rules (behavior
nudges rather than wire tool names, medium-model bar at both the
routing and execution moments, byte-stable). Its stateful-sites
section — originally drafted as a deferred extension — installs in V1
with the rest of the body, since facet storage ships in V1; the draft
is revised in the same change to teach the `SiteData` contract exactly
as this PRD fixes it.

**Model-usability acceptance.** Schema snapshot and contract tests for the
widened tool's shapes, kind resolution, and failures, and for the two
data tools' shapes and failures, all walked through the
real sanitizer like the rest of their families; the skill covered at both of
its moments per the skill-authoring rules — the catalog line routes a
site-shaped request to `building-live-sites` (and a document-shaped one
away from it) on the routed models, and the body executes to a working
publish without frontier-level inference — including the
misnamed-entry path: an intended site published as an archive must be
recoverable from the result alone, by rename and republish, in one step.
The kind conventions are exercised on the routed models, not only the
frontier stage: on each model routing stage actually configured, a
document request must yield a file publish and never an archive, and a
`single_file_directory` refusal must be recovered in one corrected call
from its error sentence alone. This is the widening's one real
regression risk — the models Rally routes to for cost under-read
successful results, so the flows that used to be hard errors are the
ones to walk on them deliberately.
Prompt evaluation remains the document PRD's posture —
Rally has no evaluation suite, so acceptance is the manual flows below,
dogfooded on the models the route plan serves, and that gap is named
rather than papered over.

## Provider configuration

- Add the `rallyusercontent.com` zone (already owned) to the Cloudflare
  account, with one `*.rallyusercontent.com` wildcard route per region
  Worker, split on the label's `-g` / `-eu` suffix — recorded in
  `domain-migration.md` and the runbook in the implementing change.
- **No certificate purchase is required, and that is a design
  constraint rather than luck:** Universal SSL covers the apex and one
  subdomain level, which the flattened `<artifact-id>-<region>` form stays
  inside (key design decision 2). Should the team prefer the dotted
  `<artifact-id>.g.…` form, it is two levels deep and needs Advanced
  Certificate Manager or Total TLS — a recurring cost to approve
  *before* the dark deploy, since without it every artifact open fails
  the TLS handshake.
- No new provider apps, OAuth scopes, or third-party settings. The
  Worker Loader binding is account-level Cloudflare configuration on the
  two new Workers.

## Rollout

1. Infrastructure first, dark: the serving Workers, domain, DO class
   with its facet hosting and wrapper, the widened publish path, and
   the two data read tools deploy with the standing-policy module
   absent — directory publishing works but nothing steers to it, so
   dogfooding is by explicit ask. The wrapper's workerd proofs gate
   this deploy, not the flag flip: abort-and-reload on republish, facet
   deletion, the storage-threshold crossing and constructor-time write
   of decision 12 — and, first among them, **the read-only admission
   check of `query_artifact_data`**. That one is a gate rather than a
   test because it is the only place in this design where a security
   boundary rests on a mechanism nobody here has run yet: what
   `ctx.storage.sql.exec` actually accepts in a single call, and
   whether the platform offers a read-only authorizer at all, decides
   whether admission is a cheap platform flag or a statement parser
   Rally owns and must keep correct against SQLite's dialect. Answer it
   on real workerd before the parser becomes the answer by default.
2. `live-artifacts-enabled` ships as a client feature flag in the
   established fail-closed pattern — presentation-only, gating the rail's
   site-artifact detail (preview pane, Data view, Pop out, link, error
   log) and the artifact window;
   everything that protects data is structural, per the flag rules. The
   flag's default reproduces today's behavior: `false`.
3. The standing-policy module lands last, as its own deploy, once the
   serving path has survived explicit-ask dogfooding; its revert is the
   behavioral rollback, exactly as with documents.
4. The EU half deploys dark and stays that way: its Worker, wildcard
   route, DO namespace, and bucket prefix all exist, and they accept no
   artifact traffic until EU Terminal ships, because nothing can
   publish an EU artifact before then (non-goal 9). Completion of the
   EU Terminal workstream is what enables EU artifacts — no separate
   artifact-side flip is needed, and an operator reading only this
   section should not have to infer that from elsewhere.
5. Rollback layers: revert the policy (no new artifacts are steered);
   disable the flag (surfaces hide; URLs participants already hold keep
   working through their session checks); tear down the serving route
   (artifacts stop serving; resources and history remain).

**Migration and compatibility risks, stated plainly:**

- The wildcard route and the untrusted-content domain are firsts for this
  account; the runbook's origin rules were written before them and are
  updated, not silently excepted.
- The publish-identity derivation freezes at first real use, like the
  document rule it copies; get the normalization right before dogfooding
  writes history against it.
- An active artifact that worked can break on republish, and viewers see
  the error page until the next fix — accepted; the error log plus a chat
  ask is the V1 repair loop, and non-goal 8's tool shortens it later.
- EU parity is configuration, not capability, until EU Terminal lands —
  say so in any rollout comms, as the document PRD did.

## Acceptance

1. "Build a page that shows our launch checklist" yields file-writes and
   one directory publish, a site resource in the rail whose detail
   renders the page live in the preview pane, and a **Pop out** that
   opens the same artifact in the artifact window — with no code in chat
   and no code listing as the primary resource.
2. "Make a poll for the offsite date" yields a stateful artifact: two
   participants vote from different machines with no name field or
   seat picker anywhere — each vote is attributed from the trusted
   viewer headers, voting again *updates* that member's vote rather
   than duplicating it, and both viewers see the combined tally; the
   module's `fetch()` egress attempt (added in a test artifact)
   throws; a republish ("add a maybe option") keeps every vote already
   cast. "Build a searchable page of these signups" yields a
   *stateless* active artifact — no storage class, no Data view —
   because nothing needs remembering.
3. "Who hasn't voted yet?" in chat is answered through the data tools —
   a describe, then a read-only query joined against the participant
   roster the agent already has — exactly, by member id, with the
   numbers matching the page; the rail's Data view shows the same rows
   and exports them as CSV. A query tool call that attempts a write
   (`INSERT`, tested directly) changes nothing — the rollback guard
   holds on real workerd. A request sent with a forged
   `x-rally-viewer-id` header reaches the module carrying the *session's*
   identity, never the forged one — the inbound strip holds — and a
   test module built for the guest branch behaves correctly when the
   headers are absent.
4. "Change the header" from a *second* participant edits and republishes:
   same URL, same rail entry, version list grown by one, both viewers see
   the new header on reload.
5. A non-participant workspace member without work-stream visibility
   cannot open the artifact, its Data view, or its data through the
   read tools; the bare URL without minted access serves the neutral
   page. Revocation is proven on both of its paths, with a live session
   open in each case: a membership or session revocation reaches
   `ArtifactHostDO` through the access-revocation queue and its
   sessions stop working, and a participant who loses *work-stream
   visibility* — which that queue deliberately does not carry — loses
   artifact access within the visibility cache's bounded interval,
   proven against a real `WorkstreamDO` rather than a double. The
   fan-out itself is proven at the hop that names artifacts:
   `WorkspaceDO` returns one artifact child per row in
   `artifact_registry`, an artifact host that holds no sessions is a
   hop that closes nothing and returns no children, and the walk
   reaches artifacts in a workspace whose work streams have none.
6. The access code never appears in a request URL: the open flow
   redeems it from the fragment through a `POST` body, and an
   end-to-end capture of the artifact origin's requests contains no
   code. A credentialed request forged from a *second* artifact origin
   on the same site is refused by the serving Worker before the module
   runs — including a simple `POST` that needs no preflight, and
   including a `GET` — while the artifact's own same-origin requests
   and a genuine top-level navigation both succeed.
7. A server module that throws serves the plain error page and the
   error appears in the rail's error log.
8. Publishing a multi-file directory with neither root entry yields
   exactly one downloadable zip resource; renaming its entry to
   `index.js` and republishing the same path upgrades it to a live site
   under the same resource identity.
9. Publishing a one-file directory *that reaches the archive branch* —
   its single file being neither `index.html` nor `index.js` — is
   refused with `single_file_directory`, and the model recovers in one
   corrected call publishing the file's own path; a directory holding
   only `index.html` publishes as a static site and is never refused; on every configured model routing
   stage, a document request yields a file publish and never an archive.
10. Republishing a live site's path with its root entry removed fails
   loudly with the recovery instruction; the site keeps serving its
   current version.
11. Opening a dialog, the command palette, and a lightbox each hides the
   rail's preview behind its placeholder and restores it on close; the
   preview never paints over an app overlay. Voting in the poll inside
   the preview pane works, and the preview's navigation stays on the
   artifact's origin — an external link in the page opens the system
   browser, not the pane.
12. The platform goes back to sleep: a backgrounded tab (visibility
   hidden) makes no further requests until foregrounded; after the
   session's fixed lifetime expires, the page's loop stops on the
   first auth failure and shows its reopen state rather than
   retrying; a deliberately misbehaving test page polling past the
   rate ceiling receives `429`s; and with no requests arriving,
   nothing about the artifact executes at all.
13. A chip or embed citation in chat always opens the current version.
   From the version list, a prior static or stateless-active version
   renders read-only on direct request — its frozen module over its
   frozen assets — while a prior version of a stateful artifact opens
   as source only (non-goal 13); source is always readable through the
   versioning layer's preview, and the canonical URL serves the newest
   version throughout.
14. In a fresh run, "show me the site's source" leads through the
   registry's redirect — a content read on the site resource returns the
   `terminal_import_resource` suggestion, the import materializes the
   directory, and the files are read there — with no dead end on any
   configured routing stage. A browser request for `/index.js` on an
   active artifact returns 404.
15. Deleting a stateful artifact removes its facet database through the
   deletion lifecycle; a subsequent publish at the same path starts
   empty.
16. Where Terminal is unavailable, behavior is byte-identical to today;
   with the flag off, no artifact surfaces render — the preview pane
   and Data view included.
17. The Rally implementation brief carries the artifact-runtime clause
   this PRD proposes under **Impact on the product contract** — the
   amendment lands with the implementing change, not after it.
18. A page carrying an inline `<script>` and an inline `<style>` — the
   shape the skill's worked examples teach — renders and runs under the
   served CSP, while the same page's attempt to `fetch` an off-origin
   host, load a CDN script, and post a form off-origin are all refused
   by the policy rather than by the skill's advice. A `<meta>` CSP in
   model-authored markup cannot loosen any of it.
19. `docs/live-web-artifacts.md` exists to the module-document shape,
   is registered in the documentation index, and carries the changelog
   entry for this change; `domain-migration.md`, `agent-tools.md`,
   `security.md`, `access-revocation.md`, `feature-flags.md`, and
   `data-model.md` are updated in the same change as the code they
   describe.
20. `pnpm lint` (zero warnings), `pnpm typecheck`, `pnpm test`, and the
   workerd suite pass; every new test is shown to fail when its
   protected behavior is broken; the rail (preview and Data view),
   artifact window, and error surfaces are captured from a real window.

## Open questions

1. **Where viewer sessions should live on the spectrum between
   per-artifact DO checks and edge-verifiable tokens.** The DO check is
   the simple, revocation-honest V1; if artifact traffic ever makes the
   per-request DO hop matter — including the expired-session stray
   requests key design decision 6 accepts — a short-lived signed
   session with periodic re-check is the reversible optimization:
   decided then, on the platform's own failure signals, not now.
2. **Whether the artifact window wants a shared chrome** (address-less
   title bar naming the artifact and its work stream, a refresh action)
   — settle against real screenshots during implementation, per house
   practice.

Two earlier open questions were settled by the team and moved into the
body: the artifact serving domain is `rallyusercontent.com` (key design
decision 2) and the site-manifest MIME type's brand word is `rally`
(Data model).
