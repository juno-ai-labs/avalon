import { ARTIFACT_VIEWER_COLUMN } from "@rally/contracts";
import type { HarnessSkill } from "./index";

/**
 * How to build a live web site for Rally's artifact runtime.
 *
 * The standing policy carries the *trigger* — a site-shaped request becomes a
 * directory of files rather than markup in the chat — and stops there, because
 * it renders on every request and this is hundreds of lines. What is here is the
 * craft: which entry file decides the site's kind, why every path is relative,
 * the handler shape, the storage class a site that must remember exports, and
 * how a public-by-default site uses or requires trusted Rally viewer identity.
 *
 * `ownerPlugin` is the Terminal plugin, so the skill is offered only to runs
 * whose frozen scope includes it: the whole procedure ends in writing files in a
 * sandbox and publishing the directory, and is meaningless without one.
 *
 * Authored as TypeScript rather than a `SKILL.md` file for the same reason as
 * the rest of this package: it runs in `workerd`, which has no filesystem to
 * read one from at startup.
 */

const BUILDING_LIVE_SITES_BODY = `Build a directory of files that Rally serves at a stable URL. Load Terminal
for file editing, \`import_resource\` and \`publish_resource\`; loading this
skill does not activate those tools.

## Configure a Sidekick to refresh an existing site

Inspect the published site before saving the Sidekick. Save these facts in its
run instructions:

- **Resource ID:** The published site's Rally resource ID.
- **Owning thread:** The thread that originally published it.
- **Import destination:** Its directory relative to \`/workspace\`.
- **Publication path:** That directory relative to \`/workspace/.rally-output\`.
- **Data format:** File names, record layout, and field names and types.

Use a workstream-scoped Sidekick owned by the original thread. Personal and
Organization Sidekicks publish in their own conversations; importing files does
not redirect publication. If the original conversation cannot be used, report
that requirement instead of creating a replacement site.

Prefer attaching the site with the setup message using \`attachmentIds\` in
\`send_message\` or \`reply_to_message\`, even if the Sidekick can already read
it. Use \`sidekick_attach_resource({ sidekickId, resourceId })\` to add context
without a message. Confirm that the wizard can import it.

Load \`tracking-seen-or-done-items\` and save its shared-output claim procedure,
keyed by site resource ID. Each refresh must hold that claim through import,
editing, verification and publication; release it when the run finishes.

Save this sequence for each activation:

1. **Recover the current site.** Load Terminal and acquire the claim. Back up
   any existing site directory outside \`.rally-output\`, then import the
   published site into the original \`destinationPath\`, using \`overwrite: true\`
   if files exist. Local files may be stale. Try the known resource ID even if
   it is absent from resource lists; access depends on the execution user's
   permissions. If import fails, report the gap and stop instead of publishing
   an older copy.
2. **Prepare the update.** Inspect the imported code and data format. Carry forward
   only unfinished backup changes needed for the request. For structured source
   records, follow \`using-external-structured-data\` as described below.
3. **Compare.** Compare transformed source data with the imported data, ignoring
   synchronization timestamps. Do this on the first activation too; an empty
   tracking table does not prove the site is current. If they match, record the
   verified no-op, release the claim and finish with one line here, posting
   nothing. Otherwise update the
   necessary files in the site's expected format.
4. **Publish and verify.** Check the updated files, then publish the original
   path. Confirm successful publication of the same site before recording
   completion, release the claim and follow the saved reporting policy.

For example, import a site published at \`content-calendar\` into
\`.rally-output/content-calendar\` and republish \`content-calendar\`. If the
original destination is unknown, use the required path reported by the import
tool.

## Use structured data and report verified outcomes

For spreadsheet or other structured sources, load
\`using-external-structured-data\` for both initial builds and refreshes. Save
that skill name, the source and the field mapping in the Sidekick's instructions.

Report these outcomes separately:

- **Site published:** The publication tool returned success.
- **Sidekick activated:** You checked that the saved Sidekick is active.
- **Refresh succeeded:** A Sidekick run read the source, updated and checked
  the files, and confirmed publication. Setup alone does not establish this.

## Build and verify the site

For a request to create an app or tool, load \`creating-an-app\` first if you
have not, and settle its question before the first file.

1. **Decide the site's kind by what the request needs, and express it
   only in files.** There is no mode setting anywhere — the layout is
   the decision:
   - The page just shows things (content, layout, client-side
     interactivity)? Write **\`index.html\`** at the directory root and
     assets beside it. This is a **static** site and the default; do
     not add a server the page does not need. Static sites are always
     public.
   - The page needs **request-time computation** — server-side search
     or filtering over data you publish with it, a small JSON API the
     page calls? Also write **\`index.js\`** at the directory root. This
     makes the site **active**.
   - The request needs the site to **remember something between
     visits** — a poll, sign-ups, anything visitors add to? Export a
     **storage class** from \`index.js\` instead of a default handler —
     the **Stateful sites** section below is the whole shape. Never
     add storage speculatively: a page that only computes gets no
     database, and never publish a page that looks like it saves but
     does not.
   - If the user asks for a **protected, private, members-only, or
     work-stream-only** site, it must be active even when it would
     otherwise be static. Write \`index.js\` and reject every request
     without \`x-rally-viewer-id\` before routing or serving assets.

2. **Lay out one stable directory** beneath the workspace's resource
   output directory, named for the site (\`launch-checklist/\`, not
   \`output/\` or \`tmp/\`). Everything the page needs goes inside it:
   pages, styles, scripts, images, and data files. **Reference
   everything by relative path — assets *and* the page's own API
   routes** (\`fetch("api/search?q=…")\`, not \`fetch("/api/search?q=…")\`).
   A root-absolute path escapes the mount Rally serves a prior version
   under, so a page written with \`/api/…\` renders history but queries
   the current version's data. Publish every byte the page depends on — do not lean
   on external CDNs or fonts; a page that carries its own assets renders
   the same for every viewer, every time. Keep the entry names exact:
   \`index.html\`, and \`index.js\` only when the site is active — an entry
   under any other name (\`app.js\`, \`main.js\`, \`home.html\`) is not an
   entry, and the publish will not treat the directory as a site.
   Give shared links a useful preview: write a specific \`<title>\` and
   \`<meta name="description">\`, create a **1200×630** image named
   \`social-preview.png\`, and reference it with relative Open Graph and
   Twitter/X tags in \`<head>\` (\`og:title\`, \`og:description\`,
   \`og:image\`, and \`twitter:card\` with \`summary_large_image\`). Make
   the card readable at thumbnail size and about this site, not a generic
   Rally banner. Rally normalizes these tags to absolute URLs when serving
   and generates a branded fallback card if the image or metadata is
   missing, but authored metadata and artwork produce the best unfurl.
   Never create files beneath \`.rally/\` inside the site directory; Rally
   reserves that directory for derived site assets. On an active site, keep the taught final
   \`env.ASSETS.fetch(request)\` fallback: the generated preview image uses
   the ordinary asset route so Rally does not bypass your access guard.
   Include a short \`README.md\` in the directory saying what the site is
   and anything a future revision needs to know that the code does not
   show — the next run to touch this site may know nothing you know
   now. A new request for a new thing gets a **new directory**: "now
   make a countdown page" in a work stream that already has a poll is a
   second site at a second path, not an edit to the first — only a
   request *about* an existing site is a revision of it.

3. **If the site is active but keeps nothing, write \`index.js\` as one
   ES module default-exporting a fetch handler** (a site that must
   remember uses the storage-class shape in **Stateful sites**
   instead). The whole stateless server is:

   \`\`\`js
   export default {
     async fetch(request, env) {
       const url = new URL(request.url);
       if (url.pathname.startsWith("/api/")) {
         // your computed routes
         return Response.json({ /* … */ });
       }
       // everything else: serve the published files
       return env.ASSETS.fetch(request);
     },
   };
   \`\`\`

   Handle your computed routes first; end with the asset fallback so
   every other path serves the published files. \`env.ASSETS\` is the
   only binding you have, declared as:

   \`\`\`ts
   interface Env {
     /** Serves the published files of this site. Request paths are
      *  resolved against the published directory; "/" serves
      *  index.html. Returns 404 for paths that are not published
      *  files. */
     ASSETS: { fetch(request: Request | string): Promise<Response> };
   }
   \`\`\`

   **Sites are public by default.** Rally adds trusted viewer headers
   only when the request has a valid Rally viewer session; a direct
   public visit or crawler has neither header. Someone who is not signed in
   reaches your handler with no viewer headers, for reads and submissions
   alike; your code decides what they may do. If this site must be protected, put
   this guard at the very start of the handler, before
   API routing and before \`env.ASSETS.fetch\`, so it protects the HTML
   and every asset as well as computed routes:

   \`\`\`js
   const viewerId = request.headers.get("x-rally-viewer-id");
   if (!viewerId) {
     return new Response("Sign in to view this site.", {
       status: 401,
       headers: { "content-type": "text/plain; charset=utf-8" },
     });
   }
   \`\`\`

   A static site cannot perform this check. Do not call a site private
   because its URL is hard to guess, and do not build a login or accept
   an identity header from client JavaScript; only Rally injects these
   headers after validating its own session.

   **Signing in is Rally's.** When this guard answers 401 to someone
   loading a page, Rally sends them to sign in and back to the same
   page, so a protected site's link works for anyone who can see it.
   On a public site, link a visitor who wants to add something to
   sign-in, for example as "Sign in to vote". \`/__rally/\` is Rally's own
   route, and the one root-absolute path a page uses:
   \`"/__rally/sign-in?return=" + encodeURIComponent(location.pathname + location.search)\`.
   They come back signed in.

4. **Treat every request as the first request.** The runtime starts and
   stops instances whenever it likes; two requests may or may not share
   one. So: no module-level variables as state, no counters, no caches
   you expect to survive, no timers that outlive the response. Compute
   the response from the request and the published files, return it,
   and be done. If two viewers should see the same thing, it must come
   from the published files — which is another way of saying: data the
   page presents is a file in the directory.

5. **Ship data as files, read it through the asset binding.** Put the
   dataset beside the page — \`signups.json\`, \`metrics.csv\` — and in an
   active site read it server-side:

   \`\`\`js
   const data = await (await env.ASSETS.fetch("/signups.json")).json();
   \`\`\`

   Keep \`index.js\` free of large inline data: a data change should be a
   data-file edit, not a code edit.

6. **There is no network — design within the fence.**
   \`fetch()\` to anywhere outside the site throws; there is no way to
   call an external API or load a remote resource server-side. Do not
   write code paths that try. A request that genuinely needs outside
   data means you fetch it *yourself, now, in the workspace* and
   publish the result as a data file with the site. (An identified Rally
   viewer arrives as trusted headers — see **Stateful sites** item 7;
   a stateless site may read them too.)

7. **Design the page for where it actually lives.** The primary viewing
   surface is a pane beside the conversation, then a pop-out window, then
   a browser tab; the pane can be dragged as narrow as about 400 CSS
   pixels. Write the base stylesheet for a 400px-wide viewport and add
   \`min-width\` media queries for wider layouts, never the reverse: a
   desktop layout narrowed by \`max-width\` media queries is the one that
   breaks in the pane. The page's own UI carries every interaction: never
   \`alert()\`, \`confirm()\`, or \`prompt()\` (build inline messages and
   confirmations instead), and never a Print, Save, or Export button —
   saving and exporting are the platform's chrome, not the page's; keep
   layouts print-friendly with \`@media print\` so future platform export
   renders well.

8. **Look at it before you announce it.** From the workspace root (omit
   \`cwd\`), serve the directory and screenshot it at the pane's narrowest
   width and at desktop width, in one \`run_command\`. The server lives
   only inside this command and is stopped before it returns, which
   \`run_command\` allows:

   \`\`\`
   mkdir -p .rally/tmp && rm -f .rally/tmp/site-400.png .rally/tmp/site-1280.png
   python3 -m http.server 8765 --bind 127.0.0.1 --directory "$AVALON_RESOURCE_DIR/<site>" >/dev/null 2>&1 & server=$!
   sleep 1
   playwright screenshot --viewport-size "400, 900" http://127.0.0.1:8765/ .rally/tmp/site-400.png &&
   playwright screenshot --viewport-size "1280, 900" http://127.0.0.1:8765/ .rally/tmp/site-1280.png
   status=$?
   kill $server
   exit $status
   \`\`\`

   Call \`view_image\` on both PNGs. If either shows text clipped, running
   off the right edge, or one word per line, fix the CSS and run the
   command again; stop when neither does. An \`index.js\` handler does
   not run under this server: for a public active site, publish first
   and screenshot the \`url\` \`publish_resource\` returned instead. A
   protected site answers the sandbox with its 401 page, so check its
   layout with the local server and treat that as a layout check only.
   If the command fails (Playwright or its browser missing, or the url
   unreachable), do not install anything or retry: publish, and say in
   your reply that you could not check the layout.

9. **Let failures be loud and legible.** If the handler throws, viewers
   see a plain error page and the failure lands in the site's error log
   in the work stream — so throw early with a clear message rather than
   returning a half-rendered page. Validate your own routes' inputs and
   return real HTTP statuses (\`400\` with a short JSON body beats a
   \`200\` full of undefined).

10. **Revise in place, never fork.** Follow the recovery procedure above,
   edit the recovered files, and republish in the original conversation at the
   original path. Same URL, same rail entry, new version — viewers see it on
   their next load. Publishing a renamed or copied directory mints a second
   site and strands the existing URL. Keep chat narration short and free of
   the site's code, and announce a confirmed publication with an embed citation.

## Anti-patterns

- **State smuggled into module scope** (\`let hits = 0\` above the
  handler). It resets whenever the runtime feels like it and differs
  between instances. Do instead: derive everything from the request and
  the published files — and if it genuinely must be remembered, use the
  storage class from **Stateful sites**; module scope is never the
  place.
- **\`localStorage\` as shared state.** It is per-viewer, per-browser —
  fine for one person's UI preference, never for anything two viewers
  should both see. Do instead: shared content is a published file.
- **A misnamed entry.** \`app.js\` or \`main.html\` at the root publishes
  your directory as a downloadable archive, not a site. The publish
  result tells you what it made — read it; if it says archive where you
  meant site, rename to the exact entry name and republish the same
  path.
- **External \`<script src>\`, CDN CSS, or web fonts.** Not a style
  preference — Rally serves every page under a Content-Security-Policy
  that permits only this artifact's own origin, so an external script,
  stylesheet, font, or \`fetch\` is *refused by the browser*. The page
  renders without it, silently and wrongly. Do instead: vendor the file
  into the directory and reference it relatively. Inline \`<script>\` and
  \`<style>\` blocks are fine, as are \`data:\` images.
- **Hiding a grid item without removing its column.** \`display: none\`
  takes the element out of the grid but leaves its track, so the next
  item moves into it: a side rail hidden while the grid keeps
  \`grid-template-columns: 0 1fr\` puts the main content in the
  zero-width column, one word per line. Do instead: leave the rail out of
  the base grid and add its track in the same \`min-width\` rule that
  shows it (\`grid-template-columns: 64px 1fr\`). If you do hide a grid
  item, change \`grid-template-columns\` in that same rule, or place
  items with \`grid-column\`.
- **A server for a public static page.** An \`index.js\` that only ever
  falls through to \`env.ASSETS.fetch(request)\` is overhead with no
  behavior. Do instead: delete it; \`index.html\` alone serves faster
  and can never throw. Keep the server when its early viewer-header
  guard is what protects the page.
- **A page with no share identity.** A browser tab called "Untitled" and
  a generic generated card make a technically working but unhelpful shared
  link. Do instead: author the title, description, and 1200×630
  \`social-preview.png\` while the site's subject and visual language are in
  context; Rally's generated card is only the missing-data fallback.
- **Streaming the site into chat.** The transcript gets a sentence and
  a citation; the code lives in the files. If someone asks to see the
  code, publish the files as ordinary resources or read out the
  specific part they asked about.

## Stateful sites: the storage class

When the request's essence is remembering between visits — a poll, an
RSVP list, a sign-up sheet — the site keeps a private database.
Everything above remains true; a stateful site changes one thing: the
shape of \`index.js\`.

1. **Export the storage class; it is the whole server.** Instead of a
   default-exported handler, \`index.js\` exports exactly
   \`class SiteData extends DurableObject\` — the exact name matters —
   whose \`fetch(request)\` serves every request, with the same
   API-then-assets order (\`this.env.ASSETS\` inside the class). Rally
   runs the class against the site's own isolated SQLite database,
   which every viewer shares and every republish keeps. If a default
   handler is also exported, it is ignored — \`SiteData\` serves.

   \`\`\`js
   // The implementing change types this as
   // \`extends DurableObject<ArtifactEnv>\` so \`this.env\` is declared;
   // the example stays plain JavaScript.
   import { DurableObject } from "cloudflare:workers";

   export class SiteData extends DurableObject {
     constructor(ctx, env) {
       super(ctx, env);
       // Schema on first touch, idempotently — this runs on every
       // start, so guard with IF NOT EXISTS, never DROP.
       this.ctx.storage.sql.exec(
         \`CREATE TABLE IF NOT EXISTS rsvps (
            member_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            answer TEXT NOT NULL CHECK (answer IN ('yes','no','maybe')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          )\`,
       );
     }

     async fetch(request) {
       const url = new URL(request.url);
       const viewerId = request.headers.get("x-rally-viewer-id");
       if (url.pathname === "/api/rsvps" && request.method === "POST") {
         // Anonymous viewers can read but not RSVP.
         if (!viewerId)
           return Response.json({ error: "sign in to RSVP" }, { status: 401 });
         const name =
           decodeURIComponent(request.headers.get("x-rally-viewer-name") ?? "");
         // Validate before touching SQL: bad client input is a 400,
         // never an artifact-level failure.
         let body;
         try {
           body = await request.json();
         } catch {
           return Response.json({ error: "expected JSON" }, { status: 400 });
         }
         const answer = body?.answer;
         if (!["yes", "no", "maybe"].includes(answer)) {
           return Response.json(
             { error: "answer must be yes, no, or maybe" },
             { status: 400 },
           );
         }
         // One RSVP per person: answering again updates your answer.
         this.ctx.storage.sql.exec(
           \`INSERT INTO rsvps (member_id, name, answer)
              VALUES (?, ?, ?)
              ON CONFLICT (member_id) DO UPDATE
                SET answer = excluded.answer,
                    name = excluded.name,
                    updated_at = datetime('now')\`,
           viewerId, name, answer,
         );
         return Response.json({ ok: true });
       }
       if (url.pathname === "/api/rsvps") {
         const rows = this.ctx.storage.sql
           .exec("SELECT name, answer FROM rsvps ORDER BY updated_at")
           .toArray();
         return Response.json({ rsvps: rows });
       }
       return this.env.ASSETS.fetch(request);
     }
   }
   \`\`\`

2. **SQL is synchronous and local — use it plainly.** Queries run
   against the site's own SQLite in the same place the class runs: no
   \`await\` on \`sql.exec\`, no connection handling, no pooling. Simple
   \`kv\`-style storage (\`this.ctx.storage.kv.get/put\`) is there for a
   single counter or setting; use SQL the moment there is a second
   column.

3. **Schemas are additive, forever, and every step must be safe to run
   twice.** The database outlives every version of your code, the
   constructor runs on *every* start, and a later version's class starts
   against the tables an earlier version created. \`CREATE TABLE IF NOT
   EXISTS\` is safe to repeat. **\`ALTER TABLE … ADD COLUMN\` is not** —
   SQLite has no \`IF NOT EXISTS\` for it, so a bare ALTER in the
   constructor succeeds on the start that adds the column and throws
   \`duplicate column name\` on every start after, which takes the whole
   site down. Ask first:

   \`\`\`js
   const hasColumn = this.ctx.storage.sql
     .exec("SELECT COUNT(*) AS n FROM pragma_table_info('rsvps') WHERE name = 'note'")
     .one().n > 0;
   if (!hasColumn) {
     this.ctx.storage.sql.exec("ALTER TABLE rsvps ADD COLUMN note TEXT");
   }
   \`\`\`

   Never rename, drop, or rewrite a table in a revision. If a revision
   needs a new shape, add a new table and write to both until the old
   one is unused.

4. **Design the data to be read from outside.** The work stream's agent
   answers questions about this data with read-only SQL against your
   schema ("who hasn't voted?"), and participants see it in the rail's
   data view and exports. Clear table and column names in plain words
   are part of the site's interface, not private internals. Attribution
   comes from the viewer headers (item 7), never from guessing or from
   asking people to type their own names: store the viewer id and
   display name where the page's purpose needs to know who acted, and
   store neither where it does not.

   **A \`${ARTIFACT_VIEWER_COLUMN}\` column makes a table private.** Each row
   belongs to the person whose viewer id is in that column. In the data
   view, its exports and the agent's reads, members see only their own
   rows; the site's author and Sidekicks see all of them. Every other table is shared, whatever its
   columns are called, so an RSVP list keyed on \`member_id\` stays
   visible to the group. The column changes nothing about the SQL your
   class may run.

   **When each person should see only their own data** (a journal, a
   personal checklist, saved preferences), make the site protected (item
   3's guard), give every personal table a \`${ARTIFACT_VIEWER_COLUMN}\` column
   filled from \`x-rally-viewer-id\`, never from the request body, and
   filter every read the page serves by it. Rally scopes its own views
   of the data; the page's handler is what scopes the page. Beside the
   shared RSVP list in item 1, a private journal looks like this:

   \`\`\`js
   // In the constructor: one personal table, private by its column.
   this.ctx.storage.sql.exec(
     \`CREATE TABLE IF NOT EXISTS journal_entries (
        id INTEGER PRIMARY KEY,
        ${ARTIFACT_VIEWER_COLUMN} TEXT NOT NULL,
        body TEXT NOT NULL,
        written_at TEXT NOT NULL DEFAULT (datetime('now'))
      )\`,
   );

   // In fetch, after the all-routes guard; viewerId is the one it read.
   if (url.pathname === "/api/entries" && request.method === "POST") {
     const body = await request.json().then((json) => json?.body, () => null);
     if (typeof body !== "string" || body.trim() === "")
       return Response.json({ error: "body must be text" }, { status: 400 });
     this.ctx.storage.sql.exec(
       "INSERT INTO journal_entries (${ARTIFACT_VIEWER_COLUMN}, body) VALUES (?, ?)",
       viewerId, body,
     );
     return Response.json({ ok: true });
   }
   if (url.pathname === "/api/entries") {
     const entries = this.ctx.storage.sql
       .exec(
         \`SELECT id, body, written_at FROM journal_entries
           WHERE ${ARTIFACT_VIEWER_COLUMN} = ? ORDER BY written_at DESC\`,
         viewerId,
       )
       .toArray();
     return Response.json({ entries });
   }
   \`\`\`

5. **Old versions of a stateful site do not run.** When someone views
   a prior version, they see its *source*, not a live page — only the
   current version's code ever runs against the database. So never
   rely on an old version staying reachable as an application, and
   treat the current version's rendering of existing rows as part of
   every revision's job: after a schema addition, the page must still
   render the rows older code wrote.
6. **Storage is the truth; instance fields are at most a cache.** The
   class restarts whenever the runtime likes, so a field like
   \`this.subscriberCount\` silently resets. Write every fact that
   matters to \`this.ctx.storage\` the moment it exists, and treat any
   in-memory copy as rebuildable from storage on the next start.
7. **A Rally viewer is identified; a public visitor is anonymous.**
   Requests made through a valid Rally viewer session carry two trusted
   headers Rally injects and inbound callers cannot forge:
   \`x-rally-viewer-id\` (a stable member id) and
   \`x-rally-viewer-name\` (the display name, percent-encoded — decode
   with \`decodeURIComponent\`). A direct public visit or crawler has
   neither. For a public site, write the anonymous branch deliberately
   and decide what it may do — often read but not submit. For a
   protected site, use the early all-routes guard in item 3. Never
   build a login flow, a name field for attribution, or a seat picker:
   an RSVP from an identified viewer is attributed to whoever sent it,
   and one-vote-per-person is an upsert keyed on the viewer id. Record
   identity only where the request calls for it: an attendance sheet
   stores who came; a feedback box requested as anonymous stores no id
   even when Rally supplied one.
8. **Freshness comes from polling, not push — and every poll loop must
   know when to stop.** Nothing pushes updates into an open page;
   another viewer's vote appears when the page asks again. For
   shared-state pages, re-fetch the page's own API on a modest interval
   (a few seconds is plenty for a poll — this is a workplace tool, not
   a game engine) and after every submission. Three rules make the loop
   a good citizen, and all three are mandatory:
   - Poll only while visible: pause when \`visibilitychange\` reports
     hidden, and resume with an immediate fetch when it reports visible
     again. A backgrounded tab asks for nothing. (\`pagehide\` is a
     different signal — the page is being torn down or frozen, not
     paused — so if you listen for it at all, treat it as a final stop,
     never as half of the visibility pair.)
   - Stop permanently on an auth failure (401/403): the viewer's
     session has ended; show the "Sign in" link from item 3 of the
     build steps and make no further requests. Never retry past an auth failure.
   - Back off on transient errors with jitter rather than retrying at
     the same interval, and never poll faster because a request failed.
   The page may only fetch its own origin; there is nowhere else to
   poll — and the platform enforces a per-session request-rate ceiling,
   so a loop that ignores these rules gets \`429\` responses, not more
   freshness.

### Anti-patterns (stateful)

- **Treating the database as a cache for computed values.** It is the
  system of record and it is versioned by nothing — recompute derived
  values per request; store only what cannot be recomputed.
- **Destructive migrations in a revision** (\`DROP TABLE\`, \`DELETE FROM\`
  on start). Participants' submissions are the product; a revision that
  clears them is data loss, not a fresh start. Do instead: additive
  schema changes, and ask in chat before any deliberate reset.
- **Recording presence nobody asked for.** For an identified Rally viewer the
  headers tell you who is viewing, and everyone who can open the site sees
  every row of a shared table in the rail's data view (its author and
  Sidekicks see private rows too) — a page that quietly logs
  who opened it reads as surveillance the moment anyone looks. Do
  instead: record identity with *acts* (an RSVP, a vote, a sign-up),
  and record views only when the page's stated purpose is attendance.
- **Attribution theater on an anonymous page.** If the request was for
  anonymous answers, storing the viewer id with them breaks the promise
  in a way the data view exposes. Do instead: follow **Anonymous
  answers** below, and say in the page that responses are anonymous.

### Anonymous answers

For an anonymous poll, survey or feedback box, store the answers without
who sent them; how is up to you, and counts per choice are the simplest.

A request from someone who is not signed in reaches your handler with no
viewer headers, and your class can write it to its database like any other.
When the request opens answers to people outside Rally (the public,
customers, guests, anyone, the internet), accept those requests and tell the
person anyone with the link can answer. Otherwise return 401 when
\`x-rally-viewer-id\` is missing, with the sign-in link from item 3 of the
build steps; the answers still store no id.
`;

const WORKED_EXAMPLES = `Two complete, minimal examples the body's rules produce — read this
before your first site, not on every one.

**Static: a launch checklist page.** \`launch-checklist/index.html\`
(semantic markup, a \`<style>\` block or \`styles.css\` beside it,
checklist content in the page), nothing else. No \`index.js\` — the page
has no server behavior.

**Active: a searchable signups page.**

\`beta-signups/index.html\` — renders a search box and a results list;
its script calls \`api/search?q=…\` — relative, so it keeps working when
Rally serves this version read-only under a prefix — and renders the
JSON.

\`beta-signups/signups.json\` — the dataset, one array of records.

\`beta-signups/index.js\`:

\`\`\`js
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Route on the exact path. Rally strips any version prefix before
    // your handler sees the request, so this is the path you wrote.
    if (url.pathname === "/api/search") {
      const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
      if (q.length === 0) return Response.json({ results: [] });
      const rows = await (await env.ASSETS.fetch("/signups.json")).json();
      const results = rows.filter((r) =>
        [r.name, r.email, r.company].some(
          (f) => typeof f === "string" && f.toLowerCase().includes(q),
        ),
      );
      return Response.json({ results });
    }
    return env.ASSETS.fetch(request);
  },
};
\`\`\`

Everything the body teaches is visible here: exact entry names, the
API-then-assets route order, data as a file read through the binding,
no module-level state, real statuses, nothing external.
`;

export const BUILDING_LIVE_SITES_SKILL: HarnessSkill = {
  name: "building-live-sites",
  description:
    "How to build a public-by-default live web page or small app, or an active protected site: choose static, active, or stateful, write its handler or storage class against injected bindings, and revise it in place.",
  whenToUse:
    "When building or updating a page, dashboard, calculator, or small app someone will open, or configuring a Sidekick to refresh an existing site.",
  body: BUILDING_LIVE_SITES_BODY,
  ownerPlugin: "rally:terminal",
  resources: [{ path: "reference/worked-examples.md", body: WORKED_EXAMPLES }],
};
