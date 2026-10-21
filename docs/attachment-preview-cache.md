# Attachment image preview cache

Message thumbnails and the attachment viewer share one image download. Original
image bytes persist on the device across navigation and application launches;
each new load validates access and the image revision with the regional API
before displaying those saved bytes. The mechanism is shared by Electron and
the browser client.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/renderer/lib/resource-preview-cache.ts` | Coalesces readers, owns cancellation, and stores image bytes and validators in the existing local cache. |
| `apps/desktop/src/renderer/lib/api.ts` | Scopes cache reads to the account, regional Organization, access class and API URL; sends conditional preview requests. |
| `apps/api/src/routes/resources.ts` | Passes the request's `If-None-Match` to the preview service. |
| `apps/api/src/services/resource-service.ts` | Authorizes reads, compares the original image's revision and digest, and skips R2 on a matching validator. |
| `apps/api/src/middleware/request-context.ts` | Admits conditional request headers and exposes the response ETag through CORS. |

## How it works

`getResourcePreviewContent` uses one `ResourcePreviewCache` per API client.
Concurrent reads for the same scoped URL and cache epoch share the same pending
request. Each reader owns its cancellation; the underlying read is aborted only
after every reader has left. Completed requests leave the pending map.

The cache saves an image as an ArrayBuffer, MIME type and ETag in the
`resource-image-preview` slice of `rally-local-cache`. Its scope comes from
`localCacheScope`, so account, region, Organization and member/guest access stay
separate. The key includes the API origin and resource URL. One current image
replaces the previous bytes at that key. The existing sign-out and Organization
removal wipes cover this slice too.

A later read sends the saved ETag to the same authorized preview endpoint.
For original browser-readable images with a content digest, the validator
includes a representation identifier, the resource revision and that digest.
A match returns HTTP 304 without reading R2 or sending image bytes. The client
constructs a Blob from the saved bytes. A mismatch returns the current image and
replaces the saved entry. Cold reads have no extra metadata request.

The feed still passes its already loaded image URL directly to the viewer.
When it opens before the thumbnail finishes, both readers use the shared load.
Conversion-dependent image formats and other attachment types keep their
existing preview lifecycle.

## Invariants

- Saved bytes are never an access grant. Both canonical preview access checks
  still run on a 304; a rejected request never displays cached bytes. The cache
  tests cover rejected validation and the service test covers revocation.
- The ETag identifies both bytes and revision. A new digest or revision returns
  an image body, preventing a stale preview. Service and cache tests cover this.
- Canceling one reader cannot cancel another. Cache tests cover thumbnail
  cancellation while a viewer remains and cancellation of the last reader.
- A pre-wipe download cannot publish or return bytes after sign-out. The local
  cache epoch fences persistence and delivery; cache tests cover an in-flight wipe.

## Boundary

This cache owns original image reuse, not resource authority, image resizing or
document conversion. [Authorization](authorization.md) owns admission;
[local cache](local-cache.md) owns IndexedDB and account/Organization wipes;
[conversation surfaces](conversation-surfaces.md) owns preview presentation.
HTTP responses retain `private, no-store`: the application stores scoped bytes
explicitly rather than granting Chromium a reusable authenticated response.

## Failure modes and limits

A failed validation fails the load, even if bytes remain on disk. There is no
offline access fallback. Failed requests leave the pending map and can be retried.
If IndexedDB is unavailable, full, or refuses a write, previews continue through
the ordinary download path. Cache capacity follows the browser's storage quota;
there is no application-defined time, size or item ceiling. Blob URLs belong to
their mounted view and are revoked on cleanup; only bytes persist.

Cached opens still pay the access-validation round trip. A current thumbnail URL
needs no new load. Cold thumbnails still fetch original images, so large images
can take longer than a separately resized thumbnail would.

## Testing

Run the desktop `resource-preview-cache.test.ts`, `api.test.ts`, and
`attachments.test.tsx` files, and the API `resource-upload.test.ts` and
`security-and-config.test.ts` files. The cache tests use fake-indexeddb and real
ArrayBuffer cloning; they close and reopen the database to exercise persistence.
The service tests use the actual WorkspaceDO schema and service over SQLite,
with R2 represented by the existing typed fixture. A real Electron window check
verifies rendering and persistent IndexedDB after restarting the process.

## Changelog

### 2026-10-21 — Share and persist attachment image downloads

**What changed:** Thumbnail and viewer reads share pending loads; scoped device
storage retains images across launches and conditional preview requests reuse
unchanged bytes without an R2 read.

**Why:** Opening a thumbnail before it finished downloading started another
full-image request. Navigation and relaunch discarded the downloaded image,
and `no-store` prevented HTTP caching from rescuing the redundant transfer.

**Considered and rejected:** A separate metadata fetch adds another network
round trip to cold previews. Reusing authenticated HTTP responses without
validation could retain access after revocation or display an obsolete image.

**Consequences:** Keep the canonical access checks on bodyless responses and
include representation changes in the validator. This removes repeated image
transfers; it does not remove authorization RPC latency from a new load.
