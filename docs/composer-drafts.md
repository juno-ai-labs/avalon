# Composer drafts

Every Avalon composer keeps what the user has entered on the device until it is
sent or cleared. Closing a work stream, walking to another screen, or quitting
Avalon mid-sentence does not cost the sentence, and it does not cost the files
that were dropped next to it.

Three surfaces cache a draft, and they are the only ones that do:

| Surface | Component | Cache key |
| --- | --- | --- |
| A work stream's composer | `WorkstreamComposer` | `workstream:<workstreamId>` |
| **New work stream** | `NewWorkstreamScreen` | `new-workstream:<workspaceId>` |
| **New automation** | `NewAutomationScreen` | `new-automation:<workspaceId>`, and `new-automation:<workspaceId>:<draftAutomationId>` once the conversation has a draft automation |

`lib/draft-keys.ts` is the single place those strings are built. A draft's text
and its attachments share one key, so the two halves of a composer can never
drift apart, and the launchers are scoped per workspace so switching workspaces
does not surface another workspace's words.

**New automation** is one screen serving many conversations, so its key gains the
draft automation being written the moment a turn names one — otherwise an unsent
sentence, and the files staged beside it, follow the screen into the next
automation. The key moves on a settled turn rather than with the address bar, and
the text typed while that turn was compiling is carried across by hand;
[`automation-drafts.md`](automation-drafts.md) has the reasoning.

## What is stored, and where

Drafts live in an IndexedDB database named `avalon-composer-drafts` in the
renderer's origin, owned by `lib/draft-cache.ts`. It has two object stores:

- `text` — one row per key holding the drafted text and the mentions the user
  picked while writing it. **Writing empty text deletes the row**: a composer
  the user has cleared has no draft, and nothing comes back on the next visit.
- `attachments` — one row per pending file, keyed by `[draftKey, localId]`,
  holding the file's bytes as an `ArrayBuffer` plus its name, MIME type,
  modification time, content hash, and — once the upload finishes — the draft
  resource the API returned.

Bytes are stored as a buffer rather than a `Blob` because not every IndexedDB
implementation clones a `Blob` faithfully, and the composer rebuilds a `File`
from the buffer on restore anyway.

The cache is best-effort by construction. Every operation resolves to an empty
result rather than throwing, so a renderer with no IndexedDB, no quota, or a
corrupt database still composes and sends normally — it just forgets.

## Lifetime

A cached attachment names a **draft resource** that the API's reaper deletes 24
hours after upload (`DRAFT_ATTACHMENT_TTL_HOURS`). Local drafts therefore expire
at 12 hours (`DRAFT_CACHE_TTL_MS`), comfortably inside that window, so a restored
attachment never points at a resource that has already been swept.

The clock runs from the last **edit**, not the last visit. Hydration deliberately
does not write back what it just read; otherwise opening a work stream daily
would restamp its row forever and the draft would never expire.

Reads filter expired rows. The first composer mounted in an application run also
sweeps with `pruneExpiredDrafts`, which walks the attachment store's `updatedAt`
index rather than reading it whole — a live draft's file bytes are never
deserialized just to learn that the draft is not expired. The sweep hands back
the rows it deleted so the client can release their server-side draft resources,
and it only counts as done once it has a client to do that with; a composer that
mounts before the API is ready leaves the sweep for the next one.

Nothing else evicts. The TTL is the bound: the cache holds at most the
attachments added in the last twelve hours, across every composer visited in that
window. Beyond it the device's own quota is the limit, and a write that the quota
refuses is reported rather than swallowed — see below.

Leaving a session drops every draft. `AppSessionProvider` watches the session and
calls `clearAllDrafts` on any transition that changes the draft scope — the API
host, the user, or the workspace — which covers a deliberate sign-out, main
surrendering a terminally expired credential, and one account replacing another
on the device. A role change is not a scope change: being promoted does not cost
anyone their unsent message. The first session of a run is an arrival rather than
a departure, so launching Avalon keeps what the last run left behind.

A wipe has to beat work that was already in flight when it started — a debounced
save, a file still being fingerprinted, an upload about to record its resource —
or a draft typed seconds before sign-out lands behind the clear and survives on a
signed-out device. Ordering alone does not settle that, so the cache carries an
**epoch**: `clearAllDrafts` moves it on, every write states the epoch its content
was captured in, and a write from an earlier one is dropped. A composer opened
after the wipe reads the new epoch and writes normally, so nothing has to be
reset by hand.

## How a draft is restored

`useDraftText(draftKey)` owns the text half. On mount — and whenever the key
changes — it resets, reads the cached row, and applies it **unless the user has
already typed**, which they own outright however late the read lands. Saves are
debounced by 250 ms and flushed when the composer unmounts or switches keys, so
quitting mid-word still commits the word — including a word typed *before* the
read landed, which the debounce never held because saving stands down until
hydration. That one is written by its own unmount-only commit; without it, a
composer opened, typed into, and left inside the read window lost the sentence.

`useFileAttachments(api, draftKey)` owns the files. On mount it restores the
cached rows in insertion order, rebuilds each `File`, and regenerates image
previews. An attachment that already carries a resource is immediately ready; one
whose upload never finished is uploaded again. Files dropped while the read was
still in flight keep their place at the end of the row rather than being replaced
by what was on disk.

The ten-file limit is settled after the read, not before it. A drop that arrives
while the cache is still opening is counted against an empty composer, so it can
push the total past ten once the cached files land. The excess is then cancelled,
uncached, and its draft resources released, and the composer reports the same
overflow message it would have shown up front — rather than hiding files that
were uploaded but can no longer be reached or removed.

A write the device refuses — an exhausted quota, most likely — is surfaced in the
composer's error line. The attachment still uploads and still sends; what it will
not do is come back after a restart, and that is worth saying out loud in a
feature whose whole promise is that work survives.

Because the upload endpoint keys a draft resource by the client's local ID, a
re-upload of an interrupted attachment answers `409 attachment_draft_exists`.
That is not an error: it means the bytes already landed, and the composer treats
the attachment as ready against the resource that local ID names. The same
property makes the local ID and the resource ID interchangeable when a draft is
deleted.

Switching from one draft to another never cancels an upload in flight. The
upload writes its result to the cache under the key it started on, so looking
away from a composer costs nothing; only the unmounted hook aborts, and the bytes
are still on disk to try again with.

## What is not cached

- Automation drafts under construction — the compiled `AutomationDraftResponse`,
  the assistant conversation, and the plugin or activity-source choices. Only the
  input component is cached; the conversation is saved on the draft automation
  itself, which is a real subscription row from its first compiled turn
  ([`automation-drafts.md`](automation-drafts.md)). The plugin and
  activity-source choices are cached nowhere, because they are re-derived from
  the connections in force under the scope in force.
- Files that could never be sent. An empty file, or one over the 25 MB limit, is
  shown as failed and never written to disk.
- Attachments beyond the ten a message may carry, whether they were found on
  restore or created by a drop that raced it.
- The model chosen in the composer's developer-mode selector. A draft outlives
  the session, and a model pinned last week is not a choice anyone would expect
  to still be in force when the sentence beside it comes back.

## A consequence worth knowing

The attachment hook no longer deletes draft resources when a composer unmounts,
because the draft is meant to outlive the screen. That cleanup was also the only
thing that released the resource an *in-flight* upload eventually creates. So
when a message is sent while one of its attachments is still uploading, the
composer clears, the cached row goes, and the upload then completes into a draft
resource that nothing references. The API's 24-hour reaper collects it. This is
an accepted trade — the alternative was destroying uploads the user could still
see — but it is a real behavior change rather than an oversight.

## Testing

`fake-indexeddb` backs the renderer's jsdom environment (`test/setup.ts`). It is
a single database shared by every test in a file, so a test that touches a
composer must call `clearAllDrafts()` in its `beforeEach`; the suites that do are
the ones that render a composer. Do not clear it globally — a live IndexedDB
connection perturbs React's `act` scheduling enough to break unrelated screens'
assertions.

## Changelog

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
