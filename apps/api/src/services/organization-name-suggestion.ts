import { WorkspaceNameSchema } from "@rally/contracts";

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
  const cached = await db.prepare("SELECT name, fetched_at FROM organization_name_suggestions WHERE domain = ?")
    .bind(domain).first<{ name: string | null; fetched_at: string }>();
  if (cached && now.getTime() - Date.parse(cached.fetched_at) < ORGANIZATION_NAME_SUGGESTION_TTL_MS) return cached.name;
  const name = await readOrganizationName(domain, fetcher);
  // An unreachable homepage is not an answer: caching it would hide the name
  // for thirty days because of one bad minute.
  if (name === undefined) return cached?.name ?? null;
  await db.prepare(`INSERT INTO organization_name_suggestions (domain, name, fetched_at) VALUES (?, ?, ?)
    ON CONFLICT(domain) DO UPDATE SET name = excluded.name, fetched_at = excluded.fetched_at`)
    .bind(domain, name, now.toISOString()).run();
  return name;
}

/**
 * The name the domain's homepage gives, null when it answered but named
 * nothing usable, and undefined when it could not be read at all.
 */
async function readOrganizationName(domain: string, fetcher: typeof fetch): Promise<string | null | undefined> {
  const url = `https://${domain}/`;
  try {
    assertSafePublicUrl(url);
    const response = await fetcher(url, {
      headers: { Accept: "text/html" },
      redirect: "follow",
    });
    if (response.status >= 500) return undefined;
    if (!response.ok || !response.body) return null;
    if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("html")) return null;
    return organizationNameFromHtml(await readHead(response.body), domain);
  } catch {
    return undefined;
  }
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
