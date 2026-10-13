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
  "outlook.com", "pm.me", "proton.me", "protonmail.com", "qq.com", "yahoo.com", "yandex.com",
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
  /** A network error or a 5xx: no answer from the domain. Never cached. */
  "unreachable",
]);
export type OrganizationNameOutcome = z.infer<typeof OrganizationNameOutcomeSchema>;

export type OrganizationNameReading =
  | { outcome: "named"; name: string }
  | { outcome: Exclude<OrganizationNameOutcome, "named">; name: null };

const CachedReadingSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("named"), name: z.string(), fetched_at: z.string() }),
  z.object({ outcome: z.enum(["unnamed", "missing", "not_html"]), name: z.null(), fetched_at: z.string() }),
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
    ON CONFLICT(domain) DO UPDATE SET outcome = excluded.outcome, name = excluded.name, fetched_at = excluded.fetched_at`)
    .bind(domain, reading.outcome, reading.name, now.toISOString()).run();
  return reading.name;
}

async function readOrganizationName(domain: string, fetcher: typeof fetch): Promise<OrganizationNameReading> {
  const url = `https://${domain}/`;
  let response: Response;
  try {
    assertSafePublicUrl(url);
    response = await fetcher(url, {
      headers: { Accept: "text/html" },
      redirect: "follow",
    });
  } catch {
    return { outcome: "unreachable", name: null };
  }
  if (response.status >= 500) return { outcome: "unreachable", name: null };
  if (!response.ok || !response.body) return { outcome: "missing", name: null };
  if (!isHtml(response.headers.get("content-type"))) return { outcome: "not_html", name: null };
  let head: string;
  try {
    head = await readHead(response.body);
  } catch {
    return { outcome: "unreachable", name: null };
  }
  const name = organizationNameFromHtml(head, domain);
  return name ? { outcome: "named", name } : { outcome: "unnamed", name: null };
}

/** Whether a Content-Type's media type is HTML, ignoring its parameters. */
function isHtml(contentType: string | null): boolean {
  const mediaType = contentType?.split(";")[0]?.trim().toLowerCase();
  return mediaType === "text/html" || mediaType === "application/xhtml+xml";
}

/**
 * The page up to the end of its `<head>`. Everything a name is read from lives
 * there, so the body is never downloaded.
 */
async function readHead(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let source = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return source + decoder.decode();
      source += decoder.decode(value, { stream: true });
      if (/<\/head\s*>|<body\b/iu.test(source)) return source;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

/**
 * `og:site_name` names the site rather than the page, so it wins. A `<title>`
 * usually joins the name to a tagline ("Acme | Tools for builders",
 * "Acme: Tools for builders"); the
 * segment that matches the domain is the name, otherwise the first one that
 * is not a generic page label.
 */
export function organizationNameFromHtml(source: string, domain: string): string | null {
  const siteName = validName(normalizeHtmlText(htmlMetaContent(source, "property", "og:site_name") ?? ""));
  if (siteName) return siteName;
  const title = normalizeHtmlText(htmlElementText(source, "title") ?? "");
  const segments = title.split(/\s+[|·•–—-]\s+|:\s+/u).map((segment) => segment.trim()).filter(Boolean);
  const label = comparable(domain.split(".")[0]!);
  const matching = segments.find((segment) => {
    const candidate = comparable(segment);
    return candidate.length > 0 && (candidate.includes(label) || label.includes(candidate));
  });
  const chosen = matching ?? segments.find((segment) => !GENERIC_TITLE_SEGMENTS.has(segment.toLowerCase()));
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
