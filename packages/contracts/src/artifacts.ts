import { regions, regionConfiguration } from "./regions";
import type { Region } from "@rally/contracts/regions";
import { RegionSchema } from "@rally/contracts/regions";
/**
 * Live web artifacts: the shapes both sides of the artifact boundary agree on.
 *
 * A live artifact is a directory a run published — a page, a dashboard, a poll —
 * that Rally serves from an isolated per-artifact origin. Three parties read
 * what is here and none may import another: `apps/api` writes the manifest at
 * publish, the serving Worker reads it on every request, and the desktop
 * renderer resolves the canonical URL for the rail. So the manifest schema, the
 * MIME type that identifies it, and the hostname derivation live in contracts,
 * parsed on both sides rather than trusted across.
 *
 * See `docs/live-web-artifacts.md` for the subsystem and
 * `docs/PRDs/2026-08-29_live-web-artifacts/prd.md` for why it is shaped this
 * way.
 */
import { z } from "zod";

import { RALLY_HEADERS } from "./http-headers";
import { ArtifactIdSchema } from "./identifiers";

/**
 * The MIME type of a site resource's stored content.
 *
 * A site's `content_ref` points at its *manifest*, not at any one page, so the
 * resource's type has to name the manifest. It is deliberately precise rather
 * than familiar: `text/html` would route a site into single-document read paths
 * and converters that would then serve one page as though it were the resource,
 * and `application/zip` would make a site indistinguishable from an archive
 * publish, whose behavior is the opposite. An unrecognized precise type fails
 * closed into the `other` attachment kind; a familiar wrong one fails open into
 * a converter, which is the direction that corrupts.
 *
 * The brand word is `rally` rather than `avalon`: this identifier is stored
 * forever on every site resource ever published, and a new one carries the
 * product's real name rather than joining the rebrand inventory's someday list.
 */
export const SITE_MANIFEST_MIME_TYPE = "application/vnd.rally.site-manifest+json";

/** What a published directory resolved to, decided by its root entry alone. */
export const ArtifactModeSchema = z.enum(["static", "active"]);
export type ArtifactMode = z.infer<typeof ArtifactModeSchema>;

/**
 * The entry file that decides an artifact's mode, in precedence order.
 *
 * `index.js` wins over `index.html` because a site with server behavior almost
 * always ships both — the module routes its own paths and falls through to the
 * page — so the presence of the module is the stronger signal.
 */
export const ARTIFACT_SERVER_ENTRY = "index.js";
export const ARTIFACT_STATIC_ENTRY = "index.html";

/**
 * The class name a stateful artifact exports to get a database.
 *
 * Fixed rather than configurable, and fixed at a name a model will reach for
 * without being told twice. Rally's bootstrap module imports exactly this
 * binding from the published `index.js`; a site that exports something else is
 * a stateless active site, which is a working outcome rather than an error.
 */
export const ARTIFACT_STORAGE_CLASS_NAME = "SiteData";

/**
 * The column that makes a stateful site's table **private to each viewer**.
 *
 * A convention rather than a declaration because a stateful site has no
 * manifest field for its schema: the model writes `CREATE TABLE` in its own
 * class. The name states its effect rather than its content, so a model
 * choosing it knows it is making rows private, and a model that never read
 * the rule does not type it by accident; a generic name like `viewer_id`
 * failed both ways. A table without it is shared, and every reader sees all
 * its rows. Shared here so the skills that teach it and the reads that filter
 * on it cannot drift apart.
 */
export const ARTIFACT_VIEWER_COLUMN = "private_to_viewer";

/**
 * The path prefix the server module never sees.
 *
 * Everything Rally serves on an artifact's own origin that is *not* artifact
 * content lives under here: the access bootstrap, the redeem endpoint, and the
 * prior-version mounts. Reserving one prefix is what lets a version render at a
 * URL on the artifact's own origin without a second origin, a second cookie, or
 * a second access flow — and the serving Worker strips it before forwarding, so
 * a frozen module routes on the paths it was written against.
 */
export const ARTIFACT_RESERVED_PREFIX = "/__rally";

/**
 * The site's own sign-in entry: `/__rally/sign-in?return=<path>`.
 *
 * Served by the artifact Worker before any hostname lookup, so it is the same
 * answer for every host and says nothing about what exists. It sends the
 * person to the browser client's site-opening page, which signs them in if
 * needed and opens the site back at `return`.
 */
export const ARTIFACT_SIGN_IN_PATH = `${ARTIFACT_RESERVED_PREFIX}/sign-in`;

/**
 * Reduce a caller-supplied return target to a path on this site.
 *
 * Anything that is not a plain same-origin path, or that points back into
 * Rally's reserved prefix, becomes `/`: the value arrives in a URL anyone can
 * craft, and following it anywhere else would make every artifact host an
 * open redirect.
 */
export function artifactReturnPath(raw: string | null | undefined): string {
  // A backslash reads as a slash to a browser, and a control character can
  // split a header; neither belongs in a path worth returning to.
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")
    || [...raw].some((character) => character === "\\" || character.charCodeAt(0) < 0x20)) return "/";
  let parsed: URL;
  try { parsed = new URL(raw, "https://artifact.invalid"); } catch { return "/"; }
  // Checked again after parsing: `/a/..//evil.example` normalizes to a path
  // that starts with `//`, which a browser follows to another host.
  if (parsed.origin !== "https://artifact.invalid" || parsed.pathname.startsWith("//")) return "/";
  // A prior version's mount is a page of the site; every other reserved path
  // is Rally's own and would loop back into sign-in.
  const priorVersion = new RegExp(`^${ARTIFACT_RESERVED_PREFIX}/v[0-9]+(/|$)`, "u").test(parsed.pathname);
  if (!priorVersion && (parsed.pathname === ARTIFACT_RESERVED_PREFIX || parsed.pathname.startsWith(`${ARTIFACT_RESERVED_PREFIX}/`))) return "/";
  return `${parsed.pathname}${parsed.search}`;
}

/**
 * The browser client's page that signs a person in and opens a site:
 * `/app/sites/<region>/<hostname stub>/<return path, encoded as one segment>`.
 *
 * Under `/app/` because the browser client's sign-in carries an `/app/` path
 * through email and Google and lands back on it; it carries only the path,
 * which is why the return path, query included, is one encoded segment.
 */
export function artifactSiteOpenPath(region: string, hostnameStub: string, returnPath: string): string {
  return `/app/sites/${encodeURIComponent(region)}/${encodeURIComponent(hostnameStub)}/${encodeURIComponent(artifactReturnPath(returnPath))}`;
}

/** The parts of an `artifactSiteOpenPath`, or `null` for any other path. */
export function parseArtifactSiteOpenPath(pathname: string): { region: string; hostnameStub: string; returnPath: string } | null {
  const match = /^\/app\/sites\/([^/]+)\/([^/]+)(?:\/([^/]*))?$/u.exec(pathname);
  if (!match) return null;
  try {
    const hostnameStub = decodeURIComponent(match[2]!);
    if (!ArtifactHostnameStubSchema.safeParse(hostnameStub).success) return null;
    return {
      region: decodeURIComponent(match[1]!),
      hostnameStub,
      returnPath: artifactReturnPath(match[3] ? decodeURIComponent(match[3]) : "/"),
    };
  } catch {
    return null;
  }
}

/**
 * The viewer identity an authenticated Rally request carries into artifact code.
 *
 * Product headers are minted `x-rally-*` and read through `readRallyHeader`
 * (see `http-headers.ts`); these two join that family rather than inventing a
 * spelling beside it. They are injected by the serving side after the session
 * check and after every inbound header of these names — canonical *and*
 * superseded — has been stripped, which is the entire anti-spoof mechanism.
 * Public requests carry neither header.
 *
 * Absence, not a sentinel, represents an anonymous viewer. `null` from
 * `headers.get` is the most pretrained idiom there is and the natural falsy
 * check a model writes handles it; a `"null"` string would be truthy and would
 * leak the literal word into stored data, and an empty value behaves
 * inconsistently across clients.
 */
export const ARTIFACT_VIEWER_ID_HEADER = RALLY_HEADERS.VIEWER_ID;
export const ARTIFACT_VIEWER_NAME_HEADER = RALLY_HEADERS.VIEWER_NAME;

/**
 * One published file, as the serving Worker resolves a request against it.
 *
 * `contentType` is decided at publish from the file's own name and bytes and
 * stored, rather than sniffed per request: the serving Worker holds no MIME
 * machinery, and a type that could change between requests for identical bytes
 * is a type a cache cannot be given a long TTL against.
 */
export const ArtifactManifestEntrySchema = z.strictObject({
  /** Directory-relative, `/`-separated, no leading slash. */
  path: z.string().min(1).max(1_024),
  contentType: z.string().min(1).max(160),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
});
export type ArtifactManifestEntry = z.infer<typeof ArtifactManifestEntrySchema>;

/** Existing manifest ceiling; publishers reserve one slot for derived assets. */
export const ARTIFACT_MAX_ASSET_COUNT = 10_000;

/** Normalized metadata Rally can inject into a site's HTML response. */
export const ArtifactSocialPreviewSchema = z.strictObject({
  title: z.string().min(1).max(300),
  description: z.string().min(1).max(500),
  image: z.strictObject({
    /** A published, directory-relative image asset. */
    path: z.string().min(1).max(1_024),
    contentType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    alt: z.string().min(1).max(500),
    /** Rally generated this asset, so source import must leave it behind. */
    generated: z.boolean(),
  }),
});
export type ArtifactSocialPreview = z.infer<typeof ArtifactSocialPreviewSchema>;

/**
 * The whole of what one version of an artifact is.
 *
 * Written once at publish under a version-immutable key and never edited, which
 * is what makes a long asset cache TTL safe and what lets a prior version be
 * served by reading an older manifest rather than by reconstructing anything.
 *
 * `assets` deliberately excludes the server module: `index.js` is *module, not
 * asset*, so a request for `/index.js` on an active artifact resolves against
 * nothing and 404s. No secret can be in it — the sandbox guarantees that — but
 * serving a site's source to its viewers is surface nobody asked for.
 */
export const ArtifactManifestSchema = z.strictObject({
  version: z.literal(1),
  artifactId: ArtifactIdSchema,
  artifactVersion: z.number().int().positive(),
  mode: ArtifactModeSchema,
  /** Whether the module exports the storage class, so the facet is run. */
  stateful: z.boolean(),
  /** Present when `mode` is `active`; the module's own digest. */
  serverModuleSha256: z.string().regex(/^[0-9a-f]{64}$/u).nullable(),
  assets: z.array(ArtifactManifestEntrySchema).max(ARTIFACT_MAX_ASSET_COUNT),
  /** Present on versions published after automatic social previews shipped. */
  socialPreview: ArtifactSocialPreviewSchema.optional(),
  totalBytes: z.number().int().nonnegative(),
  publishedAt: z.string().datetime({ offset: true }),
});
export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;

/**
 * Where a version's bytes live in the region's payload bucket.
 *
 * Version-immutable by construction: nothing ever overwrites a key here, so a
 * republish writes a new prefix and the old one stays readable for as long as a
 * version row names it.
 */
export function artifactAssetKey(artifactId: string, version: number, path: string): string {
  return `artifact/${artifactId}/v${version}/assets/${path}`;
}

export function artifactManifestKey(artifactId: string, version: number): string {
  return `artifact/${artifactId}/v${version}/manifest.json`;
}

/**
 * The isolate identity the Worker Loader caches a materialized artifact under.
 *
 * Version-scoped, so a republish that changed content mints a new isolate while
 * an unchanged republish reuses the warm one — which is exactly the caching
 * contract `LOADER.get` documents, expressed in the key rather than managed.
 */
export function artifactIsolateId(artifactId: string, version: number): string {
  return `artifact:${artifactId}:v${version}`;
}



/**
 * The public, non-authoritative label one artifact origin carries.
 *
 * It uses the same frozen four-word vocabulary as work-stream addresses and
 * resource aliases. The regional allocator reserves it before publication;
 * this parser only establishes the wire shape.
 */
export const ArtifactHostnameStubSchema = z.string()
  .regex(/^[a-z]+-[a-z]+-[a-z]+-[a-z]+$/u)
  .brand<"ArtifactHostnameStub">();
export type ArtifactHostnameStub = z.infer<typeof ArtifactHostnameStubSchema>;

export const ArtifactHostnameRouteSchema = z.strictObject({
  version: z.literal(1),
  hostnameStub: ArtifactHostnameStubSchema,
  artifactId: ArtifactIdSchema,
  region: RegionSchema,
});
export type ArtifactHostnameRoute = z.infer<typeof ArtifactHostnameRouteSchema>;

/**
 * The artifact's hostname label, and the whole of its address.
 *
 * **The region rides inside the label rather than as its own dotted segment.**
 * Cloudflare's Universal SSL covers the apex and a *single* subdomain level, so
 * `*.rallyusercontent.com` is certificated for free while `*.g.…` — two labels
 * deep — is not, and would fail the TLS handshake on every artifact open until
 * Advanced Certificate Manager was bought and configured. Flattening keeps one
 * wildcard per zone and costs nothing recurring.
 *
 * The label is a permanently reserved, human-readable stub. The serving Worker
 * resolves it through the content-free platform D1 database to the artifact UUID, which
 * remains the supervisor object's identity. Legacy UUID labels keep parsing so
 * existing bookmarks remain valid while newly opened artifacts use the stub.
 */
export function artifactHostLabel(hostnameStub: ArtifactHostnameStub, region: Region): string {
  return `${hostnameStub}-${regionConfiguration(region).artifactSuffix}`;
}

export function artifactOrigin(hostnameStub: ArtifactHostnameStub, region: Region, domain: string): string {
  return `https://${artifactHostLabel(hostnameStub, region)}.${domain}`;
}

const STUB_HOST_LABEL_PATTERN = /^([a-z]+-[a-z]+-[a-z]+-[a-z]+)$/u;
const LEGACY_HOST_LABEL_PATTERN
  = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u;

/**
 * Recover the artifact and region a request's `Host` names, or `null`.
 *
 * Total and parsing-only: it never throws and never reaches a database, because
 * it runs on the serving Worker's hot path before anything is authorized. A
 * host that does not match is not an artifact request, which the caller answers
 * with the neutral page rather than an error naming what it expected.
 */
export function parseArtifactHost(
  host: string,
): {
  hostnameStub: ArtifactHostnameStub | null;
  legacyArtifactId: string | null;
  region: Region;
} | null {
  const label = host.trim().toLowerCase().split(":")[0]?.split(".")[0] ?? "";
  const suffix = Object.entries(regions).find(([, config]) => label.endsWith(`-${config.artifactSuffix}`));
  if (!suffix) return null;
  const region = suffix[0];
  const stubLabel = label.slice(0, -(suffix[1].artifactSuffix.length + 1));
  const stub = STUB_HOST_LABEL_PATTERN.exec(stubLabel);
  if (stub?.[1]) {
    const hostnameStub = ArtifactHostnameStubSchema.safeParse(stub[1]);
    if (!hostnameStub.success) return null;
    return {
      hostnameStub: hostnameStub.data,
      legacyArtifactId: null,
      region,
    };
  }
  const legacy = LEGACY_HOST_LABEL_PATTERN.exec(stubLabel);
  if (!legacy?.[1]) return null;
  const artifactId = ArtifactIdSchema.safeParse(legacy[1]);
  if (!artifactId.success) return null;
  return {
    hostnameStub: null,
    legacyArtifactId: artifactId.data,
    region,
  };
}
