import { ARTIFACT_SERVER_ENTRY, ARTIFACT_STATIC_ENTRY } from "./artifacts";

/**
 * What a published site's files are, decided from the files alone, before any
 * sandbox starts: ready to serve as they are, a single React component in the
 * shape Claude's and ChatGPT's artifacts take, or a project that builds
 * itself. `docs/rally-mcp.md#building`.
 */
export type SiteSource =
  | { kind: "static" }
  | { kind: "component"; entry: string }
  | { kind: "project" }
  | { kind: "refused"; code: string; message: string };

/**
 * The libraries a component may import, which the build installs at pinned
 * versions (`TOOLCHAIN` in `apps/api/src/services/canvas-build/build.sandbox.mjs`
 * holds the versions; keep the two in step). An allowlist, not a number: a
 * component importing anything else is refused before a sandbox starts.
 */
export const COMPONENT_LIBRARIES = ["react", "react-dom", "lucide-react", "recharts", "lodash", "clsx", "tailwind-merge"] as const;

/** The shadcn/ui modules the build provides at `@/components/ui/*`, plus its `cn` helper. */
export const COMPONENT_UI_MODULES = ["card", "button", "badge", "input", "textarea", "label", "separator", "progress", "alert", "tabs"] as const;

const COMPONENT_EXTENSIONS = /\.(?:jsx|tsx)$/u;

/** Every module specifier a source imports, statically or dynamically. */
export function importedModules(source: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /\bimport\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/gu,
    /\bexport\s+[^'"]*?\s+from\s+["']([^"']+)["']/gu,
    /\bimport\(\s*["']([^"']+)["']\s*\)/gu,
    /\brequire\(\s*["']([^"']+)["']\s*\)/gu,
  ];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) found.add(match[1]!);
  return [...found];
}

/** The package a bare specifier names: `lodash/merge` is `lodash`, `@scope/pkg/x` is `@scope/pkg`. */
function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/** Why a component's imports cannot build, or null when every one is provided. */
export function unsupportedImport(source: string): string | null {
  for (const specifier of importedModules(source)) {
    if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
    if (specifier === "@/lib/utils") continue;
    if (specifier.startsWith("@/components/ui/")) {
      if ((COMPONENT_UI_MODULES as readonly string[]).includes(specifier.slice("@/components/ui/".length))) continue;
      return specifier;
    }
    if (specifier.startsWith("@/")) return specifier;
    if (!(COMPONENT_LIBRARIES as readonly string[]).includes(packageName(specifier))) return specifier;
  }
  return null;
}

/**
 * Decide what `files` are. `text` is a file's content when it is text, so a
 * component's imports and a project's scripts can be read; binary files pass
 * `null`.
 *
 * - A root `package.json` with a `build` script is a project, whatever else
 *   is there: its own build decides what it serves.
 * - A root `index.html` is a static site, as before.
 * - Otherwise one `.jsx` or `.tsx` file with a default export, at the root,
 *   is a component; other files beside it are its modules and assets.
 */
export function detectSiteSource(files: ReadonlyArray<{ path: string; text: string | null }>): SiteSource {
  const root = new Map(files.filter((file) => !file.path.includes("/")).map((file) => [file.path, file]));
  const manifest = root.get("package.json");
  if (manifest) {
    let scripts: unknown;
    try { scripts = (JSON.parse(manifest.text ?? "") as { scripts?: unknown }).scripts; } catch {
      return { kind: "refused", code: "canvas_build_manifest_invalid", message: "package.json is not valid JSON" };
    }
    if (scripts && typeof scripts === "object" && typeof (scripts as Record<string, unknown>).build === "string") return { kind: "project" };
    return { kind: "refused", code: "canvas_build_script_missing", message: "package.json has no build script; add one, or publish the built files with their index.html" };
  }
  if (root.has(ARTIFACT_STATIC_ENTRY)) {
    if (root.has(ARTIFACT_SERVER_ENTRY)) {
      return { kind: "refused", code: "canvas_build_server_module", message: `A site published here cannot carry a server module (${ARTIFACT_SERVER_ENTRY})` };
    }
    return { kind: "static" };
  }
  const components = [...root.values()].filter((file) => COMPONENT_EXTENSIONS.test(file.path)
    && file.text !== null && /\bexport\s+default\b/u.test(file.text));
  if (components.length === 1) {
    const entry = components[0]!;
    for (const file of files) {
      if (!/\.(?:jsx?|tsx?)$/u.test(file.path) || file.text === null) continue;
      const unsupported = unsupportedImport(file.text);
      if (unsupported) {
        return { kind: "refused", code: `canvas_build_unsupported_import:${unsupported.replace(/[^A-Za-z0-9@/._-]/gu, "_")}`,
          message: `${file.path} imports ${unsupported}, which a published component cannot use. It may use ${COMPONENT_LIBRARIES.join(", ")}, and shadcn/ui's ${COMPONENT_UI_MODULES.join(", ")}.` };
      }
    }
    return { kind: "component", entry: entry.path };
  }
  if (components.length > 1) {
    return { kind: "refused", code: "canvas_build_entry_ambiguous", message: `More than one component could be the page: ${components.map((file) => file.path).join(", ")}. Publish one, or add an index.html.` };
  }
  return { kind: "refused", code: "canvas_build_entry_missing",
    message: `Nothing here is a page: add an ${ARTIFACT_STATIC_ENTRY}, a React component with a default export, or a package.json with a build script` };
}
