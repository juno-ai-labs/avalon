/**
 * Serve one stored R2 object as an HTTP response, honouring a single byte
 * range.
 *
 * Every byte Rally serves from a version's stored copy goes through here: a
 * published file, a static site's asset, and the asset an active site's own
 * code fetches through `env.ASSETS`. A podcast or video player seeks by asking
 * for a range, and Apple's podcast directory refuses a feed whose media
 * answers without one, so a response that always sent the whole object made
 * every long file unseekable.
 *
 * It runs after admission, so it changes how much of an admitted object is
 * sent and never whether it is sent. Each stored key is one immutable version,
 * so a range always reads from one fixed copy; the `ETag` still lets a client
 * resuming a download with `If-Range` notice that the URL now serves another
 * version, and get the whole new one instead of a spliced file.
 *
 * Only `bytes=start-end`, `bytes=start-` and `bytes=-suffix` are honoured. A
 * request for several ranges gets the whole object with `200`, which RFC 9110
 * allows and every player handles; a multipart body is not worth its parser.
 */

/** The parts of an R2 bucket this needs; `env.PAYLOADS` satisfies it. */
export interface StoredObjectBucket {
  head(key: string): Promise<R2Object | null>;
  get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null>;
}

export type StoredObjectResponse =
  | { found: true; response: Response }
  | { found: false };

/** A satisfiable range as R2 reads it, or why there is none to apply. */
type RangeDecision =
  | { kind: "whole" }
  | { kind: "range"; offset: number; length: number }
  | { kind: "unsatisfiable" };

/**
 * Read a `Range` header against an object's size. Anything this does not
 * understand is ignored and the whole object served, as RFC 9110 directs.
 */
export function decideRange(header: string | null, size: number): RangeDecision {
  if (header === null) return { kind: "whole" };
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (!match) return { kind: "whole" };
  const [, first, last] = match;
  if (first === "" && last === "") return { kind: "whole" };
  if (first === "") {
    const suffix = Number(last);
    if (suffix === 0 || size === 0) return { kind: "unsatisfiable" };
    const length = Math.min(suffix, size);
    return { kind: "range", offset: size - length, length };
  }
  const offset = Number(first);
  if (offset >= size) return { kind: "unsatisfiable" };
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  if (end < offset) return { kind: "whole" };
  return { kind: "range", offset, length: end - offset + 1 };
}

/**
 * The response for `key`, with `headers` (its content type and anything else
 * the caller sets) on every outcome. `found: false` means the object is not
 * stored, which each caller answers in its own words.
 */
export async function storedObjectResponse(
  bucket: StoredObjectBucket,
  key: string,
  request: Request,
  headers: Record<string, string>,
  options: { ranges?: boolean } = {},
): Promise<StoredObjectResponse> {
  // A caller whose response may be rewritten after this returns (an active
  // site's HTML, which Rally injects into) asks for no ranges: a range of the
  // stored page would be spliced into a page that is no longer those bytes.
  const rangeHeader = request.method === "GET" && options.ranges !== false ? request.headers.get("range") : null;
  // A plain GET reads the object once. A HEAD reads only its metadata, and a
  // ranged GET reads that first so the range is checked against the real size.
  if (request.method !== "HEAD" && rangeHeader === null) {
    const object = await bucket.get(key);
    if (!object) return { found: false };
    return { found: true, response: new Response(object.body, { status: 200, headers: whole(object, headers) }) };
  }
  const metadata = await bucket.head(key);
  if (!metadata) return { found: false };
  if (request.method === "HEAD") {
    return { found: true, response: new Response(null, { status: 200, headers: whole(metadata, headers) }) };
  }
  // A client resuming a download sends the version it holds; another version
  // gets the whole object, never a range spliced onto the old one.
  const ifRange = request.headers.get("if-range");
  const decision = ifRange !== null && ifRange !== metadata.httpEtag
    ? { kind: "whole" as const }
    : decideRange(rangeHeader, metadata.size);
  if (decision.kind === "unsatisfiable") {
    return { found: true, response: new Response(null, { status: 416, headers: {
      ...headers, "accept-ranges": "bytes", "content-range": `bytes */${metadata.size}`,
    } }) };
  }
  const object = await bucket.get(key, decision.kind === "range"
    ? { range: { offset: decision.offset, length: decision.length } }
    : undefined);
  if (!object) return { found: false };
  if (decision.kind === "whole") {
    return { found: true, response: new Response(object.body, { status: 200, headers: whole(object, headers) }) };
  }
  const end = decision.offset + decision.length - 1;
  return { found: true, response: new Response(object.body, { status: 206, headers: {
    ...headers,
    "accept-ranges": "bytes",
    "content-length": String(decision.length),
    "content-range": `bytes ${decision.offset}-${end}/${object.size}`,
    etag: object.httpEtag,
  } }) };
}

function whole(object: R2Object, headers: Record<string, string>): Record<string, string> {
  return {
    ...headers,
    "accept-ranges": "bytes",
    "content-length": String(object.size),
    etag: object.httpEtag,
  };
}
