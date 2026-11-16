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
 * A ranged request is one R2 read: the range and any `If-Range` go to R2 with
 * the read, and the object's metadata is fetched only when R2 refuses a range
 * that starts past the end, to answer `416` with the size. Players ask for a
 * range on nearly every seek, so a metadata read in front of each would be paid
 * constantly for a check R2 already makes.
 *
 * It also answers a browser's revalidation (`If-None-Match`) with `304`, which
 * is what lets the serving Worker mark stored bytes `private, no-cache` rather
 * than `no-store`: the browser keeps its copy, and every reuse is still
 * admitted first.
 *
 * Only `bytes=start-end`, `bytes=start-` and `bytes=-suffix` are honoured. A
 * request for several ranges gets the whole object with `200`, which RFC 9110
 * allows and every player handles; a multipart body is not worth its parser.
 */

/**
 * The response for `key`, with `headers` (its content type and anything else
 * the caller sets) on every outcome, or null when the object is not stored,
 * which each caller answers in its own words.
 */
export async function storedObjectResponse(
  bucket: R2Bucket,
  key: string,
  request: Request,
  headers: Record<string, string>,
  options: { ranges?: boolean } = {},
): Promise<Response | null> {
  // A caller whose response may be rewritten after this returns (an active
  // site's HTML, which Rally injects into) asks for `ranges: false`: no range,
  // since a range of the stored page would be spliced into a page that is no
  // longer those bytes, and no `304`, since the stored page's `ETag` says
  // nothing about the page the browser was sent.
  const exact = options.ranges !== false;
  // A browser revalidating its copy sends the `ETag`s it holds, or `*`; one
  // that matches (weakly, as RFC 9110 has `If-None-Match` compare) answers
  // `304`. One that does not falls through, so a `Range` beside it is still
  // honoured, as RFC 9110 evaluates them in that order.
  const held = exact && (request.method === "GET" || request.method === "HEAD")
    ? heldEtags(request.headers.get("if-none-match"))
    : null;
  if (held !== null || request.method === "HEAD") {
    const metadata = await bucket.head(key);
    if (!metadata) return null;
    if (held !== null && (held === "*" || held.includes(metadata.etag))) return notModified(metadata, headers);
    if (request.method === "HEAD") return new Response(null, { status: 200, headers: whole(metadata, headers) });
  }
  const range = request.method === "GET" && options.ranges !== false ? requestedRange(request.headers.get("range")) : null;
  if (range === null) {
    const object = await bucket.get(key);
    return object ? new Response(object.body, { status: 200, headers: whole(object, headers) }) : null;
  }
  if (range === "unsatisfiable") return unsatisfiable(bucket, key, headers);
  // A client resuming a download sends the version it holds; R2 answers the
  // range only if it is still that version, and another version is sent whole.
  const ifRange = request.headers.get("if-range");
  let object: R2ObjectBody | R2Object | null;
  try {
    object = await bucket.get(key, {
      range,
      ...(ifRange ? { onlyIf: { etagMatches: ifRange.replace(/^W\//u, "").replace(/^"|"$/gu, "") } } : {}),
    });
  } catch (error) {
    // R2 refuses a range that starts at or past the end of the object.
    if ("offset" in range) return unsatisfiable(bucket, key, headers);
    throw error;
  }
  if (!object) return null;
  if (!("body" in object)) {
    const current = await bucket.get(key);
    return current ? new Response(current.body, { status: 200, headers: whole(current, headers) }) : null;
  }
  // The range asked for, clamped to the size R2 reports, rather than R2's own
  // echo of it, whose shape differs between runtimes.
  const { offset, length } = resolvedRange(range, object.size);
  return new Response(object.body, { status: 206, headers: {
    ...headers,
    "accept-ranges": "bytes",
    "content-length": String(length),
    "content-range": `bytes ${offset}-${offset + length - 1}/${object.size}`,
    etag: object.httpEtag,
  } });
}

/**
 * A `Range` header as R2 reads it, `"unsatisfiable"` for one no object could
 * answer, or null for none or one this does not understand, which is served
 * whole as RFC 9110 directs.
 */
function requestedRange(header: string | null): R2Range | "unsatisfiable" | null {
  if (header === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/iu.exec(header.trim());
  if (!match) return null;
  const [, first = "", last = ""] = match;
  if (first === "" && last === "") return null;
  if (first === "") {
    const suffix = Number(last);
    return suffix === 0 ? "unsatisfiable" : { suffix };
  }
  const offset = Number(first);
  if (last === "") return { offset };
  const end = Number(last);
  return end < offset ? null : { offset, length: end - offset + 1 };
}

/** The bytes a range covers in an object of `size`, clamped to its end. */
function resolvedRange(range: R2Range, size: number): { offset: number; length: number } {
  if ("suffix" in range) {
    const length = Math.min(range.suffix, size);
    return { offset: size - length, length };
  }
  const offset = range.offset ?? 0;
  return { offset, length: Math.min(range.length ?? size - offset, size - offset) };
}

/** The opaque tags an `If-None-Match` lists, `"*"` for any, or null for none. */
function heldEtags(header: string | null): string[] | "*" | null {
  if (header === null || header.trim() === "") return null;
  if (header.trim() === "*") return "*";
  const tags = [...header.matchAll(/(?:W\/)?"([^"]*)"/gu)].map((match) => match[1]!);
  return tags.length > 0 ? tags : null;
}

function notModified(object: R2Object, headers: Record<string, string>): Response {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) if (name.toLowerCase() !== "content-type") kept[name] = value;
  return new Response(null, { status: 304, headers: { ...kept, etag: object.httpEtag } });
}

async function unsatisfiable(bucket: R2Bucket, key: string, headers: Record<string, string>): Promise<Response | null> {
  const metadata = await bucket.head(key);
  if (!metadata) return null;
  return new Response(null, { status: 416, headers: {
    ...headers, "accept-ranges": "bytes", "content-range": `bytes */${metadata.size}`,
  } });
}

function whole(object: R2Object, headers: Record<string, string>): Record<string, string> {
  return {
    ...headers,
    "accept-ranges": "bytes",
    "content-length": String(object.size),
    etag: object.httpEtag,
  };
}
