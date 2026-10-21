# Attachment image preview cache

Message thumbnails and the viewer share image downloads on desktop and web.
Original image bytes persist across app launches, with access and revision
validation before reuse.

## Where the code lives

- `apps/desktop/src/renderer/lib/resource-preview-cache.ts`: pending readers,
  cancellation and persisted bytes; `api.ts` supplies scopes and conditional requests.
- `apps/api/src/routes/resources.ts` and `services/resource-service.ts`: the
  conditional preview endpoint; `middleware/request-context.ts` owns its CORS headers.

## How it works

Each API client coalesces concurrent reads for the same scoped URL, cache
epoch and observed resource version. Detached-window refreshes carry the version
they are refreshing, so a newer head never joins an older head's pending read.
The persisted key stays stable; version validation still comes from the server.
The last reader leaving aborts the request. A loaded thumbnail supplies
its URL directly to the viewer; an unfinished thumbnail shares its pending load.

The `resource-image-preview` slice stores ArrayBuffer bytes, MIME type and ETag
in the existing local cache. Account, region, Organization and member/guest
access scopes come from `localCacheScope`; the key includes the API URL.
Existing sign-out and Organization-removal wipes cover this slice.
Sign-out changes a global generation in IndexedDB; Organization wipes change
only that account's member/guest scope generations. Image saves compare the
global and scope generations in the write transaction, fencing downloads in
other tabs without interrupting unrelated Organizations. Local epochs follow
the same scope boundaries for image reads.

Only image responses with an ETag beginning with `"image-preview-v1:` are saved.
Raw R2 ETags cannot revalidate, so they are ignored and any previously saved
rows using them are discarded. The server's preview validator names the
representation, resource revision and source digest. A matching conditional
request passes fresh canonical admission and returns 304 without reading R2;
a changed image replaces the saved bytes. Cold reads add no metadata request.
Downloaded bytes display before their background save commits. A conditional
network failure retries the read once without the header, allowing an older
API's CORS policy to work. A completed plain read replaces or discards the old
validator; an outage or interrupted body preserves the saved bytes for later
validation.

## Invariants

- Stored bytes grant no access: rejected validation must never display them.
  Service and cache tests cover access refusal.
- Only revalidatable images persist: otherwise every open downloads and rewrites
  them. Cache tests cover raw R2 ETags, stale rows and revision changes.
- Reader cancellation is independent. Streaming bodies recheck the local epoch
  and shared generation before delivery; saves check both before writing.
  Cache/store tests cover delayed bodies and separate renderer instances.

## Boundary

This module owns image reuse. [Local cache](local-cache.md) owns storage and
wipes, [authorization](authorization.md) owns admission, and
[conversation surfaces](conversation-surfaces.md) owns presentation. Conversion
and other formats keep their existing lifecycle. Responses retain `private,
no-store`; scoped application persistence owns the bytes.

## Failure modes and limits

Failed validation fails the load, without an offline fallback. Unavailable or
full IndexedDB falls back to ordinary downloads. Blob URLs belong to their
mounted views; only bytes persist. New loads still pay authorization latency,
and cold thumbnails still download originals.
Access refusal or resource deletion (403/404) removes the saved bytes; other
server errors preserve them. A successful uncacheable replacement also removes
the old image bytes without delaying display. Only a failed conditional network
request gets the plain-read retry; uncached failures and aborted requests are
not replayed.

Retention follows account/Organization wipes and the browser storage quota.
There is no application retention ceiling; the PR hands the retention/eviction
policy decision to the team rather than inventing a budget.

## Testing

Run desktop `resource-preview-cache.test.ts`, `api.test.ts` and
`attachments.test.tsx`, plus API `resource-upload.test.ts` and
`security-and-config.test.ts` and Worker `resource-read-admission.test.ts`.
The Worker route test checks one admission on a 304, no R2 read, and revocation
on the next request. Cache tests reopen fake-indexeddb; service tests
use the actual WorkspaceDO schema over SQLite with the existing R2 fixture.
Real Electron window checks verify rendering and persistence after process restart.

## Changelog

### 2026-10-21 — Share and persist attachment image downloads

**What changed:** Shared pending loads and scoped persistent bytes use conditional
preview validators to avoid repeat transfers and R2 reads.

**Why:** Opening before a thumbnail finished duplicated a full download;
navigation and relaunch discarded the loaded image. Raw storage ETags must not
enter this cache because the preview endpoint cannot return 304 for them.

**Considered and rejected:** A separate metadata request slows cold opens.
Reusing bytes without validation can retain obsolete content or revoked access.

**Consequences:** Preserve fresh canonical admission on 304 responses, shared wipe fencing
and rollback to an API without conditional CORS support. Keep wipe fences scoped
and pending refreshes separate across observed revisions. Version the validator
when the representation changes. Authorization latency remains.
