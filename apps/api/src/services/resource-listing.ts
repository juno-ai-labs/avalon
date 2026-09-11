/**
 * Whether a resource is *advertised*, as distinct from whether it is reachable.
 *
 * Attaching used to be one fact. It is two: the link authorizes the resource,
 * and every advertising surface then shows it unasked. They come apart for a
 * capture Rally makes *for* someone — the Terminal recovery backup — which has
 * to stay resolvable while being nobody's deliverable.
 *
 * Listing is presentation. It hides nothing from someone holding the id, and no
 * read decision may be built on it. `docs/agent-attachments.md` owns the rule,
 * including the two triggers this key sits on the wrong side of.
 */
const RESOURCE_LISTING_METADATA_KEY = "listing";

/** The one non-default listing. Absence of the key means listed. */
const UNLISTED_RESOURCE_LISTING = "unlisted";

/** Spread into a resource's `metadata_json` to keep it out of every listing. */
export function unlistedResourceMetadata(): { listing: typeof UNLISTED_RESOURCE_LISTING } {
  return { [RESOURCE_LISTING_METADATA_KEY]: UNLISTED_RESOURCE_LISTING };
}

/**
 * The predicate every enumerating statement applies, in the shape the two that
 * already sit beside it in `resource-service.ts` use. `metadata_json` carries a
 * `json_valid` CHECK, so `json_extract` cannot fault on a stored row.
 *
 * The alias is a union rather than a string: this is spliced into a `WHERE`
 * clause, and the callers are countable.
 */
export function listedResourceVisibilitySql(alias: "r" | "resource"): string {
  return `COALESCE(json_extract(${alias}.metadata_json, '$.${RESOURCE_LISTING_METADATA_KEY}'), '')`
    + ` != '${UNLISTED_RESOURCE_LISTING}'`;
}

/** The same decision for a row already in hand, for a caller that broadcasts. */
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
