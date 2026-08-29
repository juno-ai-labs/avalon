# Live web artifacts

> Created 2026-08-29.
>
> A work stream's participants can ask Rally for a working web page or small
> web application — a landing page, a dashboard, a calculator, a poll — and
> get a hosted, openable, revisable site rather than a code listing. The model
> builds the site in the Terminal sandbox and publishes it with the existing
> Terminal publish tool — widened to accept a directory, no new tool — and
> Rally serves it from an isolated per-artifact origin on Cloudflare's Worker
> Loader (Dynamic Workers), statically or with model-written server code as
> the request demands. Companion:
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
asset binding and a per-artifact storage binding Rally hands it. Because the
storage is shared, an active artifact is multiplayer for free: two
participants opening the same poll see and move the same tally. No
`index.js` but an `index.html` at the root publishes a **static** artifact —
assets only, served from the region's bucket. A directory with neither entry
publishes as one downloadable **archive** resource rather than failing, with
a single deliberate exception — a one-file directory is refused with
instructions, because it is almost always a mistaken document publish — so
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
   are shared state, `offsite-rsvp/index.js`.
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

**The model's choice of static versus active** is expressed in file layout,
never in a parameter: the policy steers it to write only assets (an
`index.html` root) when the page has no server behavior, and to add a root
`index.js` only when the request needs shared state, form handling, or an
API. A directory with neither — a folder of generated outputs, say —
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
interacting with the site inside it is interacting with the artifact, so a
poll can be answered without leaving the rail. **Pop out** opens the same
artifact in the dedicated artifact window when the rail is too small for
the site. **Copy link** copies the canonical artifact URL. **Open in
browser** mints a fresh access link and hands it to the system browser.
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

An **active** artifact behaves like a small shared application: every
authorized viewer's requests reach the same server module and the same
per-artifact storage, so the RSVP page's list is one list. A **static**
artifact is simply the current files.

**Revising.** "Make the header orange and add a maybe option" — from any
participant, at any time — leads the model to edit the files in the sandbox
(re-importing the current source from the published artifact first if the
sandbox was recycled) and publish the same directory again. Same artifact,
same URL, new version; the superseded version lands in the rail's version
list with agent provenance. From that list a prior version opens on direct
request — rendered read-only per the Viewing rules above, with its
*source* additionally readable through the versioning layer's existing
preview. Two participants asking
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
  recovery. A *one-file* directory is the exception — it is refused with
  the instruction to publish the file's own path, because that shape is
  almost always a document publish that grabbed the folder by mistake.
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
   paths, content types, hashes, the resolved mode — beside the assets;
   the serving Worker's asset binding resolves requests against the
   manifest, static-site conventions included (`/` → `/index.html`).
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
   nothing else.** The server module is the directory's root `index.js` —
   the loader's `mainModule`, under the single most conventional entry
   name in the training data — one ES module default-exporting
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
   region-distinct (`*.g.…` to the Global Worker, `*.eu.…` to the EU
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
    copied links — pointing at current. Two rules make old versions
    safe to render: a prior *static* version serves its frozen assets
    exactly; a prior *active* version runs its frozen module with
    `env.STORAGE` **read-only** — writes throw — because old code
    running against the live shared storage could corrupt what the
    current version depends on, and "looking at V3" must never mutate
    the artifact everyone else is using. The desktop chrome labels the
    state (viewing V3, read-only, back to current), mirroring the
    versioning layer's prior-version contract. Rejected: *pinned
    version links* — a shared link that silently shows a stale site is
    the confusion this rule exists to prevent; *serving prior versions
    at distinct hostnames* — a second origin per version multiplies the
    access flow and the label allocator for no product gain.

## Data model

Sketch level; the migration and [`data-model.md`](../../data-model.md) are
authoritative.

- `resources` gains the site kind: `resource_type = 'generated_site'`,
  provider `avalon_generated`, provider identity
  `terminal:<workstream-id>:<normalized-path>` — the same derivation file
  publishes use, unchanged; the row's resource type, not its identity,
  records what the path published as. A directory that publishes as an
  archive is an ordinary `generated_file` row holding the archive Rally
  produced. The existing slug, version-number, and lifecycle columns
  apply unchanged.
- A new `artifact_registry` table beside the resource authority in
  WorkspaceDO: `artifact_id`, `resource_id`, `workstream_id`, the
  allocated hostname `label` (unique, region-wide via the label
  allocator), `mode` (`static` | `active`, derived at publish from the
  directory's root entry), `current_version`, `manifest_ref`, timestamps.
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

This PRD adds no tool and no plugin. It widens one existing tool —
`terminal_publish_resource` accepts a directory — extends
`terminal_import_resource` to materialize what that widening publishes,
and extends the document-generation standing policy. Everything below
lands in the [`agent-tools.md`](../../agent-tools.md) Terminal registry
and the plugin prompt in the implementing change; the house rule that a
*changed* Terminal tool carries the same registry, schema, and test
burden as a new one applies in full.

**Plugin contract.** Unchanged: same nine tools, same availability,
regions, origins, lease, and frozen authority; loading still starts
nothing. The plugin's activation message gains one short paragraph — the
kind conventions: a published directory with `index.js` at its root is a
live site with server behavior (`index.js` is an ES module
default-exporting `fetch(request, env)`, with `env.ASSETS` and
`env.STORAGE` as declared; the message carries the typed declarations
verbatim); with `index.html` and no `index.js`, a static live site; with
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
- Successful `output`, by what the path resolved to: a *file* returns
  today's shape, byte-for-byte unchanged. A *site* directory returns
  `{ resourceId, slug, resourceType: "generated_site", url, mode:
  "static" | "active", version, fileCount, totalBytes, manifestSha256,
  createdAt }` — the URL and slug because the model's next step is
  citing the artifact; `version` because revision narration wants it. An
  *archive* directory returns the existing download-only archive shape
  (`resourceType: "generated_file"`, `attachmentKind: "other"`, the
  archive's mime type and size) plus `fileCount` and `totalBytes` for
  what was bundled. In every case the result names the kind it
  published, which is what makes the archive fallback recoverable at a
  glance. Persisted values on replay, per the family rule.
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
  `single_file_directory` — "This directory contains a single file.
  Publish the file's own path to publish it as a document; a directory
  publishes as a zip only when bundling multiple files." No
  `missing_index` exists, because a missing entry on a multi-file
  directory is not an error; and no publish-time code validation is
  promised — `index.js` is executed at serve time, never at publish.
- Discovery and sequencing: the directory is discovered with the CLI the
  model already has (`ls`, `find`). Revision after a sandbox recycle
  uses the existing recovery rail, widened to match:
  `terminal_import_resource` of a site resource materializes the
  published directory back into the sandbox (of an archive resource, the
  archive file), so the loop stays list → import → edit → republish the
  same path. Nothing needs an id the family does not already return.

**Standing-policy extension.** The document-generation policy gains the
site trigger and manners: a request whose natural output is a web page or
small application — explicitly named ("build a page/app/dashboard/poll"),
or implied by interactivity a document cannot carry — becomes a directory
with its entry at `index.html`, adding `index.js` only when the behavior
needs a server, published with the ordinary publish tool; chat narration
stays short and code-free and the artifact is announced with an embed
citation. Participant overrides win in all directions ("just show me the
code" publishes files as ordinary resources; "make it a real page" builds
the site; "zip that up" publishes the directory as an archive). Same
render conditions as the document policy — ordinary participant-triggered
runs with Terminal available — and the same byte-budget discipline; if
the module no longer fits the standing-policy ceiling, the escalation is
the skill path, decided at implementation.

**Model-usability acceptance.** Schema snapshot and contract tests for the
widened tool's shapes, kind resolution, and failures, walked through the
real sanitizer like the rest of the family — including the
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

- Register the new artifact serving domain (name the team's), with its
  two region wildcard hosts routed to the new serving Workers, in the
  Cloudflare account — recorded in `domain-migration.md` and the runbook
  in the implementing change.
- No new provider apps, OAuth scopes, or third-party settings. The
  Worker Loader binding is account-level Cloudflare configuration on the
  two new Workers.

## Rollout

1. Infrastructure first, dark: the serving Workers, domain, DO class,
   and the widened publish path deploy with the standing-policy module
   absent — directory publishing works but nothing steers to it, so
   dogfooding is by explicit ask.
2. `live-artifacts-enabled` ships as a client feature flag in the
   established fail-closed pattern — presentation-only, gating the rail's
   site-artifact detail (preview pane, Pop out, link, error log) and the
   artifact window;
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
   one directory publish, a site resource in the rail whose detail
   renders the page live in the preview pane, and a **Pop out** that
   opens the same artifact in the artifact window — with no code in chat
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
6. Publishing a multi-file directory with neither root entry yields
   exactly one downloadable zip resource; renaming its entry to
   `index.js` and republishing the same path upgrades it to a live site
   under the same resource identity.
7. Publishing a one-file directory is refused with
   `single_file_directory`, and the model recovers in one corrected call
   publishing the file's own path; on every configured model routing
   stage, a document request yields a file publish and never an archive.
8. Republishing a live site's path with its root entry removed fails
   loudly with the recovery instruction; the site keeps serving its
   current version.
9. Opening a dialog, the command palette, and a lightbox each hides the
   rail's preview behind its placeholder and restores it on close; the
   preview never paints over an app overlay. Answering the poll inside
   the preview pane works, and the preview's navigation stays on the
   artifact's origin — an external link in the page opens the system
   browser, not the pane.
10. A chip or embed citation in chat always opens the current version.
   From the version list, a prior version renders read-only on direct
   request — a write attempted by a prior active version's module
   throws, and the live artifact's storage is unchanged — with its
   source additionally readable through the versioning layer's preview;
   the canonical URL serves the newest version throughout.
11. Where Terminal is unavailable, behavior is byte-identical to today;
   with the flag off, no artifact surfaces render — the preview pane
   included.
12. `pnpm lint` (zero warnings), `pnpm typecheck`, `pnpm test`, and the
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
