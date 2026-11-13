import { WorkspaceNameSchema } from "@rally/contracts";
import { z } from "zod";

import { runtimeDeferral } from "../lib/defer";
import { htmlElementText, htmlMetaContent, normalizeHtmlText } from "../lib/html-metadata";
import { assertSafePublicUrl } from "../lib/public-web-url";

/**
 * A name for the organization a new account is about to create, read from the
 * homepage of its email domain. It only prefills a field the person can
 * change, so every failure is "no suggestion" rather than an error. Account
 * creation reads it ahead (`prefetchOrganizationNameSuggestion`), so the
 * create-organization step normally finds the answer already cached.
 */

/**
 * Mail providers whose domain says nothing about the person's organization.
 * Fetching gmail.com would suggest "Gmail".
 */
const PERSONAL_MAIL_DOMAINS = new Set([
  "aol.com", "fastmail.com", "gmail.com", "gmx.com", "gmx.de", "gmx.net", "googlemail.com", "hey.com",
  "hotmail.com", "icloud.com", "live.com", "mac.com", "mail.com", "mail.ru", "me.com", "msn.com",
  "outlook.com", "pm.me", "privaterelay.appleid.com", "proton.me", "protonmail.com", "qq.com", "yahoo.com", "yandex.com",
  "yandex.ru", "zoho.com", "163.com",
]);

/** Names RFC 2606 reserves for testing and documentation: never a real homepage. */
const RESERVED_TOP_LEVEL = new Set(["example", "invalid", "localhost", "test"]);
const RESERVED_DOMAINS = new Set(["example.com", "example.net", "example.org"]);

/** Title segments that name the page rather than the organization. */
const GENERIC_TITLE_SEGMENTS = new Set(["home", "homepage", "home page", "welcome", "official site", "official website"]);

/** The registrable-looking domain of an address, or null when it is not one worth fetching. */
export function organizationEmailDomain(email: string): string | null {
  const domain = email.slice(email.lastIndexOf("@") + 1).trim().toLowerCase().replace(/\.$/u, "");
  if (!/^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z]{2,}$/u.test(domain)) return null;
  if (PERSONAL_MAIL_DOMAINS.has(domain) || RESERVED_DOMAINS.has(domain.split(".").slice(-2).join("."))) return null;
  if (RESERVED_TOP_LEVEL.has(domain.slice(domain.lastIndexOf(".") + 1))) return null;
  return domain;
}

/**
 * How long a domain's answer is reused before its homepage is read again.
 * Thirty days is the product's choice, given with the request for the cache.
 */
export const ORGANIZATION_NAME_SUGGESTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Bounds: bytes of one homepage held in memory while looking for the end of
 *   its `<head>`.
 * Without it: the email domain is chosen by whoever signs up, so its homepage
 *   can stream forever without `</head>` and grow the buffer until the isolate
 *   runs out of memory, taking every request sharing it down too.
 * Direction: upper bound.
 * Trips: the read stops and ends `too_large`, which is cached like any other
 *   answer; the person gets no suggestion.
 * Derived: half of the 128 MB Workers isolate memory limit kept for everything
 *   else, at up to 2 bytes of JS string per byte read, across ~32 of these
 *   reads at once in one isolate: 64 MB / (2 x 32) = 1 MB. Most homepage heads
 *   are well under 100 KB; heavy ones with inlined CSS/JS reach a few hundred.
 *   Chosen by the product owner on PR #1223.
 */
export const MAX_HOMEPAGE_HEAD_BYTES = 1024 * 1024;

/**
 * Redirects followed before giving up, transcribed from the Fetch Standard's
 * HTTP-redirect fetch ("If request's redirect count is 20, then return a
 * network error"), https://fetch.spec.whatwg.org/#http-redirect-fetch, read
 * 2026-10-13. Followed by hand so each hop passes `assertSafePublicUrl`.
 */
const MAX_REDIRECTS = 20;

/**
 * What reading a domain's homepage found. Every outcome but `unreachable` is
 * the domain's answer and is cached; `unreachable` says nothing about the
 * domain, and caching it would hide its name for thirty days because of one
 * bad minute.
 */
export const OrganizationNameOutcomeSchema = z.enum([
  /** The homepage named the organization. */
  "named",
  /** The homepage is HTML but names nothing usable. */
  "unnamed",
  /** The homepage answered with a 4xx or no body. */
  "missing",
  /** The homepage answered with something other than HTML. */
  "not_html",
  /** The homepage's head ran past `MAX_HOMEPAGE_HEAD_BYTES` before it ended. */
  "too_large",
  /** The homepage redirected to an address that is not a public host. */
  "refused",
  /** A network error or a 5xx: no answer from the domain. Never cached. */
  "unreachable",
]);
export type OrganizationNameOutcome = z.infer<typeof OrganizationNameOutcomeSchema>;

export type OrganizationNameReading =
  | { outcome: "named"; name: string }
  | { outcome: Exclude<OrganizationNameOutcome, "named">; name: null };

const CachedReadingSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("named"), name: z.string(), fetched_at: z.string() }),
  z.object({ outcome: z.enum(["unnamed", "missing", "not_html", "too_large", "refused"]), name: z.null(), fetched_at: z.string() }),
]);

/**
 * The suggestion for this address, from the domain's cached answer while it is
 * younger than the TTL, and otherwise from its homepage, caching the result.
 */
export async function suggestOrganizationName(
  db: D1Database,
  email: string,
  fetcher: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<string | null> {
  const domain = organizationEmailDomain(email);
  if (!domain) return null;
  const row = await db.prepare("SELECT outcome, name, fetched_at FROM organization_name_suggestions WHERE domain = ?")
    .bind(domain).first();
  const cached = row ? CachedReadingSchema.parse(row) : null;
  if (cached && now.getTime() - Date.parse(cached.fetched_at) < ORGANIZATION_NAME_SUGGESTION_TTL_MS) return cached.name;
  const reading = await readOrganizationName(domain, fetcher);
  if (reading.outcome === "unreachable") return cached?.name ?? null;
  await db.prepare(`INSERT INTO organization_name_suggestions (domain, outcome, name, fetched_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(domain) DO UPDATE SET outcome = excluded.outcome, name = excluded.name, fetched_at = excluded.fetched_at
    WHERE excluded.fetched_at >= organization_name_suggestions.fetched_at`)
    .bind(domain, reading.outcome, reading.name, now.toISOString()).run();
  return reading.name;
}

async function readOrganizationName(
  domain: string,
  fetcher: typeof fetch,
  maxHeadBytes = MAX_HOMEPAGE_HEAD_BYTES,
): Promise<OrganizationNameReading> {
  let url = `https://${domain}/`;
  let response: Response;
  for (let redirects = 0; ; redirects += 1) {
    try {
      assertSafePublicUrl(url);
    } catch {
      return { outcome: "refused", name: null };
    }
    try {
      response = await fetcher(url, { headers: { Accept: "text/html" }, redirect: "manual" });
    } catch {
      return { outcome: "unreachable", name: null };
    }
    const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (!location) break;
    void response.body?.cancel().catch(() => undefined);
    if (redirects === MAX_REDIRECTS) return { outcome: "unreachable", name: null };
    try {
      url = new URL(location, url).toString();
    } catch {
      return { outcome: "missing", name: null };
    }
  }
  if (response.status >= 500) return { outcome: "unreachable", name: null };
  if (!response.ok || !response.body) return { outcome: "missing", name: null };
  if (!isHtml(response.headers.get("content-type"))) return { outcome: "not_html", name: null };
  let head: string | null;
  try {
    head = await readHead(response.body, maxHeadBytes);
  } catch {
    return { outcome: "unreachable", name: null };
  }
  if (head === null) return { outcome: "too_large", name: null };
  const name = organizationNameFromHtml(head, domain);
  return name ? { outcome: "named", name } : { outcome: "unnamed", name: null };
}

/** Whether a Content-Type's media type is HTML, ignoring its parameters. */
function isHtml(contentType: string | null): boolean {
  const mediaType = contentType?.split(";")[0]?.trim().toLowerCase();
  return mediaType === "text/html" || mediaType === "application/xhtml+xml";
}

/** Longest marker `readHead` looks for (`</head` plus whitespace and `>`), as the rescan overlap. */
const HEAD_END_OVERLAP = 16;

/**
 * The page up to the end of its `<head>` (the marker excluded), or null when more than `maxBytes`
 * arrive first. Everything a name is read from lives there, so the body is
 * never downloaded. Only the newest chunk, plus enough of the last one to catch
 * a marker split across them, is searched, so the read stays linear.
 */
export async function readHead(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<string | null> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let source = "";
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return source + decoder.decode();
      bytes += value.byteLength;
      if (bytes > maxBytes) return null;
      const searchFrom = Math.max(0, source.length - HEAD_END_OVERLAP);
      source += decoder.decode(value, { stream: true });
      // Cut at the marker: the rest of the chunk is body, and a tag there must
      // not name the organization depending on where the network split it.
      const end = /<\/head\s*>|<body\b/iu.exec(source.slice(searchFrom));
      if (end) return source.slice(0, searchFrom + end.index);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

/**
 * `og:site_name` names the site rather than the page, so it wins. A `<title>`
 * usually joins the name to a tagline ("Acme | Tools for builders",
 * "Acme: Tools for builders"). Generic page labels such as "Home" are dropped
 * first; of the rest, the segment that matches the domain is the name,
 * otherwise the first.
 */
export function organizationNameFromHtml(source: string, domain: string): string | null {
  const siteName = validName(normalizeHtmlText(htmlMetaContent(source, "property", "og:site_name") ?? ""));
  if (siteName) return siteName;
  const title = normalizeHtmlText(htmlElementText(source, "title") ?? "");
  const segments = title.split(/\s+[|·•–—-]\s+|:\s+/u)
    .map((segment) => segment.trim())
    .filter((segment) => segment && !GENERIC_TITLE_SEGMENTS.has(segment.toLowerCase()));
  const label = comparable(domain.split(".")[0]!);
  const matching = segments.find((segment) => {
    const candidate = comparable(segment);
    return candidate.length > 0 && (candidate.includes(label) || label.includes(candidate));
  });
  const chosen = matching ?? segments[0];
  return chosen ? validName(chosen) : null;
}

function comparable(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function validName(value: string): string | null {
  const parsed = WorkspaceNameSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Read the suggestion into the cache in the background when an account is created. */
export function prefetchOrganizationNameSuggestion(db: D1Database, email: string): void {
  runtimeDeferral(suggestOrganizationName(db, email).catch(() => undefined));
}
