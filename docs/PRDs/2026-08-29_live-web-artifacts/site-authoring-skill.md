# Skill draft: `building-live-sites`

> Part of [the live web artifacts PRD](prd.md); normative for the
> implementing change. This file is the complete authored draft of the
> loadable skill that teaches the model how to build a site for Rally's
> artifact runtime, written to [`writing-skills.md`](../../writing-skills.md)
> and cribbing its patterns from Cloudflare's Dynamic Workers and facet
> guidance (the fetch-handler shape, the assets-fallback route pattern,
> the storage-class shape, the typed-declaration teaching style). The
> whole skill — the **Stateful sites** section included — installs in
> V1, since facet storage ships in V1.

The V1 skill, as the implementing change installs it (authored in
TypeScript per the harness convention; this markdown is the content):

- **name**: `building-live-sites`
- **ownerPlugin**: `rally:terminal` — the procedure is meaningless
  without the Terminal workspace, so the skill is offered only to runs
  whose frozen scope includes it.
- **description**: "How to build a live web page or small web app as a
  published site: choose static, active, or stateful, lay out the
  directory, write the request handler or storage class against the
  injected bindings, and revise it in place."
- **whenToUse**: "When a request is site-shaped — a page, dashboard,
  calculator, or small app someone will open — and you are about to
  write its files, beyond what the standing guidance already covers."

## Body

You are building a **live site**: a directory of files that Rally will
serve at a stable URL to everyone in the work stream. The standing
guidance told you *when* to build one; this skill is *how* to build one
that works the first time.

1. **Decide the site's kind by what the request needs, and express it
   only in files.** There is no mode setting anywhere — the layout is
   the decision:
   - The page just shows things (content, layout, client-side
     interactivity)? Write **`index.html`** at the directory root and
     assets beside it. This is a **static** site and the default; do
     not add a server the page does not need.
   - The page needs **request-time computation** — server-side search
     or filtering over data you publish with it, a small JSON API the
     page calls? Also write **`index.js`** at the directory root. This
     makes the site **active**.
   - The request needs the site to **remember something between
     visits** — a poll, sign-ups, anything visitors add to? Export a
     **storage class** from `index.js` instead of a default handler —
     the **Stateful sites** section below is the whole shape. Never
     add storage speculatively: a page that only computes gets no
     database, and never publish a page that looks like it saves but
     does not.

2. **Lay out one stable directory** beneath the workspace's resource
   output directory, named for the site (`launch-checklist/`, not
   `output/` or `tmp/`). Everything the page needs goes inside it:
   pages, styles, scripts, images, and data files. **Reference
   everything by relative path — assets *and* the page's own API
   routes** (`fetch("api/search?q=…")`, not `fetch("/api/search?q=…")`).
   A root-absolute path escapes the mount Rally serves a prior version
   under, so a page written with `/api/…` renders history but queries
   the current version's data. Publish every byte the page depends on — do not lean
   on external CDNs or fonts; a page that carries its own assets renders
   the same for every viewer, every time. Keep the entry names exact:
   `index.html`, and `index.js` only when the site is active — an entry
   under any other name (`app.js`, `main.js`, `home.html`) is not an
   entry, and the publish will not treat the directory as a site.
   Include a short `README.md` in the directory saying what the site is
   and anything a future revision needs to know that the code does not
   show — the next run to touch this site may know nothing you know
   now. A new request for a new thing gets a **new directory**: "now
   make a countdown page" in a work stream that already has a poll is a
   second site at a second path, not an edit to the first — only a
   request *about* an existing site is a revision of it.

3. **If the site is active but keeps nothing, write `index.js` as one
   ES module default-exporting a fetch handler** (a site that must
   remember uses the storage-class shape in **Stateful sites**
   instead). The whole stateless server is:

   ```js
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
   ```

   Handle your computed routes first; end with the asset fallback so
   every other path serves the published files. `env.ASSETS` is the
   only binding you have, declared as:

   ```ts
   interface Env {
     /** Serves the published files of this site. Request paths are
      *  resolved against the published directory; "/" serves
      *  index.html. Returns 404 for paths that are not published
      *  files. */
     ASSETS: { fetch(request: Request | string): Promise<Response> };
   }
   ```

4. **Treat every request as the first request.** The runtime starts and
   stops instances whenever it likes; two requests may or may not share
   one. So: no module-level variables as state, no counters, no caches
   you expect to survive, no timers that outlive the response. Compute
   the response from the request and the published files, return it,
   and be done. If two viewers should see the same thing, it must come
   from the published files — which is another way of saying: data the
   page presents is a file in the directory.

5. **Ship data as files, read it through the asset binding.** Put the
   dataset beside the page — `signups.json`, `metrics.csv` — and in an
   active site read it server-side:

   ```js
   const data = await (await env.ASSETS.fetch("/signups.json")).json();
   ```

   Keep `index.js` free of large inline data: a data change should be a
   data-file edit, not a code edit.

6. **There is no network — design within the fence.**
   `fetch()` to anywhere outside the site throws; there is no way to
   call an external API or load a remote resource server-side. Do not
   write code paths that try. A request that genuinely needs outside
   data means you fetch it *yourself, now, in the workspace* and
   publish the result as a data file with the site. (Who is viewing
   arrives on every request as trusted headers — see **Stateful
   sites** item 7; a stateless site may read them too.)

7. **Design the page for where it actually lives.** The primary viewing
   surface is a narrow pane in Rally's right rail (roughly phone-width),
   then a pop-out window, then a browser tab — so build narrow-first
   responsive layouts that also breathe at desktop width. The page's
   own UI carries every interaction: never `alert()`, `confirm()`, or
   `prompt()` (build inline messages and confirmations instead), and
   never a Print, Save, or Export button — saving and exporting are the
   platform's chrome, not the page's; keep layouts print-friendly with
   `@media print` so future platform export renders well.
8. **Let failures be loud and legible.** If the handler throws, viewers
   see a plain error page and the failure lands in the site's error log
   in the work stream — so throw early with a clear message rather than
   returning a half-rendered page. Validate your own routes' inputs and
   return real HTTP statuses (`400` with a short JSON body beats a
   `200` full of undefined).

9. **Revise in place, never fork.** A change request means: edit the
   files in the workspace (re-import the site's source from the
   published resource first if the workspace no longer has it), then
   publish **the same directory path** again. Same URL, same rail
   entry, new version — viewers see it on their next load. Publishing
   a renamed or copied directory mints a second site and strands the
   URL people already have; do not do it. Keep chat narration short
   and free of the site's code, and announce the artifact with an
   embed citation.

## Anti-patterns

- **State smuggled into module scope** (`let hits = 0` above the
  handler). It resets whenever the runtime feels like it and differs
  between instances. Do instead: derive everything from the request and
  the published files — and if it genuinely must be remembered, use the
  storage class from **Stateful sites**; module scope is never the
  place.
- **`localStorage` as shared state.** It is per-viewer, per-browser —
  fine for one person's UI preference, never for anything two viewers
  should both see. Do instead: shared content is a published file.
- **A misnamed entry.** `app.js` or `main.html` at the root publishes
  your directory as a downloadable archive, not a site. The publish
  result tells you what it made — read it; if it says archive where you
  meant site, rename to the exact entry name and republish the same
  path.
- **External `<script src>`, CDN CSS, or web fonts.** A page that
  phones out renders differently per viewer and may not render at all.
  Do instead: vendor the file into the directory and reference it
  relatively.
- **A server for a static page.** An `index.js` that only ever falls
  through to `env.ASSETS.fetch(request)` is overhead with no behavior.
  Do instead: delete it; `index.html` alone serves faster and can never
  throw.
- **Streaming the site into chat.** The transcript gets a sentence and
  a citation; the code lives in the files. If someone asks to see the
  code, publish the files as ordinary resources or read out the
  specific part they asked about.

## Tier-3 resource: `reference/worked-examples.md`

Two complete, minimal examples the body's rules produce — read this
before your first site, not on every one.

**Static: a launch checklist page.** `launch-checklist/index.html`
(semantic markup, a `<style>` block or `styles.css` beside it,
checklist content in the page), nothing else. No `index.js` — the page
has no server behavior.

**Active: a searchable signups page.**

`beta-signups/index.html` — renders a search box and a results list;
its script calls `api/search?q=…` — relative, so it keeps working when
Rally serves this version read-only under a prefix — and renders the
JSON.

`beta-signups/signups.json` — the dataset, one array of records.

`beta-signups/index.js`:

```js
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Match the path's tail, not an absolute equality, so the same
    // handler works under a prior-version mount.
    if (url.pathname.endsWith("/api/search")) {
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
```

Everything the body teaches is visible here: exact entry names, the
API-then-assets route order, data as a file read through the binding,
no module-level state, real statuses, nothing external.

---

## Stateful sites: the storage class

When the request's essence is remembering between visits — a poll, an
RSVP list, a sign-up sheet — the site keeps a private database.
Everything above remains true; a stateful site changes one thing: the
shape of `index.js`.

1. **Export the storage class; it is the whole server.** Instead of a
   default-exported handler, `index.js` exports exactly
   `class SiteData extends DurableObject` — the exact name matters —
   whose `fetch(request)` serves every request, with the same
   API-then-assets order (`this.env.ASSETS` inside the class). Rally
   runs the class against the site's own isolated SQLite database,
   which every viewer shares and every republish keeps. If a default
   handler is also exported, it is ignored — `SiteData` serves.

   ```js
   // The implementing change types this as
   // `extends DurableObject<ArtifactEnv>` so `this.env` is declared;
   // the example stays plain JavaScript.
   import { DurableObject } from "cloudflare:workers";

   export class SiteData extends DurableObject {
     constructor(ctx, env) {
       super(ctx, env);
       // Schema on first touch, idempotently — this runs on every
       // start, so guard with IF NOT EXISTS, never DROP.
       this.ctx.storage.sql.exec(
         `CREATE TABLE IF NOT EXISTS rsvps (
            viewer_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            answer TEXT NOT NULL CHECK (answer IN ('yes','no','maybe')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          )`,
       );
     }

     async fetch(request) {
       const url = new URL(request.url);
       const viewerId = request.headers.get("Rally-Viewer-Id");
       if (url.pathname === "/api/rsvps" && request.method === "POST") {
         // Anonymous viewers can read but not RSVP.
         if (!viewerId)
           return Response.json({ error: "sign in to RSVP" }, { status: 401 });
         const name =
           decodeURIComponent(request.headers.get("Rally-Viewer-Name") ?? "");
         const { answer } = await request.json();
         // One RSVP per person: answering again updates your answer.
         this.ctx.storage.sql.exec(
           `INSERT INTO rsvps (viewer_id, name, answer)
              VALUES (?, ?, ?)
              ON CONFLICT (viewer_id) DO UPDATE
                SET answer = excluded.answer,
                    name = excluded.name,
                    updated_at = datetime('now')`,
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
   ```

2. **SQL is synchronous and local — use it plainly.** Queries run
   against the site's own SQLite in the same place the class runs: no
   `await` on `sql.exec`, no connection handling, no pooling. Simple
   `kv`-style storage (`this.ctx.storage.kv.get/put`) is there for a
   single counter or setting; use SQL the moment there is a second
   column.

3. **Schemas are additive, forever.** The database outlives every
   version of your code, and a later version's class starts against the
   tables an earlier version created. So: `CREATE TABLE IF NOT EXISTS`
   and `ALTER TABLE … ADD COLUMN` only; never rename, drop, or rewrite
   a table in a revision. If a revision needs a new shape, add a new
   table and write to both until the old one is unused.

4. **Design the data to be read from outside.** The work stream's agent
   answers questions about this data with read-only SQL against your
   schema ("who hasn't voted?"), and participants see it in the rail's
   data view and exports. Clear table and column names in plain words
   are part of the site's interface, not private internals. Attribution
   comes from the viewer headers (item 7), never from guessing or from
   asking people to type their own names: store the viewer id and
   display name where the page's purpose needs to know who acted, and
   store neither where it does not.

5. **Old versions of a stateful site do not run.** When someone views
   a prior version, they see its *source*, not a live page — only the
   current version's code ever runs against the database. So never
   rely on an old version staying reachable as an application, and
   treat the current version's rendering of existing rows as part of
   every revision's job: after a schema addition, the page must still
   render the rows older code wrote.
6. **Storage is the truth; instance fields are at most a cache.** The
   class restarts whenever the runtime likes, so a field like
   `this.subscriberCount` silently resets. Write every fact that
   matters to `this.ctx.storage` the moment it exists, and treat any
   in-memory copy as rebuildable from storage on the next start.
7. **The viewer arrives on every request — use it, and handle its
   absence.** Every request carries two trusted headers Rally injects
   and nothing can forge: `Rally-Viewer-Id` (a stable member id) and
   `Rally-Viewer-Name` (the display name, percent-encoded — decode
   with `decodeURIComponent`). So never build a login flow, a name
   field for attribution, or a seat picker: an RSVP is attributed to
   whoever sent it, one-vote-per-person is an upsert keyed on the
   viewer id, and lists show real display names for free. Always
   write the guest branch too: a missing header means an anonymous
   viewer (`request.headers.get("Rally-Viewer-Id")` returns `null` —
   today it never happens, but pages built now must not break the day
   guests exist), so check for `null` and decide what a guest may
   do — usually read but not submit. And record identity only where
   the request calls for it: an attendance sheet stores who came; a
   feedback box that was asked to be anonymous stores no id even
   though it has one.
8. **Freshness comes from polling, not push — and every poll loop must
   know when to stop.** Nothing pushes updates into an open page;
   another viewer's vote appears when the page asks again. For
   shared-state pages, re-fetch the page's own API on a modest interval
   (a few seconds is plenty for a poll — this is a workplace tool, not
   a game engine) and after every submission. Three rules make the loop
   a good citizen, and all three are mandatory:
   - Poll only while visible: pause when `visibilitychange` reports
     hidden, and resume with an immediate fetch when it reports visible
     again. A backgrounded tab asks for nothing. (`pagehide` is a
     different signal — the page is being torn down or frozen, not
     paused — so if you listen for it at all, treat it as a final stop,
     never as half of the visibility pair.)
   - Stop permanently on an auth failure (401/403): the viewer's
     session has ended; show the page's "reopen this from Rally" state
     and make no further requests. Never retry past an auth failure.
   - Back off on transient errors with jitter rather than retrying at
     the same interval, and never poll faster because a request failed.
   The page may only fetch its own origin; there is nowhere else to
   poll — and the platform enforces a per-session request-rate ceiling,
   so a loop that ignores these rules gets `429` responses, not more
   freshness.

### Anti-patterns (stateful)

- **Treating the database as a cache for computed values.** It is the
  system of record and it is versioned by nothing — recompute derived
  values per request; store only what cannot be recomputed.
- **Destructive migrations in a revision** (`DROP TABLE`, `DELETE FROM`
  on start). Participants' submissions are the product; a revision that
  clears them is data loss, not a fresh start. Do instead: additive
  schema changes, and ask in chat before any deliberate reset.
- **Recording presence nobody asked for.** The headers tell you who is
  viewing on every request, and everything you store is visible to the
  whole work stream in the rail's data view — a page that quietly logs
  who opened it reads as surveillance the moment anyone looks. Do
  instead: record identity with *acts* (an RSVP, a vote, a sign-up),
  and record views only when the page's stated purpose is attendance.
- **Attribution theater on an anonymous page.** If the request was for
  anonymous feedback, storing the viewer id anyway breaks the promise
  in a way the data view exposes. Do instead: ignore the headers
  entirely there, and say in the page that responses are anonymous.
