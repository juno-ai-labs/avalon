/**
 * What a published *directory* becomes, decided by what the model wrote.
 *
 * `publish_resource` widens to accept a directory, and gains no
 * parameter for what to do with it. The kind is resolved from the directory's
 * root entry alone, because a parameter restating what the files already say is
 * a parameter that can disagree with them — and the disagreement would be
 * invisible until serve time.
 *
 * ```
 * root index.js   → active site  (Rally executes it per request)
 * root index.html → static site  (assets only)
 * neither         → archive      (one downloadable zip)
 * ```
 *
 * The archive branch is what makes publishing a directory *total*: a folder of
 * generated outputs becomes one download rather than an error, which is also
 * how "zip that folder up for me" becomes a single call. It has exactly one
 * deliberate exception, `single_file_directory`, and the reason is in
 * {@link resolveDirectoryPublish}.
 *
 * See `docs/live-web-artifacts.md`.
 */
import {
  ARTIFACT_SERVER_ENTRY,
  ARTIFACT_STATIC_ENTRY,
  ARTIFACT_STORAGE_CLASS_NAME,
  type ArtifactMode,
} from "@rally/contracts";
import { zipSync } from "fflate";

import { TerminalToolError } from "./tools";

/** One file found beneath a published directory. */
export interface DirectoryEntry {
  /** Directory-relative, `/`-separated, no leading slash. */
  path: string;
  sizeBytes: number;
  sha256: string;
}

export type DirectoryPublishKind =
  | { kind: "site"; mode: ArtifactMode; entryPath: string }
  | { kind: "archive" };

/**
 * Decide what a directory publishes as, or refuse the one shape that is almost
 * always a mistake.
 *
 * **`index.js` wins over `index.html`** because a site with server behavior
 * almost always ships both — the module routes its own paths and falls through
 * to the page — so the module's presence is the stronger signal, not a tie.
 *
 * **A directory on the archive branch holding exactly one file is refused.**
 * The archive fallback trades a sliver of fail-loud for totality, and that
 * trade is right for a genuine bundle and wrong here: a one-file zip is almost
 * never deliberate, and it is near-exactly the shape of a document publish that
 * grabbed the folder by mistake. Before this widening that mistake was a hard
 * error; without this refusal it would become a success-shaped wrong outcome —
 * a zip in the rail where the announced document should be, durable under its
 * own identity — and the models Rally routes to for cost under-read successful
 * results, so they would not notice. A one-file directory whose file *is* an
 * entry never reaches this branch: `launch-checklist/index.html` alone is an
 * ordinary static site.
 */
export function resolveDirectoryPublish(entries: readonly DirectoryEntry[]): DirectoryPublishKind {
  if (entries.some((entry) => entry.path === ".rally" || entry.path.startsWith(".rally/"))) {
    throw new TerminalToolError(
      "reserved_site_path",
      "The .rally directory is reserved for Rally-generated site files. Move authored files outside it and publish the directory again.",
      { field: "filePath", reason: "Move authored files outside the reserved .rally directory." },
    );
  }
  if (entries.some((entry) => entry.path === ARTIFACT_SERVER_ENTRY)) {
    return { kind: "site", mode: "active", entryPath: ARTIFACT_SERVER_ENTRY };
  }
  if (entries.some((entry) => entry.path === ARTIFACT_STATIC_ENTRY)) {
    return { kind: "site", mode: "static", entryPath: ARTIFACT_STATIC_ENTRY };
  }
  if (entries.length === 1) {
    throw new TerminalToolError(
      "single_file_directory",
      `This directory holds one file and no site entry. Publish that file's own path to publish it as a document, or name it ${ARTIFACT_STATIC_ENTRY} to publish a static site; a directory publishes as a zip only when bundling multiple files.`,
      { field: "filePath", reason: "Publish the file's own path, or add a site entry file." },
    );
  }
  return { kind: "archive" };
}

/**
 * Whether a server module exports the storage class, and therefore gets a
 * database.
 *
 * A source-text check rather than an import, because publish never executes
 * artifact code — `index.js` runs at serve time and nowhere else. So this
 * cannot be a promise about what the module *does*; it is a promise about what
 * Rally will *try*. A module that matches gets a facet whose class must resolve
 * when it loads; one that does not is a stateless active site, which is a
 * working outcome rather than an error.
 *
 * Being wrong in the false-negative direction costs a site its storage and
 * shows up immediately at serve time as `SiteData is not defined`. Being wrong
 * the other way costs a facet nobody writes to. Neither is silent, which is why
 * a regex is enough here and a parser would be machinery for a decision the
 * serving side re-checks anyway.
 */
export function declaresStorageClass(source: string): boolean {
  // `export class SiteData`, `export { SiteData }`, and
  // `class SiteData …; export { SiteData as default }` all count. Comments are
  // not stripped: a commented-out export that produces a facet whose class
  // fails to load is a loud serve-time error, which is the safer direction.
  const declaration = new RegExp(
    String.raw`\bexport\s+(?:default\s+)?class\s+${ARTIFACT_STORAGE_CLASS_NAME}\b`,
    "u",
  );
  const named = new RegExp(
    String.raw`\bexport\s*\{[^}]*\b${ARTIFACT_STORAGE_CLASS_NAME}\b[^}]*\}`,
    "u",
  );
  return declaration.test(source) || named.test(source);
}

/**
 * The content type stored for one published asset.
 *
 * Decided here, once, at publish, and written into the manifest — the serving
 * Worker holds no MIME machinery, and a type that could differ between requests
 * for identical bytes is a type no cache may be given a long TTL against.
 *
 * The table is deliberately small and closed. Anything outside it is served as
 * `application/octet-stream`, which downloads rather than renders: an unknown
 * extension guessed *into* a rendering type is how model-authored bytes get
 * interpreted as something they are not, and this is untrusted content on an
 * origin whose whole job is to contain it.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  webm: "video/webm",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  pdf: "application/pdf",
  xml: "application/xml",
  wasm: "application/wasm",
});

export function assetContentType(path: string): string {
  const name = path.split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "application/octet-stream";
  return CONTENT_TYPES[name.slice(dot + 1).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Bundle a directory into one zip, Rally-side.
 *
 * **Zip rather than tar.gz**, and the reason is the recipient rather than the
 * writer. Rally's ideal customer is nontechnical, and a zip double-clicks open
 * on macOS and Windows with nothing to install or look up. `tar.gz` is the
 * engineer's default and the cheaper streaming write, and both advantages lose
 * to the person receiving it not knowing what to do with the file.
 *
 * The model never bundles its own archive: the sandbox holds no path to the
 * bucket, so the bytes have to come back here regardless, and a tool that asked
 * the model to `tar` first would be a step it could get wrong for no gain.
 */
/** 1980-01-01 local calendar time, the earliest DOS timestamp a zip can hold. */
const ZIP_EPOCH = new Date(1980, 0, 1);

export function bundleArchive(files: readonly { path: string; bytes: Uint8Array }[]): Uint8Array {
  const tree: Record<string, Uint8Array> = {};
  for (const file of files) tree[file.path] = file.bytes;
  // `mtime` is deliberately fixed: a zip whose bytes changed only because the
  // clock moved would defeat the equal-content republish check, which is what
  // absorbs a replayed call and what keeps an unchanged republish from minting
  // a version nobody asked for. It is the zip format's own epoch rather than
  // Unix's — a DOS timestamp cannot represent anything before 1980, and `0`
  // throws rather than clamping.
  return zipSync(tree, { mtime: ZIP_EPOCH });
}

/**
 * A republish is never allowed to silently downgrade a live site to an archive.
 *
 * Kind transitions across republishes of one path are asymmetric by rule:
 * archive→site upgrades freely, because a folder that grew an entry file is
 * exactly the recovery the archive fallback is designed to leave open. The
 * other direction fails loudly — a URL participants hold is never killed by an
 * accident of file layout, and a rename that dropped `index.js` would otherwise
 * do it without anyone being told.
 */
export function assertKindTransitionAllowed(
  previous: "site" | "archive" | "file" | null,
  next: DirectoryPublishKind["kind"],
): void {
  if (previous !== "site" || next === "site") return;
  throw new TerminalToolError(
    "site_entry_removed",
    `This path serves a live site and the republish has no ${ARTIFACT_SERVER_ENTRY} or ${ARTIFACT_STATIC_ENTRY} at its root. Restore an entry file, or publish the files under a different path.`,
    { field: "filePath", reason: "Restore the site entry file, or publish under a different path." },
  );
}
