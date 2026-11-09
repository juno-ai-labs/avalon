# Composer drafts

Every Rally composer keeps what the user has entered on the device until it is
sent or cleared. Closing a Canvas, walking to another screen, or quitting
Rally mid-sentence does not cost the sentence, and it does not cost the files that
were dropped next to it or confirmed artifact comments. Unconfirmed comment
selections remain transient.

The cache is device-local, best-effort, and short-lived: it is an IndexedDB
database in the renderer's origin, it forgets rather than fails, and everything in
it expires twelve hours after the last edit. Read this before changing a composer,
the attachment hook, or the cache itself.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/renderer/lib/draft-cache.ts` | The `rally-composer-drafts` IndexedDB database, its object stores, the epoch, and `pruneExpiredDrafts`. |
| `apps/desktop/src/common/draft-keys.ts` (re-exported by renderer `lib/draft-keys.ts`) | **Every** cache key string. The single source. |
| `apps/desktop/src/renderer/lib/use-draft-text.ts` | The text half: hydration, the debounce, the two commits, `releaseDraft`. |
| `apps/desktop/src/renderer/lib/use-file-attachments.ts` | The attachment half: restore, re-upload, the ten-file settle. |
| `apps/desktop/src/renderer/lib/app-session.tsx` | Watches the session and calls `clearAllDrafts` on a scope change. |
| `apps/desktop/src/renderer/components/workstream-composer.tsx`, `screens/conversation-surface.tsx` | The surfaces that cache: the composer of an existing conversation, a Canvas's Chat or a Sidekick's, keyed by the parent id. |

### Which surfaces cache a draft

These surfaces cache a draft, and they are the only ones that do:

| Surface | Component | Cache key |
| --- | --- | --- |
| A Sidekick's conversation | `ConversationSurface` through `WorkstreamComposer` | `workspace:<region>:<workspaceId>:workstream:<parentId>`, the parent being the Sidekick (storage: automation) |
| A Canvas's Chat | `ConversationSurface` with `parentKind: "canvas"` | `workspace:<region>:<workspaceId>:canvas:<canvasId>`, `canvasDraftKey`; its annotation scope is `canvas:<canvasId>`, which `annotationDraftKeyForScope` maps back for a detached artifact window |

`common/draft-keys.ts` is the single place those strings are built; `ConversationSurface` picks the family by parent kind through `conversationDraftKey` and `conversationAnnotationScope`, and a Sidekick's shared conversation stays in the work-stream family it has always used, so no released draft moves. A draft's text and
its attachments share one key, so the two halves of a composer can never drift
apart, and the launchers are scoped by regional workspace identity so switching
workspaces does not surface another workspace's words even if configured deployments hold
the same workspace UUID.

**New Sidekick** caches nothing: `/sidekicks/new` calls `POST /automations`
and replaces itself with `/sidekicks/:id`, so the first sentence is typed into
a conversation that already has its durable id. `draft-keys.ts` still builds
the `new-automation` keys and `draft-cache.ts` still migrates their legacy
spellings, because a released build may have rows under them; no screen writes
them now.

The same holds for the Channel composer and the Thread and Breakout screens,
which the client cutover deleted: only the Canvas and Sidekick families are
written. The `new-workstream` builder and the `:substream:` suffix in
`common/draft-keys.ts` stay, as does the legacy migration, so drafts already
stored under them expire on the ordinary schedule rather than being deleted on
upgrade.

### What is stored, and where

Drafts live in an IndexedDB database named `rally-composer-drafts` in the
renderer's origin, owned by `lib/draft-cache.ts` and opened through
`createIndexedDbStore` in `lib/indexeddb-store.ts`, the best-effort, epoch-fenced
store the local cache shares. It has three object stores:

- `text` — one row per key holding the drafted text and the mentions the user
  picked while writing it. **Writing empty text deletes the row**: a composer the
  user has cleared has no draft, and nothing comes back on the next visit.
- `annotations` — one row per confirmed comment, keyed by `[draftKey, id]`,
  containing its edit generation, original selection, resolved annotation, name,
  last user edit time, and optional crop/screenshot bytes.
- `attachments` — one row per pending file, keyed by `[draftKey, localId]`, holding
  the file's bytes as an `ArrayBuffer` plus its name, MIME type, modification time,
  content hash, and — once the upload finishes — the draft resource the API
  returned.

Bytes are stored as a buffer rather than a `Blob` because not every IndexedDB
implementation clones a `Blob` faithfully, and the composer rebuilds a `File` from
the buffer on restore anyway.

### Annotation lifecycle

`use-annotation-pins.ts` persists each confirmed comment independently and merges
restored records with edits already made during hydration. There is no whole-list
replacement write. Same-origin windows notify one another through BroadcastChannel;
local providers receive the same notifications directly. An unavailable cache
leaves the in-memory draft usable. Confirmations and edits write immediately.
Comment-only cross-window edits preserve the resolved target state, avoiding a
network check on each keystroke. Dirty and restored records retain their original
sort position. Detached transfers carry the captured edit generation and preserve
comments edited, removed, or sent while an image upload is in flight.

Annotations use the same conversation key as text.
Detached windows receive that key from main's registered window identity, filter
it to their own artifact, and preserve IDs through acknowledged transfers. They
share the draft rather than deleting it on transfer; the actual message receipt
clears it. Crop bytes use the same ArrayBuffer representation as file drafts and
are re-uploaded through the ordinary resource upload path after restoration.

Resolution does not refresh the last user edit time. A send captures comment IDs
and edit generations; acceptance conditionally deletes those generations, leaving
newer edits and unresolved comments intact. Workspace departure and sign-out clear
annotation rows too, notify mounted windows, and fence queued writes.

### Lifetime

A cached attachment names a **draft resource** that the API's reaper deletes 24
hours after upload (`DRAFT_ATTACHMENT_TTL_HOURS`). Local drafts therefore expire at
12 hours (`DRAFT_CACHE_TTL_MS`), comfortably inside that window, so a restored
attachment never points at a resource that has already been swept.

The clock runs from the last **edit**, not the last visit. Hydration deliberately
does not write back what it just read; otherwise opening a Canvas daily would
restamp its row forever and the draft would never expire.

Reads filter expired rows. The first composer mounted in an application run also
sweeps with `pruneExpiredDrafts`, which walks the attachment store's `updatedAt`
index rather than reading it whole — a live draft's file bytes are never
deserialized just to learn that the draft is not expired. The sweep hands back the
rows it deleted so the client can release their server-side draft resources, and it
only counts as done once it has a client to do that with; a composer that mounts
before the API is ready leaves the sweep for the next one.

Nothing else evicts. The TTL is the bound: the cache holds at most the attachments
added in the last twelve hours, across every composer visited in that window.

Switching workspaces preserves both scopes. `AppSessionProvider` clears every
draft only when the account leaves the device — deliberate sign-out, main
surrendering its final credential, or another account taking over. Leaving one
workspace calls `clearWorkspaceDrafts` after the server commits departure and
removes only keys under that workspace prefix. A role change is not a scope
change: being promoted does not cost anyone their unsent message. The first
session of a run is an arrival rather than a departure, so launching Rally keeps
what the last run left behind.

A wipe has to beat work that was already in flight when it started — a debounced
save, a file still being fingerprinted, an upload about to record its resource — or
a draft typed seconds before sign-out lands behind the clear and survives on a
signed-out device. Ordering alone does not settle that, so the cache carries an
**epoch**: `clearAllDrafts` moves it on, every write states the epoch its content
was captured in, and a write from an earlier one is dropped. A composer opened
after the wipe reads the new epoch and writes normally, so nothing has to be reset
by hand.

### How a draft is restored

`useDraftText(draftKey)` owns the text half. On mount — and whenever the key
changes — it resets, reads the cached row, and applies it **unless the user has
already typed**, which they own outright however late the read lands. Saves are
debounced by 250 ms and flushed when the composer unmounts or switches keys, so
quitting mid-word still commits the word — including a word typed *before* the read
landed, which the debounce never held because saving stands down until hydration.
That one is written by its own unmount-only commit; without it, a composer opened,
typed into, and left inside the read window lost the sentence.

A key change is a *copy* unless something removes the original, and a screen
that re-keys its own composer needs a **move**. The retired New automation
screen was that screen; none does it today, and the mechanism stays for the
next one. `releaseDraft()` is what makes a re-key a move: it drops the pending
write so the key-change flush leaves nothing behind, and clears the key the
text was typed under, which a typing burst longer than the debounce has already
written. Both halves are needed — either alone leaves the sentence in two places —
and it must be called before the key changes, since it reads the key being released
from `latest`, which describes the key being switched *to* by the time any effect
runs.

`useFileAttachments(api, draftKey)` owns the files. On mount it restores the cached
rows in insertion order, rebuilds each `File`, and regenerates image previews. An
attachment that already carries a resource is immediately ready; one whose upload
never finished is uploaded again. Files dropped while the read was still in flight
keep their place at the end of the row rather than being replaced by what was on
disk.

Because the upload endpoint keys a draft resource by the client's local ID, a
re-upload of an interrupted attachment answers `409 attachment_draft_exists`. That
is not an error: it means the bytes already landed, and the composer treats the
attachment as ready against the resource that local ID names. The same property
makes the local ID and the resource ID interchangeable when a draft is deleted.

Switching from one draft to another never cancels an upload in flight. The upload
writes its result to the cache under the key it started on, so looking away from a
composer costs nothing; only the unmounted hook aborts, and the bytes are still on
disk to try again with.

Unsent artifact pins are deliberately in-memory state and never enter this
cache. [Artifact annotations](artifact-annotations.md) owns their scope and
accepted-send cleanup; closing the app discards them.

### What is not cached

- Sidekick drafts under construction: the definition revisions, the
  conversation, and the plugin or activity-source choices. Only the input
  component is cached; the conversation is the Sidekick's own substream `0`
  and the revisions live on its hosted Sidekick
  ([`automation-lifecycle.md`](automation-lifecycle.md)). The plugin and
  activity-source choices are cached nowhere, because they are re-derived from
  the connections in force when a revision is applied.
- Files that could never be sent. An empty file, or one over the 25 MB limit, is
  shown as failed and never written to disk.
- Attachments beyond the ten a message may carry, whether they were found on
  restore or created by a drop that raced it.
- The model chosen in the composer's developer-mode selector. A draft outlives the
  session, and a model pinned last week is not a choice anyone would expect to still
  be in force when the sentence beside it comes back.

## Invariants

- **Every cache key is built in `lib/draft-keys.ts`.** A key composed at a call
  site is how the two halves of a composer drift apart, and how one workspace's
  words appear in another.
- **A draft's text and its attachments share one key.** They are two stores, not two
  scopes.
- **Writing empty text deletes the row.** A cleared composer has no draft, and
  nothing comes back on the next visit.
- **Hydration never writes back what it just read**, or a daily visit restamps the
  row forever and the TTL never fires.
- **The local TTL stays comfortably inside the server's draft-resource TTL.** 12
  hours against 24: raising the local one past the reaper's would restore
  attachments pointing at resources that have already been swept.
- **Every write states the epoch its content was captured in, and a write from an
  earlier epoch is dropped.** Without it a draft typed seconds before sign-out
  survives on a signed-out device.
- **A screen that re-keys its own composer calls `releaseDraft()` before the key
  changes.** A hand-carry without it silently duplicates the draft, under two
  writers with different timings.
- **`releaseDraft` and the unmount-only commit take their key from `latest`'s
  closure, not from `draftKey`.** By the time an effect runs, `draftKey` is already
  the new key.
- **The user's typing wins over the cache read, however late the read lands.**

## Boundary

This module owns the on-device draft cache and the two hooks over it. It does not
own:

| For | Read |
| --- | --- |
| The automation a New automation conversation belongs to | [`automation-lifecycle.md`](automation-lifecycle.md) |
| The create path a submitted draft becomes | [`canvases.md`](canvases.md) |
| Draft resources, their upload endpoint, and the 24-hour reaper | [`data-model.md`](data-model.md), [`architecture.md`](architecture.md) |
| What may be written under `userData` at all | [`security.md`](security.md) |
| The transcript and directory a screen paints from before its socket answers, which is a separate database with a separate lifetime | [`local-cache.md`](local-cache.md) |

Nothing outside the renderer reads this cache, and nothing in it is authoritative:
a draft is a convenience over state the server has never been told about.

## Failure modes and limits

- **The cache is best-effort by construction.** Every operation resolves to an empty
  result rather than throwing, so a renderer with no IndexedDB, no quota, or a
  corrupt database still composes and sends normally — it just forgets.
- **A write the device refuses — an exhausted quota, most likely — is surfaced in
  the composer's error line.** The attachment still uploads and still sends; what it
  will not do is come back after a restart, and that is worth saying out loud in a
  feature whose whole promise is that work survives.
- **The ten-file limit is settled after the read, not before it.** A drop that
  arrives while the cache is still opening is counted against an empty composer, so
  it can push the total past ten once the cached files land. The excess is then
  cancelled, uncached, and its draft resources released, and the composer reports
  the same overflow message it would have shown up front — rather than hiding files
  that were uploaded but can no longer be reached or removed.
- **An upload finishing after its message was sent leaks a draft resource.** The
  attachment hook no longer deletes draft resources when a composer unmounts,
  because the draft is meant to outlive the screen — and that cleanup was also the
  only thing that released the resource an *in-flight* upload eventually creates.
  The composer clears, the cached row goes, and the upload completes into a draft
  resource that nothing references; the API's 24-hour reaper collects it. This is an
  accepted trade — the alternative was destroying uploads the user could still see —
  but it is a real behavior change rather than an oversight.
- **Beyond the TTL, the device's own quota is the only bound.** Nothing else evicts.

## Testing

`use-annotation-pins.test.tsx` covers persistence, concurrent providers, expiry,
scope isolation, sign-out fencing, partial submissions and edit-aware receipts.

`fake-indexeddb` backs the renderer's jsdom environment (`test/setup.ts`). It is a
single database shared by every test in a file, so a test that touches a composer
must call `clearAllDrafts()` in its `beforeEach`; the suites that do are the ones
that render a composer. Do not clear it globally — a live IndexedDB connection
perturbs React's `act` scheduling enough to break unrelated screens' assertions.

**Assert the cached row, not only the composer.** A composer empties the moment its
key changes and refills when the read lands, so a value assertion can be satisfied
by the gap between the two — which is how a draft left under the wrong key stayed
green for as long as it did. Where the question is "what is stored", `readDraftText`
is the answer to assert on.

The suites are `lib/draft-cache.test.ts`, `lib/use-draft-text.test.tsx`,
`lib/use-file-attachments.test.tsx`, and the screen tests that render a composer.
Run one with
`pnpm --filter @rally/desktop exec vitest run src/renderer/lib/use-draft-text.test.tsx`.

## Security and trust model

Drafts are workspace content stored **unencrypted** in the renderer's IndexedDB
under Electron's `userData` directory. That is deliberate and bounded: nothing else
is written there, no credential ever is, every draft expires after 12 hours, and
signing out deletes all of them. [`security.md`](security.md) owns the boundary this
sits inside.

## Changelog

### 2026-11-07 — A Canvas's Chat drafts under its own family

**What changed:** A Canvas's Chat caches its draft, attachments and annotation
pins under `canvas:<canvasId>` and registers the annotation scope
`canvas:<canvasId>`, chosen by parent kind in `conversationDraftKey`.

**Why:** A Canvas is a new conversation parent
([PRD](PRDs/2026-11-06_canvases-and-sidekicks/prd.md)); keying it as a work
stream would put Canvas drafts in front of every reader of `workstream:` keys
(the legacy migration, the Breakout launcher) and make the cutover's deletion
of those families take Canvas drafts with it.

**Consequences:** The workspace prefix still leads, so leaving an Organization
clears Canvas drafts with the rest. A popped-out artifact window reads the same
scope to confine its actions (`main/artifact-window-actions.ts`): for a Canvas
it renames and deletes through `/conversations/<canvasId>/resources/…` and
refuses pin with a reason naming the Canvas, since a Canvas artifact's pin
belongs to the Canvas. (Its link, refused here at first, became the Canvas
link onto the artifact on 2026-11-07; [`links.md`](links.md) owns it.)

Shipped in juno-ai-labs/avalon#1490.

### 2026-10-20 — Persist confirmed artifact comments with composer drafts

Comments now survive navigation and restart using per-comment rows in the existing
cache. Independent writes and generation-checked receipts preserve concurrent
window edits and feedback typed during submission. Reusing whole-list component
state would lose drafts on navigation and let a stale window erase another's work.
Resolution and hydration deliberately preserve expiry from the last authored edit.

### 2026-09-10 — The store beneath the drafts is shared with the local cache

**What changed:** The database open, the request and transaction awaiting,
the best-effort `withStores`, the epoch, and the test seam moved out of
`draft-cache.ts` into `createIndexedDbStore` in `lib/indexeddb-store.ts`.
The draft cache keeps its two object stores, its keys, its twelve-hour
lifetime, and its public functions; only the plumbing beneath them moved.

**Why:** The local cache ([`local-cache.md`](local-cache.md)) needed the same
plumbing and had copied it, comments included. Review of that change named
the copy: the reusable primitive is the store that resolves to a fallback
instead of throwing and fences writes with an epoch, and two caches carrying
their own copy of it is two places for the next fix to miss.

**Consequences:** A fix to how the database is opened, or to the epoch, lands
for both caches at once. The draft cache's tests are the regression suite for
the store's behaviour under drafts, and `indexeddb-store.test.ts` covers the
store alone. `closeDraftCache()` still resets the sort key the drafts keep
above the store.

### 2026-09-04 — Keep the established ten-file admission contract

**What changed and why:** Review found that the visual rewrite lowered the
composer cap to six and reused that cap during hydration, silently deleting
files accepted by the previous build. The cap is restored to ten; presentation
does not change admission or erase existing drafts. A cache/drop race test
preserves all nine cached files before admitting one newly dropped file.

### 2026-09-03 — New automation stops caching a draft

**What changed:** The **New automation** surface no longer exists as a
composer: `/automations/new` creates the automation over `POST /automations`
and replaces itself with `/automations/:id`, whose composer is the ordinary
conversation composer keyed by the automation id as the parent. The
`new-automation` keys remain in `draft-keys.ts` and the legacy migration in
`draft-cache.ts` only so rows a released build wrote can still be found.

**Why:** An automation is drafted in a conversation of its own
([`automation-lifecycle.md`](automation-lifecycle.md)), and the conversation
exists before a person can type, so there is no pre-identity sentence to hold
and no key to move on a settled turn.

**Consequences:** `releaseDraft()` and the move it enables have no caller; the
invariant about a re-keying screen stands for the next one. The
`new-automation` keys can be dropped once no released build predates this.

### 2026-08-31 — Every draft key begins with its workspace

**What changed:** Work-stream and launcher keys now share the
`workspace:<region>:<workspaceId>:` prefix. Switching within one account retains
all scopes; successful self-leave clears exactly the departed regional
workspace; sign-out or account replacement still clears the whole database.

**Why:** A session change used to imply sign-out or another account, so a global
wipe was safe. Workspace switching makes that transition routine, and clearing
all drafts would discard unsent work every time somebody moved between rows.

**Considered and rejected:** Keeping the old work-stream key because its UUID is
globally unique. Uniqueness prevents collision but cannot enumerate every text
and attachment row belonging to one workspace when that membership ends.

**Consequences:** New composer surfaces must use the common regional-workspace
prefix or they cannot participate in exact leave cleanup. On the first active
regional session, released single-workspace draft keys are migrated into that
session's scope; only recognized legacy shapes move, and a newer regional row
wins an interrupted rewrite.

Shipped in #464. Design: [Multiple workspaces PRD](PRDs/2026-08-31_multiple-workspaces/prd.md).

### 2026-08-28 — New automation hands its local draft to a durable route

**What changed:** `/automations/new` uses the shared composer draft and file
attachment hooks without creating an AutomationAgent. On first admission it
rekeys text and staged files to the server-minted automation ID before clearing
the launcher key, then replaces the route with `/automations/:id`.

**Why:** Navigating or typing is not durable product intent, but a sent turn
must survive the asynchronous identity transition without losing local input.

**Consequences:** Tests must cover typing before hydration, key transfer,
navigation during compilation, and reopening the durable draft.

### 2026-08-12 — A draft that moves to another key stops being left behind in the old one

**What changed:** `useDraftText` gained `releaseDraft()`, which drops the pending
write and clears the key the composer is holding. The New automation screen calls
it in the same handler that carries the composer onto the draft a settled turn
just named.

**Why:** That screen's hand-carry was a copy, not a move, and the copy stayed
where it was typed. A sentence typed while a turn was compiling belongs to the
draft that turn created — but the blank launcher shares the key it was typed
under, so **New automation** would open holding a sentence the user had already
sent. Two separate writers put it there: the debounce, for a burst longer than
250 ms, and the key-change flush, which commits `pending` under the key it was
captured in. Removing one still leaves the other, and each covers a different
timing, which is why `releaseDraft` does both rather than being a delete at the
call site.

It surfaced as an intermittent failure of `new-automation.test.tsx`'s
"carries an answer typed during a turn onto the draft that turn named" — about
one run in twelve. The bug underneath is not intermittent at all: the stale copy
is written every time. What varied was only whether the fire-and-forget write had
landed before the assertion's read, so the test noticed the defect roughly 8% of
the time. A rerun would have looked like a fix.

**Considered and rejected:** Deleting the old key from the screen after the
re-key, once the flush had run. It reads as the smaller change and it is not
sound: `withStores` awaits `openDatabase()` before opening each transaction, so
two fire-and-forget writes have no guaranteed order, and the flush could land
after the delete. Suppressing the write is the only ordering-free half.

Also rejected: clearing the composer before re-keying, so the flush would write
an empty string. React batches both state updates into one render, so the save
effect never runs under the old key and `pending` still holds the sentence.

**Consequences:** `releaseDraft` reads its key from `latest` rather than the
render's `draftKey`, for the same reason the unmount-only commit is not keyed on
`draftKey`: by the time an effect runs, `draftKey` is already the new key, and
clearing that one would delete the draft being moved *to*. Any future screen that
re-keys its own composer has to call it — a hand-carry without it silently
duplicates the draft. The two regression tests are deliberately split, one per
writer, because a single test covering both passes when either half is removed.

Shipped in #109.

### 2026-08-12 — The commit for an unhydrated edit now covers a key change too

**What changed:** The two cleanups the entry below describes are one. The
surviving cleanup writes under the key from its own effect closure, so it commits
an edit the cache read never answered for on a key change as well as on an
unmount.

**Why:** The entry below kept that commit off `draftKey` deliberately, because
`latest` describes the key being switched *to* by the time a key-change cleanup
runs — sound, and the reason this takes its key from the closure instead. What
that left uncovered is the composer that re-keys itself: the sentence carried
onto the new key is written by `setText` *after* the key changed, so the read for
that key is still in flight, the save effect is standing down, and nothing is
armed. Re-keyed again before it lands — or navigated away from — the sentence had
been hydrated under neither key and armed under neither, and no writer existed at
all. With the copy under the old key now correctly removed by `releaseDraft`, it
would simply be gone.

**Considered and rejected:** *Having the screen write the carried text to the new
key itself.* It knows the text and the key, but not whether the hook's read has
landed, so it would either double-write what hydration is about to save or race
it.

**Consequences:** One cleanup runs on every key change and unmount, and its guard
is what keeps it cheap: a composer with nothing uncommitted falls straight
through to the flush. Anything added to this hook that writes on the way out has
to take its key from the same place, because `latest` is already describing
somewhere else.

### 2026-08-11 — An edit made before the cache read lands is no longer lost

**What changed:** `useDraftText` commits on unmount even when hydration never
completed. The save effect still stands down until the cached row has been read;
what is new is a second, unmount-only commit for exactly the case that effect
cannot cover.

**Why:** `use-draft-text.test.tsx > commits an unsaved draft when the composer
unmounts` fails about one run in seven, in isolation. It is not a test defect.
Typing arms nothing until `readDraftText` resolves, and the hydration handler
that would have saved the text bails when the composer is already gone — so an
edit made and abandoned inside the read window has no writer at all. The window
is milliseconds on a warm cache and much longer on a cold one, which is exactly
when someone opens a composer, types, and thinks better of it. The hook's own
comment already claimed this text was the user's "however late the read lands";
that was true for one order of events and not the other.

**Considered and rejected:** Making the test wait for hydration before typing.
That is the change that makes a green suite out of a real defect — the sentence
would still be dropped in the product, and nothing would be left to catch it.

**Consequences:** Unmount now has two cleanups that can write, and they are
ordered: the keyed one flushes what the debounce holds, and the unmount-only one
covers the unhydrated case and returns immediately in every other. The second is
deliberately not keyed on `draftKey` — a key-change cleanup runs when `latest`
already describes the key being switched *to*, so firing it there would write one
draft's text under another's key.

Shipped in #99. The regression test that pins it arrived separately, in #104.
