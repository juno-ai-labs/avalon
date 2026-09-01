# Live web artifacts

A **live artifact** is a directory a work-stream run published that Rally also
*serves*, at a stable per-artifact HTTPS origin, to every participant who can see
the work stream. A landing page, a dashboard, a calculator, a poll: the model
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
| `apps/api/src/services/terminal/site-resource-bridge.ts` | Writing one version: assets and manifest into the bucket, the registry row, the supervisor's pointer. The order is the contract. |
| `apps/api/src/services/terminal/runtime.ts` | `inspectPublishTarget` (what a path is) and `publishDirectory` (reading the tree and dispatching). |
| `apps/api/src/durable-objects/artifact-host-do.ts` | One supervisor object per artifact: version pointer, viewer sessions, error log, and the facet that runs the model's storage class. |
| `apps/api/src/artifacts/index.ts` | The artifact serving Worker's entry point — a second Worker, its own origin, its own bindings. |
| `apps/api/src/artifacts/serving-policy.ts` | The three fences: the page CSP, the fetch-metadata admission, and the prior-version mount rules. |
| `apps/api/src/artifacts/read-only-sql.ts` | What a data query may run, and how a dynamic table name is admitted. |
| `apps/api/src/artifacts/facet-host.ts` | The Rally-authored module source loaded into a stateful artifact's facet beside the model's own. |
| `apps/api/src/artifacts/pages.ts` | The neutral page, the plain error page, and the fragment-to-cookie bootstrap. |
| `apps/api/wrangler.artifacts.{global,eu}.jsonc` | The serving Workers: wildcard route, cross-script DO binding, loader, bucket. |
| `apps/api/src/services/workstream-artifact-data-tools.ts` | The two read-only data tools' contract: what a model sees, and which sites are unreachable. No `Env` — its wiring is next door. |
| `apps/api/src/services/workstream-artifact-data-wiring.ts` | Resolving a reference through the standard visibility loader, and reaching the supervisor through the one supported resolver. |
| `packages/agent-harness/src/prompts/document-generation.ts` | The standing policy's `# Sites` section: the trigger and the manners, and nothing else. |
| `packages/agent-harness/src/building-live-sites-skill.ts` | The loadable skill that carries the build craft, scoped to the Terminal plugin. |
| `apps/api/src/services/artifact-open-service.ts` | The only door into an artifact origin: the open-time visibility check and the fragment-carrying URL it mints. |
| `apps/desktop/src/main/artifact-viewers.ts` | What the desktop will load into an artifact surface, the preview rectangle's clamp, the shared isolation contract, and the overlay rule. |

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

### Serving

The artifact serving Worker is a second entrypoint in `apps/api`, deployed as its
own Worker on its own origin. Given nothing but
`Host: <artifact-id>-<region>.rallyusercontent.com` it reaches the right
supervisor object with no lookup: **the artifact id is the hostname label**, so
the id is parsed out of the host and the object is named from it. There is no
index, no directory hop, and no per-request database read before the first byte —
the Worker holds no D1 at all.

Fences apply in this order, all before any model-authored code runs:

1. **Host** — not an artifact host, or the wrong region's, answers the neutral
   page.
2. **Fetch metadata** — the request must be same-origin, or a genuine top-level
   navigation. See [Invariants](#invariants).
3. **Viewer session** — the cookie is checked against `ArtifactHostDO`, which
   also confirms the viewer still sees the work stream.

Then `/__rally/*` paths are Rally's own (the access bootstrap, the redeem
endpoint, prior-version mounts) and everything else is artifact content: assets
resolved against the manifest for a static site, the loader for a stateless
active one, or the facet for a stateful one.

### Access

`POST /resources/:id/artifact/open` mints a single-use code against current
work-stream visibility — asked of `WorkstreamDO` rather than inferred, because
that fact lives in its own SQL. A resource that does not exist and one the
caller cannot see produce the same 404, so the endpoint is not an existence
oracle. **The code never travels in a request URL.** The desktop lands on
`/__rally/open#<code>`, where a Rally-served bootstrap page reads
`location.hash` — which a browser never sends to a server — clears it from the
address bar, and `POST`s the code in a request body. The redeem endpoint never
serves artifact content: it consumes the code, sets the cookie, and redirects, so
no artifact document is ever loaded at a location that held the code.

### Stateful artifacts

A site whose `index.js` exports `class SiteData extends DurableObject` gets its
own isolated SQLite database, run as a **Durable Object facet** of its supervisor.
Rally assembles the dynamic worker's `modules` map, so the facet never loads the
model's class directly: a Rally-authored module imports `SiteData` and runs a host
class that **instantiates it and holds it as a field**, passing the same `ctx`.
Both objects address one database while living on separate prototype chains, so
the host answers RPCs the model's code never defined — describe, query, page,
size — over the same rows the page reads and writes.

Requests to a stateful artifact route *through* the supervisor rather than being
served in the loader's own isolate. That is a platform constraint rather than a
preference: facet stubs cannot travel over RPC, so the object that owns the facet
is the only place that can forward into it.

## Invariants

- **Model-authored content is never same-origin with the application, the API, or
  another artifact.** Break it and a hostile artifact reads another's storage,
  cookies, or DOM. The origin is a per-artifact subdomain of a registrable domain
  that is not `rallywith.ai`.
- **Separate origins do not close cross-artifact CSRF, so the serving Worker
  does.** Every artifact is a subdomain of one registrable domain, so two
  artifacts are same-*site*: `SameSite` does not stop script in artifact A
  sending a credentialed request to artifact B, and a simple `POST` needs no
  preflight, so B's model-written handler would still run. Requests are admitted
  only when fetch metadata says `same-origin`, or `none` for a genuine top-level
  `GET`. **GETs are refused too** — artifact code may treat any method as a
  write, and nothing about a model-written handler makes it safe by method.
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
- **The renderer never embeds, fetches, or parses artifact content.** An
  `<iframe>` would widen the renderer's CSP to a wildcard artifact host and graft
  remote model-authored content into the application DOM as a navigable,
  `postMessage`-reachable child. The main process owns both viewing surfaces and
  composites the preview over the rail; the renderer can only *ask for an
  artifact*, and the URL it supplies is checked here against the serving domain
  on a label boundary before anything loads.
- **Everything the renderer measures is a request, not an instruction.** The
  preview rectangle is clamped to the window, because a wrong or hostile one
  would paint artifact content over the chrome a person needs to escape it. And
  a `WebContentsView` composites *above* the renderer's DOM, so any app surface
  that can overlap the rail — a dialog, the command palette, a lightbox — must
  collapse the view to nothing while it is open, or artifact content paints over
  it.
- **The asset manifest is the only index.** Nothing resolves a path the manifest
  does not name, which is what makes the server module's absence from `assets` a
  real 404 rather than a convention.
- **A version's bytes are immutable.** The loader caches an isolate by a
  version-scoped id, so publishing different content at a version already used
  serves the cached module. A republish always advances the version.
- **Assets, then manifest, then resource row, then pointer.** Each step depends
  only on ones that already committed, so a failure leaves the artifact serving
  its *previous* version rather than a version whose bytes a viewer cannot read.
- **A republish never downgrades a live site to an archive.** Archive→site
  upgrades freely — that is the archive fallback's own recovery — but the
  reverse fails loudly, because a URL participants hold is never killed by an
  accident of file layout.
- **`artifact_registry` is not a uniqueness authority and cannot be one.** It
  lives in a per-workspace database, so a `UNIQUE` there is unique per workspace
  and two workspaces could claim one host. Region-wide uniqueness comes from the
  artifact id being a UUID.
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

- **The loader binding is absent.** A static artifact still serves; an active one
  degrades to its assets, so its pages render and its routes 404. Visible partial
  failure rather than a dead origin.
- **The model's module throws.** The viewer gets a plain Rally page, never a
  stack trace. The error — message, stack, request path — lands in a bounded
  per-artifact log (50 entries) the rail shows, so a participant can paste it
  back into chat.
- **A viewer loses work-stream visibility.** Their next request is refused, and
  the session is not renewed. `VISIBILITY_CACHE_MS` bounds the staleness window
  and **ships at the open value of zero** — every request re-asks `WorkstreamDO`
  — because the window is how long a removed viewer keeps reading, which is the
  team's number to set rather than this code's to guess.
- **A prior version of a stateful artifact.** Source only, never live: one facet
  runs one class, so serving old code would abort the facet under current
  viewers, and old code against a live schema is undefined besides.
- **A prior version mount.** Unsafe methods and service-worker registration are
  refused at the request path rather than assumed harmless of frozen bytes; a
  service worker's scope would outlive the view and interpose on the canonical
  origin.
- **Numeric limits.** Viewer session lifetime is 24 hours, fixed from mint and
  never sliding — the shape, not just the number, is the sleep guarantee, since
  compute per open is bounded by rate ceiling × lifetime. The open code lives 60
  seconds. A publish carries at most 25,000,000 bytes, transcribed from the file
  path's existing bound rather than chosen. A data page returns at most 200 rows.

## Testing

| Suite | What it proves |
| --- | --- |
| `pnpm --filter @rally/api exec vitest run test/artifact-read-only-sql.test.ts` | The SQL admission, adversarially: statement sequences that commit mid-payload, CTEs wrapping writes, semicolons inside literals, writes behind comment markers, and identifier injection. |
| `pnpm --filter @rally/api exec vitest run test/artifact-serving-policy.test.ts` | The three fences: CSP directives, cross-artifact request admission including the credentialed simple `POST`, version-mount parsing, and asset resolution. |
| `pnpm --filter @rally/api exec vitest run test/terminal-site-publish.test.ts` | Kind resolution, the one-file refusal, the storage-class check, content types, the zip, and the asymmetric transition. |
| `pnpm --filter @rally/api exec vitest run test/terminal-runtime.test.ts` | Directory publish end to end through the runtime, against a simulated sandbox shell. |
| `pnpm --filter @rally/api exec vitest run test/artifact-open-service.test.ts` | Which authority answers which question at open time, that a refusal mints nothing, and that a missing artifact and an invisible one are indistinguishable. |
| `pnpm --filter @rally/desktop exec vitest run src/main/artifact-viewers.test.ts` | What the desktop will load, the rectangle clamp, the isolation contract, and the overlay collapse. |
| `pnpm --filter @rally/api exec vitest run test/workstream-artifact-data-tools.test.ts` | The data tools' contract and the site read-remediation, including its round trip through the real structured-failure sanitizer. |
| `pnpm --filter @rally/agent-harness exec vitest run` | The skill's shape and the standing policy's byte budget — the prompt bound is what keeps the policy six lines rather than nine. |
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
- `artifact_registry` (WorkspaceDO, migration 23): `artifact_id` (the hostname
  label), `workspace_id`, `workstream_id`, `resource_id`, `mode`, `stateful`,
  `current_version`, `manifest_ref`, timestamps.
- `ArtifactHostDO` (both regions, jurisdiction-pinned): `artifact_state` (one
  row), `viewer_sessions` (digests only — the cookie value is never stored), and
  `error_log` (a bounded ring).
- The `"data"` facet, for stateful artifacts: the model's schema, in a database
  that rides the supervisor's storage envelope. Facet classes are dynamic and
  never appear in Wrangler migrations; only `ArtifactHostDO` does.
- R2 `PAYLOADS`: `artifact/<id>/v<n>/assets/<path>` and `…/manifest.json`.

## Regional impact

Serving is region-distinct end to end. The two wildcard hosts route to their own
region's Worker (`*-g` and `*-eu`), so an EU artifact's bytes never transit a
Global Worker and no cross-region bridge is added. An artifact's assets,
manifest, stored data, sessions, and error log all rest in its workspace's
region. The EU half is deployed dark and accepts no traffic until EU Terminal
ships, because nothing can publish an EU artifact before then.

## Security and trust model

The trust surface is the point of this module, and
[`security.md`](security.md) owns the boundaries it sits on. In short: artifact
code is untrusted and capability-fenced (one injected binding, no network, no
secrets, no Rally bindings); artifact *data* is untrusted content with a trusted
container, since the rows were written by model code and page visitors while the
host class that reads them is Rally's and cannot be shadowed; and the serving
Worker's waistline is deliberately minimal, so a compromise of it exposes
artifact content and viewer sessions rather than workspace authority.

## Changelog

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

Four decisions a future change has to respect. **The artifact id is the hostname
label**, which is what lets the serving Worker reach the right object holding
nothing but a `Host` header; an earlier draft minted short labels from a regional
allocator and rejected "addressing by artifact id" along with the
hostname→id index it was actually arguing against — the id needs no index because
the host *is* the id, and a UUID is region-wide unique for free. **The host class
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

**Not yet built:** the renderer half of the desktop surfaces — the rail's site
resource detail, the region it reports for the preview, the Data view and its
CSV export, and the pop-out window's chrome. The main process's side of all of
them is here and tested, as are the API routes they call; what is missing is the
React that calls them. The `live-artifacts-enabled` flag exists and gates them;
nothing that protects data is scoped by it, so an artifact's authorization holds
with the flag off.
