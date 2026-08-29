# Live web artifacts

> Created 2026-08-29.
>
> A work stream's participants can ask Rally for a working web page or small
> web application — a landing page, a dashboard, a calculator, a poll — and
> get a hosted, openable, revisable site rather than a code listing. The model
> builds the site in the Terminal sandbox, publishes it as a new kind of
> generated resource, and Rally serves it from an isolated per-artifact origin
> on Cloudflare's Worker Loader (Dynamic Workers), statically or with
> model-written server code as the request demands. Companion:
> [state](state.md). Siblings:
> [terminal artifact generation](../2026-08-27_terminal-artifact-generation/prd.md)
> (the document pipeline this extends),
> [resource versioning](../2026-08-27_resource-versioning/prd.md) (the history
> beneath republishes),
> [inline resource citations](../2026-08-27_inline-resource-citations/prd.md)
> (how the chat references what was built). Subsystem references:
> [Terminal work spaces](../../terminal-workspaces.md),
> [architecture](../../architecture.md), [security](../../security.md),
> [regionalization](../../regionalization.md),
> [domain migration](../../domain-migration.md). Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

Today a document-shaped request becomes a published Markdown resource. This
PRD gives the same treatment to a *site-shaped* request: "make a signup page
for the launch", "build a little dashboard over these numbers", "put up a
poll for the offsite date". The model writes the site's files in the work
stream's Terminal sandbox exactly as it writes a document, then publishes the
directory with one new tool. The publish creates a **live artifact**: a
generated resource of a new site kind that Rally also *serves*, at a stable
per-artifact HTTPS origin, to every participant who opens it.

The model chooses the artifact's nature per request. A page with no behavior
publishes as a **static** artifact — assets only, served from the region's
bucket. A page that needs server behavior — shared state, form handling, an
API the page calls — additionally names a **server module**, model-written
JavaScript that Rally executes per request as a Cloudflare Dynamic Worker
inside a capability-fenced sandbox: no network egress, no ambient bindings,
only an asset binding and a per-artifact storage binding Rally hands it.
Because the storage is shared, an active artifact is multiplayer for free:
two participants opening the same poll see and move the same tally.

Viewing and revising are both multiplayer in the way the work stream already
is. Every participant with visibility of the work stream can open the
artifact — in the desktop's isolated artifact window or in their browser —
and always sees the current version. Anyone can ask Rally to change it, in
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
   an active artifact's storage is shared across its viewers.
5. Any participant can revise the artifact by asking in the work stream;
   concurrent asks serialize through the run loop that already serializes
   the work stream's agent work.
6. Model-authored site content is never same-origin with the Rally
   application, with the regional API, or with any other artifact.
7. The serving surface is regional from day one: an artifact's bytes,
   storage, and execution stay in its workspace's region.

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
   Artifact hostnames are Rally-allocated labels on the artifact serving
   domain; naming is a product surface this change does not open.
5. **A general application platform.** Rejected. No build pipelines, no
   npm installs at serve time, no frameworks resolved server-side, no
   Python modules (the platform supports them; they are slow to start and
   nothing needs them), no per-artifact Cloudflare resources, no
   Workers-for-Platforms dispatch namespaces. One loader, one asset store,
   one storage binding.
6. **Background execution.** Rejected, and load-bearing for the product
   contract: artifact code runs only inside a viewer's request. No alarms,
   no cron, no timers that outlive a response, no artifact-initiated model
   calls. This is what keeps a live artifact on the right side of the
   contract's "no background service runtime".
7. **Push-based live reload and viewer presence.** Deferred. Viewers see a
   new version on next load; nothing pushes a refresh into an open
   artifact window, and nobody sees who else is viewing.
8. **Model-facing runtime log access.** Deferred. Server-module errors are
   captured (see Product behavior) and surfaced to people; a typed tool
   that lets the model read its artifact's logs is real and wanted, and it
   is a tool with its own contract, so it waits for the follow-up rather
   than riding this PRD half-specified.
9. **EU availability at launch.** Deferred with the same honesty as the
   document PRD: generation requires the Terminal sandbox, which is
   explicitly `unsupported` in the EU today. The serving surface deploys
   to both regions in parity (staged, like the EU Daytona bindings), and
   EU artifacts arrive with EU Terminal support, not before.
10. **Defensive numbers.** None are picked here. Bundle size, file count,
    per-request body size, storage quota, viewer-session lifetime, and
    error-log retention are all real guards this design names — each ships
    open under the open-limit rule, with the handover arithmetic, for the
    team to set.

## Product behavior

**Creation.** A participant asks for something site-shaped — "build us a
quick RSVP page for the offsite". The run, steered by an extension of the
document-generation standing policy:

1. Loads the Terminal plugin and writes the site as ordinary files in a
   stable directory beneath the sandbox's resource-output directory —
   `offsite-rsvp/index.html`, `offsite-rsvp/style.css`, and, because RSVPs
   are shared state, `offsite-rsvp/server.js`.
2. Publishes the directory with the new `terminal_publish_site` tool,
   naming the server module. The publish returns the artifact's URL.
3. Says, in chat, a short framing with an embed citation of the artifact —
   "The RSVP page is live in this work stream — open it and tell me what
   to change." — and none of the site's code.

Participants see the standard tool-activity rows (files written, site
published), then the message. The artifact appears in the right rail under
**Artifacts** as a site resource; its detail shows the URL, an **Open**
action, a **Copy link** action, and — via the versioning layer — the
version list.

**The model's choice of static versus active** is the model's, per request:
the policy steers it to publish assets alone when the page has no server
behavior, and to write a server module only when the request needs shared
state, form handling, or an API. A participant can override in either
direction in plain words, exactly as the document policy's overrides work.

**Viewing.** **Open** opens the artifact in the desktop's artifact window —
a dedicated, isolated window locked to that artifact's origin (see Security
and trust model). **Copy link** copies the canonical artifact URL. A
participant may also choose **Open in browser**, which mints a fresh access
link and hands it to the system browser. Either way the artifact always
serves its current version; a viewer who was reading V3 when V4 published
sees V4 on their next load. Opening the bare URL without Rally-minted
access shows a neutral page saying the artifact must be opened from Rally —
knowing a URL grants nothing, which is the house rule for every other
resource identifier and holds here.

An **active** artifact behaves like a small shared application: every
authorized viewer's requests reach the same server module and the same
per-artifact storage, so the RSVP page's list is one list. A **static**
artifact is simply the current files.

**Revising.** "Make the header orange and add a maybe option" — from any
participant, at any time — leads the model to edit the files in the sandbox
(re-importing the current source from the published artifact first if the
sandbox was recycled) and publish the same directory again. Same artifact,
same URL, new version; the superseded version lands in the rail's version
list with agent provenance, and a prior version's *source* opens read-only
through the versioning layer's existing preview. Two participants asking
for changes at once are serialized by the substream run loop as any two
asks are; the versioning layer records whichever landed second as the later
version, and nothing is lost.

**States and failure.**

- *Terminal unavailable* (EU, origin rules): the site guidance does not
  render; behavior is today's. Same asymmetry, and same honesty, as the
  document PRD.
- *Publish fails* (missing `index.html` for a static publish, server
  module outside the directory, size guard): the standard tool failure
  surfaces on its activity row with a recovery instruction, and the model
  repairs and retries per its ordinary loop.
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
participation; the publish is a typed, authorized, receipted tool write.

## Decision log

None yet.

## Key design decisions

1. **Worker Loader over every alternative serving mechanism.** The serving
   Worker holds a `worker_loaders` binding and materializes an artifact on
   demand with `LOADER.get(id, callback)`, per Cloudflare's Dynamic Workers
   API. Rejected alternatives: *static-only R2 serving* (kills active
   artifacts, the half that makes a poll a poll); *Workers for Platforms
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
   radius. Artifacts are served from per-artifact subdomains of a **new
   registrable domain reserved for untrusted content** (name is the team's
   to pick; the shape is `<label>.g.<artifact-domain>` and
   `<label>.eu.<artifact-domain>`, wildcard-routed per region). Rejected:
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
   paths, content types, hashes, the server module name — beside the
   assets; the serving Worker's asset binding resolves requests against
   the manifest, static-site conventions included (`/` → `/index.html`).
4. **One supervisor Durable Object per artifact.** A new
   jurisdiction-pinned `ArtifactHostDO` (one per artifact, addressed
   through the same stub helper every other DO uses) owns the artifact's
   serving-side truth: current version pointer, viewer-session issuance
   and checks, the per-artifact storage the `STORAGE` binding reads and
   writes, and the bounded error log. The serving Worker is stateless;
   the DO is the authority. Rejected: *Durable Object facets* (running
   the model's own DO class as a child with its own SQLite) — strictly
   more power than V1 needs, and a much larger trust surface; the
   storage-binding design below delivers shared state with the loader's
   plainest mechanism. Facets are the named upgrade path if artifacts
   outgrow key-value state.
5. **Active artifacts are a fetch handler plus two injected bindings,
   nothing else.** A server module is one ES module default-exporting
   `fetch(request, env)`. Its entire environment is injected by the
   loader per Cloudflare's bindings pattern (`ctx.exports` entrypoint
   stubs with per-artifact `props`): `env.ASSETS.fetch(request)` serving
   the artifact's own files, and `env.STORAGE` — `get`/`put`/`delete`/
   `list` over string keys and JSON values, backed by the artifact's
   `ArtifactHostDO`. `globalOutbound: null`. No secrets, no Rally
   bindings, no identity: requests reach the module with Rally's viewer
   cookie stripped, and nothing in the runtime discloses who is viewing.
   The tool's output and the plugin prompt carry the TypeScript
   declarations for these bindings, per Cloudflare's own advice that
   typed declarations are how an agent learns a binding.
6. **Viewer access is Rally-minted, short-lived, and checked at the
   artifact authority.** Opening an artifact calls the regional API
   (`POST /artifacts/:id/open`, authorized against current work-stream
   visibility), which returns a single-use, purpose-scoped access link to
   the artifact origin; the serving Worker redeems it with the
   `ArtifactHostDO` and sets an `HttpOnly` viewer-session cookie scoped
   to that one artifact origin, then serves. Requests re-check the
   session against current visibility. Rejected: *capability URLs*
   ("anyone with the link") — they contradict the house rule that knowing
   an identifier grants nothing; *long-lived tokens in URLs* — the ticket
   rule already keeps credentials out of URLs, and single-use redemption
   honors it. Session lifetime is an open limit.
7. **Publish identity follows the document rule, one level up.** The
   artifact's identity is `(work stream, normalized directory path)` —
   the directory-shaped twin of `terminal_publish_resource`'s frozen
   path-scoped identity. Republish updates in place; equal-content
   republish (manifest hash) returns the artifact untouched, which also
   absorbs replays; version capture rides the same pointer-swap site the
   versioning layer already owns. Like the file rule, the derivation
   freezes the moment real artifacts exist.
8. **Serving stays in-region end to end.** The two wildcard hosts are
   region-distinct (`*.g.…` to the Global Worker, `*.eu.…` to the EU
   Worker), so an EU artifact's bytes never transit a Global Worker and
   no cross-region bridge is added. Rejected: a single global router
   fanning out over RPC — it would move workspace content across the
   boundary that regionalization says has no path.

## Data model

Sketch level; the migration and [`data-model.md`](../../data-model.md) are
authoritative.

- `resources` gains the site kind: `resource_type = 'generated_site'`,
  provider `avalon_generated`, provider identity
  `terminal-site:<workstream-id>:<normalized-directory>`. The existing
  slug, version-number, and lifecycle columns apply unchanged.
- A new `artifact_registry` table beside the resource authority in
  WorkspaceDO: `artifact_id`, `resource_id`, `workstream_id`, the
  allocated hostname `label` (unique, region-wide via the label
  allocator), `mode` (`static` | `active`), `server_module` (nullable),
  `current_version`, `manifest_ref`, timestamps.
- Version history: the existing versioning layer's rows, unchanged — a
  site republish is one more pointer swap at the same capture site, with
  `storage_kind` naming the manifest-shaped reference.
- `ArtifactHostDO` (new DO class, both regions, jurisdiction-pinned):
  `artifact_state` (current version, resource linkage), `viewer_sessions`
  (hashed session, principal, issued/expires, single-use code redemption),
  `artifact_storage` (key, JSON value — the `STORAGE` binding's backing),
  `error_log` (bounded ring; retention an open limit).
- R2 `PAYLOADS`: `artifact/<artifact-id>/v<version>/assets/<path>` and
  `…/manifest.json`, immutable per version; deletion rides the existing
  cleanup outbox with the sweeper's version-liveness rule.

## Regional impact

Generation is Global-only at launch because the Terminal sandbox is
(non-goal 9). Serving deploys to both regions in configuration parity —
Worker, wildcard route, DO namespace, bucket prefix — with the EU half
staged and dormant, mirroring how the EU Daytona bindings are staged. An
artifact's assets, manifest, storage, sessions, and error log all rest in
the workspace's region; the region-distinct wildcard hosts mean serving
never crosses the boundary; nothing new is added to the Global control
plane. EU inference remains unarchived, so prompt-policy tuning cohorts
stay Global, as with the document rollout.

## Security and trust model

The new trust surface is the point of this PRD, so it is stated in full.

- **Artifact code is untrusted, and the sandbox is capability-based.**
  `globalOutbound: null` — `fetch()` and `connect()` throw. The module's
  `env` contains exactly the two injected entrypoint stubs, whose `props`
  (artifact id, region) are set by the serving Worker and invisible to
  the module. No secret, Rally binding, D1, R2, queue, or provider
  credential is reachable; stubs cannot be forged, only received. CPU,
  memory, and isolate lifetime are the platform's own limits — platform
  numbers, not Rally's to restate.
- **Origin isolation, three ways.** Every artifact has its own origin on
  a domain that is not `rallywith.ai`; artifacts are therefore never
  same-origin with the application, the API, or each other (goal 6), and
  a hostile artifact's scripts, storage, and cookies reach nothing but
  itself. The viewer-session cookie is per-artifact-origin and `HttpOnly`;
  it is stripped from the request before the request reaches the server
  module, so artifact code never sees a credential at all.
- **The desktop viewer extends the export-window pattern, visibly.** The
  artifact window is a dedicated window with no preload, no Node, sandbox
  on, its own session partition per artifact, and navigation locked to
  that artifact's origin — off-origin navigation and `window.open` are
  denied, with external links handed to the system browser. This is the
  message-export window's isolation contract with visibility turned on,
  and it preserves the invariant that model-authored documents are never
  same-origin with the app. The renderer itself never embeds artifact
  content; the backdrop iframe rules are untouched.
- **Authorization is current-visibility, at the authority.** Open mints
  access against work-stream visibility now; every artifact request
  re-checks the session at the `ArtifactHostDO`; revocation and
  visibility loss cut viewing without a new mechanism (the session check
  simply fails). URLs grant nothing; codes are single-use and short-lived.
- **The serving Worker is a new deployment surface with a minimal
  waistline.** It holds the loader, the bucket, the DO namespace, and
  nothing else — no D1, no provider secrets, no Flagship. A compromise of
  artifact code is contained by the isolate; a compromise of the serving
  Worker exposes artifact content and artifact storage, not workspace
  authority.
- **Viewer identity does not enter artifact code** (key design decision
  5). An active artifact can count and store what viewers *do*, not who
  they are. Passing identity in as a capability is a future, deliberate
  decision with its own review, not a default.
- **Nothing that protects data is scoped by the feature flag.** The flag
  below gates presentation; authorization is structural.

## Agent behavior

This PRD adds one tool to the Terminal plugin family and extends the
document-generation standing policy. Everything below lands in the
[`agent-tools.md`](../../agent-tools.md) Terminal registry and the plugin
prompt in the implementing change.

**Plugin contract.** No new plugin. `publish_site` joins the deferred
`rally:terminal` plugin's serial, single-workspace tool family
(model-facing `terminal_publish_site`), available exactly where the plugin
is available today — same regions, same origins, same lease, same frozen
authority. Loading still starts nothing. The plugin's activation message
gains one paragraph: site directories are written beneath the resource
output directory like documents; a static site needs an `index.html` at
the directory root; an active site names one server module inside the
directory, an ES module default-exporting `fetch(request, env)` with
`env.ASSETS` and `env.STORAGE` as declared (the message carries the typed
declarations verbatim).

**Tool contract.**

- Name: `publish_site`. Capability: the Terminal publish capability.
  `mode: "write"`, `idempotency: "record_before_execute"`, serial like
  the rest of the family. Timeout: the family's publish ceiling.
- Strict input (`additionalProperties: false`, strict zod parse in the
  executor): `{ directoryPath: string, displayName?: string,
  description?: string, serverModule?: string }`. `directoryPath` is
  relative to `AVALON_RESOURCE_DIR`, `/`-separated, rejecting absolute
  paths, backslash, NUL, and `..`, per the family's path rules.
  `serverModule` is a path relative to `directoryPath`, must name an
  existing `.js` file inside it, and its presence is what makes the
  artifact active — there is no separate mode parameter to drift out of
  agreement with reality.
- Successful `output`: `{ resourceId, slug, resourceType:
  "generated_site", url, mode: "static" | "active", version, fileCount,
  totalBytes, manifestSha256, createdAt }` — the URL and slug because the
  model's next step is citing the artifact; `version` because the next
  republish's activity narration wants it; persisted values on replay,
  per the family rule.
- Identity and replay: `(work stream, normalized directoryPath)` per key
  design decision 7. Equal manifest hash returns the existing artifact
  untouched; a different hash updates in place and returns the same
  `resourceId` with the incremented `version`. `createdAt` stays the
  first publish's timestamp and is not a witness that this call's bytes
  landed — same caveat as `publish_resource`.
- Failures, designed as loop repairs in the family's vocabulary:
  `not_found` / `path_outside_root` (inspect with `pwd`/`ls`, use one
  relative path); `directory_empty` and `missing_index` (a static site
  publishes a directory containing `index.html` at its root — create it,
  or name a server module); `server_module_invalid` (the server module
  must be a `.js` file inside the published directory — fix the path or
  extension; no code execution happens at publish, so deeper validation
  is deliberately not promised); `limit_exceeded` /
  `resource_limit_exceeded` (reduce or split the site; the bundle guard's
  value is an open limit); `resource_not_ready` (finish producers, then
  publish the stable directory); `tool_receipt_missing` and retryable
  provider failures (retry the exact call so the receipt reconciles).
- Discovery and sequencing: the directory is discovered with the CLI the
  model already has (`ls`, `find`); revision re-imports current source
  with the existing `terminal_import_resource` per file, edits, and
  republishes the same `directoryPath`; nothing needs an id the family
  does not already return.

**Standing-policy extension.** The document-generation policy gains the
site trigger and manners: a request whose natural output is a web page or
small application — explicitly named ("build a page/app/dashboard/poll"),
or implied by interactivity a document cannot carry — becomes files and a
`publish_site`, static unless the behavior needs a server, with chat
narration short and code-free and the artifact announced with an embed
citation; participant overrides win in both directions ("just show me the
code" publishes files as ordinary resources; "make it a real page" builds
the site). Same render conditions as the document policy — ordinary
participant-triggered runs with Terminal available — and the same
byte-budget discipline; if the module no longer fits the standing-policy
ceiling, the escalation is the skill path, decided at implementation.

**Model-usability acceptance.** Schema snapshot and contract tests for the
new tool's shapes and failures, walked through the real sanitizer like the
rest of the family; prompt evaluation remains the document PRD's posture —
Rally has no evaluation suite, so acceptance is the manual flows below,
dogfooded on the models the route plan serves, and that gap is named
rather than papered over.

## Provider configuration

- Register the new artifact serving domain (name the team's), with its
  two region wildcard hosts routed to the new serving Workers, in the
  Cloudflare account — recorded in `domain-migration.md` and the runbook
  in the implementing change.
- No new provider apps, OAuth scopes, or third-party settings. The
  Worker Loader binding is account-level Cloudflare configuration on the
  two new Workers.

## Rollout

1. Infrastructure first, dark: the serving Workers, domain, DO class,
   and publish path deploy with the standing-policy module absent — the
   tool exists but nothing steers to it, so dogfooding is by explicit
   ask.
2. `live-artifacts-enabled` ships as a client feature flag in the
   established fail-closed pattern — presentation-only, gating the rail's
   site-artifact detail (Open, link, error log) and the artifact window;
   everything that protects data is structural, per the flag rules. The
   flag's default reproduces today's behavior: `false`.
3. The standing-policy module lands last, as its own deploy, once the
   serving path has survived explicit-ask dogfooding; its revert is the
   behavioral rollback, exactly as with documents.
4. Rollback layers: revert the policy (no new artifacts are steered);
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
   a `publish_site`, a site resource in the rail, and an artifact that
   opens in the artifact window rendering the page — with no code in chat
   and no code listing as the primary resource.
2. "Make a poll for the offsite date" yields an active artifact; two
   different participants opening it vote and both see the combined
   tally; the module's `fetch()` egress attempt (added in a test
   artifact) throws.
3. "Change the header" from a *second* participant edits and republishes:
   same URL, same rail entry, version list grown by one, both viewers see
   the new header on reload.
4. A non-participant workspace member without work-stream visibility
   cannot open the artifact; a participant who loses visibility loses
   viewing on their next request; the bare URL without minted access
   serves the neutral page.
5. A server module that throws serves the plain error page and the
   error appears in the rail's error log.
6. Prior versions are listed and their source opens read-only through the
   versioning layer's preview.
7. Where Terminal is unavailable, behavior is byte-identical to today;
   with the flag off, no artifact surfaces render.
8. `pnpm lint` (zero warnings), `pnpm typecheck`, `pnpm test`, and the
   workerd suite pass; every new test shown to fail when its protected
   behavior is broken; the rail, artifact window, and error surfaces
   captured from a real window.

## Open questions

1. **The artifact domain's name.** The team's call, needed before the
   dark-infrastructure deploy; the only constraint from this PRD is that
   it is a separate registrable domain, not under `rallywith.ai`.
2. **Where viewer sessions should live on the spectrum between
   per-artifact DO checks and edge-verifiable tokens.** The DO check is
   the simple, revocation-honest V1; if artifact traffic ever makes the
   per-request DO hop matter, a short-lived signed session with periodic
   re-check is the reversible optimization — decided then, on the
   platform's own failure signals, not now.
3. **When active artifacts outgrow key-value storage.** Durable Object
   facets (the model's own DO class as a child with isolated SQLite) are
   the named upgrade path; the trigger would be a real artifact that
   cannot be built on `STORAGE`, and the decision is a new PRD against
   the facet trust surface.
4. **Whether the artifact window wants a shared chrome** (address-less
   title bar naming the artifact and its work stream, a refresh action)
   — settle against real screenshots during implementation, per house
   practice.
