/**
 * Whether a resource is *advertised*, as distinct from whether it is reachable.
 *
 * Attaching a resource to a work stream used to be one fact. It is two: the
 * link authorizes the resource, and every enumerating surface then advertises
 * it — the member's rail, the workspace resource list, the model's
 * `list_resources` page and the inventory appendix compaction leaves behind,
 * and the search projection. For everything a person or a model produced on
 * purpose those two facts coincide, which is why they were never separated.
 *
 * They come apart for a capture Rally makes *for* someone rather than at their
 * request. The Terminal recovery backup is the case that forced this: repository
 * checkout cannot replace a workspace in place, so it archives the old one
 * first, and that archive has to stay reachable — a person opens its link, the
 * model restores it through `terminal_import_resource` — while being nobody's
 * deliverable. Listed, it claims a row in the artifacts rail beside real output
 * and spends model context on a `application/gzip` blob whose
 * `model_content_status` is already `unsupported`.
 *
 * An unlisted resource is therefore *reachable but unadvertised*: resolved by
 * id, opened, downloaded, imported and authorized exactly as before, and absent
 * from every surface that enumerates. The flag lives in `metadata_json` rather
 * than a column because one producer needs it today and a JSON key is the
 * cheapest thing to withdraw if a second one wants something finer; promote it
 * when there is a second.
 *
 * Listing is not authorization. It hides nothing from someone holding the id,
 * and no read decision may be built on it.
 */
export const RESOURCE_LISTING_METADATA_KEY = "listing";

/** The one non-default listing. Absence of the key means listed. */
export const UNLISTED_RESOURCE_LISTING = "unlisted";

/** Spread into a resource's `metadata_json` to keep it out of every listing. */
export function unlistedResourceMetadata(): { listing: typeof UNLISTED_RESOURCE_LISTING } {
  return { [RESOURCE_LISTING_METADATA_KEY]: UNLISTED_RESOURCE_LISTING };
}

/**
 * The predicate every enumerating statement applies, in the shape the two that
 * already sit beside it in `resource-service.ts` use: a named fragment rather
 * than a condition each caller rewrites. `metadata_json` carries a
 * `json_valid` CHECK, so `json_extract` cannot fault on a stored row.
 */
export function listedResourceVisibilitySql(alias: string): string {
  return `COALESCE(json_extract(${alias}.metadata_json, '$.${RESOURCE_LISTING_METADATA_KEY}'), '')`
    + ` != '${UNLISTED_RESOURCE_LISTING}'`;
}

/** The same decision for a row already in hand. */
export function isUnlistedResourceMetadata(metadataJson: unknown): boolean {
  if (typeof metadataJson !== "string") return false;
  try {
    const parsed = JSON.parse(metadataJson) as unknown;
    return Boolean(parsed) && typeof parsed === "object" && !Array.isArray(parsed)
      && (parsed as Record<string, unknown>)[RESOURCE_LISTING_METADATA_KEY] === UNLISTED_RESOURCE_LISTING;
  } catch {
    return false;
  }
}
