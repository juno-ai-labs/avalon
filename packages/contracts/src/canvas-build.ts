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

/** What precedes a `/` that opens a regular expression rather than divides. */
const REGEX_AFTER_PUNCTUATION = new Set([..."(,=:[!&|?{};+-*%>~^"]);
const REGEX_AFTER_WORD = /\b(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/u;

/**
 * The source as code alone: comments become a space, and every string and
 * substitution-free template literal becomes a placeholder `"N"`, its value
 * kept at `strings[N]`. A template's `${…}` substitutions stay code.
 *
 * Hand-written rather than a parser, because the question is only "is this
 * quote a string or a comment's text". Single-quoted and double-quoted strings
 * and regular expressions end at a newline, as JavaScript requires, so the
 * apostrophe in a line of JSX text (`<p>Don't</p>`) misreads at most the rest
 * of its own line. `<` never opens a regular expression, so `</div>` is not one.
 */
function codeOnly(source: string): { code: string; strings: string[] } {
  const strings: string[] = [];
  let code = "";
  let index = 0;
  const placeholder = (value: string) => { code += `"${strings.length}"`; strings.push(value); };
  // A single- or double-quoted string, or a regular expression, from `index`
  // (its opening character) to its close or the end of its line.
  const quoted = (close: string): string => {
    let value = "";
    let inClass = false;
    for (index += 1; index < source.length; index += 1) {
      const character = source[index]!;
      if (character === "\n") return value;
      if (character === "\\") { value += source.slice(index, index + 2); index += 1; continue; }
      if (close === "/" && character === "[") inClass = true;
      else if (close === "/" && character === "]") inClass = false;
      else if (character === close && !inClass) { index += 1; return value; }
      value += character;
    }
    return value;
  };
  // A template literal from `index` (its backtick), with each substitution
  // scanned as code up to the brace that closes it.
  const template = () => {
    let value = "";
    let substituted = false;
    for (index += 1; index < source.length; index += 1) {
      const character = source[index]!;
      if (character === "\\") { value += source.slice(index, index + 2); index += 1; continue; }
      if (character === "`") { index += 1; break; }
      if (character === "$" && source[index + 1] === "{") {
        substituted = true;
        code += " ";
        index += 2;
        scan("}");
        code += " ";
        index -= 1;
        continue;
      }
      value += character;
    }
    if (!substituted) placeholder(value);
  };
  // Code from `index` to the end, or past the `until` that closes the
  // substitution it is in; `depth` counts the braces opened since.
  const scan = (until: string | null): void => {
    let depth = 0;
    while (index < source.length) {
      const character = source[index]!;
      const next = source[index + 1];
      if (until && character === until && depth === 0) { index += 1; return; }
      if (character === "{") depth += 1;
      else if (character === "}") depth -= 1;
      if (character === "/" && next === "/") {
        const end = source.indexOf("\n", index);
        index = end === -1 ? source.length : end;
        code += " ";
      } else if (character === "/" && next === "*") {
        const end = source.indexOf("*/", index + 2);
        index = end === -1 ? source.length : end + 2;
        code += " ";
      } else if (character === "'" || character === "\"") {
        placeholder(quoted(character));
      } else if (character === "`") {
        template();
      } else if (character === "/" && opensRegex(code)) {
        quoted("/");
        code += " ";
      } else {
        code += character;
        index += 1;
      }
    }
  };
  scan(null);
  return { code, strings };
}

function opensRegex(codeSoFar: string): boolean {
  const before = codeSoFar.trimEnd();
  return before.length === 0 || REGEX_AFTER_PUNCTUATION.has(before.at(-1)!) || REGEX_AFTER_WORD.test(before);
}

/**
 * Every module specifier a source imports, statically or dynamically.
 * Read from the code alone, so an import in a comment or a string is not one.
 */
export function importedModules(source: string): string[] {
  const { code, strings } = codeOnly(source);
  const found = new Set<string>();
  const patterns = [
    // Whitespace is optional around a module string: `import"x"` and
    // `from"x"` are as valid as their spaced forms, and esbuild bundles both.
    /\bimport\s*(?:[^"]*?\bfrom\s*)?"(\d+)"/gu,
    /\bexport\s*[^"]*?\bfrom\s*"(\d+)"/gu,
    /\bimport\s*\(\s*"(\d+)"\s*\)/gu,
    /\brequire\s*\(\s*"(\d+)"\s*\)/gu,
  ];
  for (const pattern of patterns) for (const match of code.matchAll(pattern)) found.add(strings[Number(match[1])]!);
  return [...found];
}

/** The package a bare specifier names: `lodash/merge` is `lodash`, `@scope/pkg/x` is `@scope/pkg`. */
function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/** Why a component's imports cannot build, or null when every one is provided. */
export function unsupportedImport(source: string, local?: { importer: string; paths: ReadonlySet<string> }): string | null {
  for (const specifier of importedModules(source)) {
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      if (local && !publishedFile(specifier, local.importer, local.paths)) return specifier;
      continue;
    }
    // A package's subpath never climbs: `lodash/../..` resolves out of the toolchain.
    if (specifier.split("/").some((segment) => segment === "." || segment === "..")) return specifier;
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

/** What esbuild tries for a local import with no extension, in its own order. */
const LOCAL_IMPORT_SUFFIXES = ["", ".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs", ".css", ".json",
  "/index.tsx", "/index.ts", "/index.jsx", "/index.js"];

/**
 * Whether a local import names one of the published files. The build bundles
 * whatever a local path resolves to on the sandbox's disk, which also holds
 * the Canvas's checkout and every participant's files, and the bundle is
 * served publicly; so an absolute path, a path that climbs above the
 * published root, or one that names nothing published is refused before any
 * sandbox starts.
 */
function publishedFile(specifier: string, importer: string, paths: ReadonlySet<string>): boolean {
  if (specifier.startsWith("/")) return false;
  const segments = importer.split("/").slice(0, -1);
  for (const segment of specifier.split(/[?#]/u)[0]!.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return false;
      segments.pop();
    } else segments.push(segment);
  }
  const resolved = segments.join("/");
  return LOCAL_IMPORT_SUFFIXES.some((suffix) => paths.has(`${resolved}${suffix}`));
}

/** The files a stylesheet asks esbuild to read: `@import` targets and `url()`s that are not data, a remote URL or a fragment. */
function stylesheetReferences(source: string): string[] {
  const references: string[] = [];
  for (const match of source.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)|url\(\s*["']?([^"')\s]+)/gu)) {
    const reference = match[1] ?? match[2]!;
    if (/^(?:data:|https?:|\/\/|#)/iu.test(reference)) continue;
    references.push(reference);
  }
  return references;
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
    const paths = new Set(files.map((file) => file.path));
    for (const file of files) {
      if (file.text === null) continue;
      if (/\.css$/u.test(file.path)) {
        const outside = stylesheetReferences(file.text).find((reference) => !publishedFile(reference, file.path, paths));
        if (outside) {
          return { kind: "refused", code: `canvas_build_unsupported_import:${outside.replace(/[^A-Za-z0-9@/._-]/gu, "_")}`,
            message: `${file.path} refers to ${outside}, which is not one of the published files. Refer to a file you publish with it by a path relative to the stylesheet.` };
        }
        continue;
      }
      if (!/\.(?:[cm]?jsx?|tsx?)$/u.test(file.path)) continue;
      const unsupported = unsupportedImport(file.text, { importer: file.path, paths });
      if (unsupported) {
        return { kind: "refused", code: `canvas_build_unsupported_import:${unsupported.replace(/[^A-Za-z0-9@/._-]/gu, "_")}`,
          message: /^[./]/u.test(unsupported)
            ? `${file.path} imports ${unsupported}, which is not one of the published files. Import a file you publish with it by a path relative to the importing file.`
            : `${file.path} imports ${unsupported}, which a published component cannot use. It may use ${COMPONENT_LIBRARIES.join(", ")}, and shadcn/ui's ${COMPONENT_UI_MODULES.join(", ")}.` };
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
