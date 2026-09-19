import { safeRelativePath, TerminalToolError, type TerminalPatchOutput } from "./tools";
import APPLY_PATCH_SCRIPT from "./vendor/apply_patch.py";

/**
 * The two patch texts `apply_patch` accepts, and how each is read before the
 * sandbox sees it.
 *
 * A unified diff carries `---`/`+++` file headers and numbered `@@` hunks, and
 * `git apply` applies it. The other is the format OpenAI's models were trained
 * to emit for a tool of this name: a `*** Begin Patch` ... `*** End Patch`
 * envelope with `*** Add File:`, `*** Update File:` and `*** Delete File:`
 * sections whose hunks carry no line numbers and are placed by their context
 * lines. OpenAI's reference implementation applies that one; it is vendored
 * unmodified under `./vendor/` and written into the sandbox beside a patch
 * that needs it.
 *
 * Both parsers produce the tool's result shape and hold every path they name
 * to the rules every other Terminal path gets, before any provider I/O.
 * Neither decides whether a hunk applies: `git apply` and the reference
 * applier do, in the sandbox.
 */
export type TerminalPatchFormat = "unified" | "openai";

export const OPENAI_PATCH_BEGIN = "*** Begin Patch";
export const OPENAI_PATCH_END = "*** End Patch";

/**
 * SHA-256 of the vendored applier. A test pins the imported text to it, so a
 * copy that was edited, or re-vendored without updating this and the README,
 * fails the run rather than shipping.
 */
export const APPLY_PATCH_SCRIPT_SHA256 = "278dd0f644733d9575326b307f8bb8b0414bf04446e24671f2833db76c6a0adb";
export { APPLY_PATCH_SCRIPT };

/**
 * The first non-blank line decides. The envelope opener is a line a unified
 * diff cannot contain: hunk lines start with a space, `+`, `-` or `\`, and
 * file headers with `---`/`+++`. The only other diff format that opens with
 * `***`, a context diff, names a file and a timestamp there.
 */
export function detectPatchFormat(patch: string): TerminalPatchFormat {
  const first = patch.split("\n").find((line) => line.trim().length > 0);
  return first !== undefined && first.trimEnd() === OPENAI_PATCH_BEGIN ? "openai" : "unified";
}

type PatchFile = TerminalPatchOutput["files"][number];

export function parsePatch(patch: string): { format: TerminalPatchFormat; output: TerminalPatchOutput } {
  const format = detectPatchFormat(patch);
  return { format, output: format === "openai" ? parseOpenAiPatch(patch) : parseUnifiedPatch(patch) };
}

function finish(files: Map<string, PatchFile>, none: string): TerminalPatchOutput {
  if (files.size === 0) throw new TerminalToolError("patch_invalid", none);
  if (files.size > 100) throw new TerminalToolError("limit_exceeded", "A patch may change at most 100 files. Split it into smaller patches.");
  const outputFiles = [...files.values()];
  return {
    files: outputFiles,
    additions: outputFiles.reduce((total, file) => total + file.additions, 0),
    deletions: outputFiles.reduce((total, file) => total + file.deletions, 0),
  };
}

function parseUnifiedPatch(patch: string): TerminalPatchOutput {
  const files = new Map<string, PatchFile>();
  let current: PatchFile | undefined;
  for (const line of patch.split("\n")) {
    const header = /^(---|\+\+\+)\s+(.+?)(?:\t.*)?$/u.exec(line);
    let headerPath: string | undefined;
    if (header) {
      const rawPath = header[2]!;
      try {
        headerPath = rawPath.startsWith('"') ? JSON.parse(rawPath) as string : rawPath;
      } catch {
        throw new TerminalToolError("patch_invalid", "A patch file header is malformed. Regenerate the unified patch and retry.");
      }
      if (headerPath !== "/dev/null") headerPath = headerPath.replace(/^[ab]\//u, "");
    }
    if (header?.[1] === "---") {
      const oldPath = headerPath!;
      current = { path: oldPath, operation: "edited", additions: 0, deletions: 0 };
    } else if (header?.[1] === "+++") {
      const newPath = headerPath!;
      if (!current) throw new TerminalToolError("patch_invalid", "The patch is missing a --- file header. Regenerate a unified patch and retry.");
      if (newPath === "/dev/null") {
        current.operation = "deleted";
      } else if (current.path === "/dev/null") {
        current.path = newPath;
        current.operation = "created";
      } else if (current.path !== newPath) {
        current.previousPath = current.path;
        current.path = newPath;
        current.operation = "renamed";
      }
      // The same rules every `filePath` gets: no `/` prefix, `..`, `\` or NUL,
      // and `./` segments dropped, so the reported path is the file's own.
      current.path = safeRelativePath(current.path, "patch");
      files.set(current.path, current);
    } else if (current && line.startsWith("+") && !line.startsWith("+++")) {
      current.additions += 1;
    } else if (current && line.startsWith("-") && !line.startsWith("---")) {
      current.deletions += 1;
    }
  }
  return finish(files, "No file changes were found. Send a unified diff with --- and +++ headers, or a patch that opens with *** Begin Patch, and retry.");
}

/**
 * Reads the envelope the way the reference applier does, far enough to shape
 * the result and refuse what must never reach the sandbox. Line numbers in a
 * refusal count from the first line of the patch text.
 */
function parseOpenAiPatch(patch: string): TerminalPatchOutput {
  const lines = patch.split("\n");
  let start = 0;
  while (start < lines.length && lines[start]!.trim() === "") start += 1;
  let end = lines.length;
  while (end > start && lines[end - 1]!.trim() === "") end -= 1;
  if (lines[end - 1] !== OPENAI_PATCH_END) {
    throw new TerminalToolError("patch_invalid", `A patch that opens with \`${OPENAI_PATCH_BEGIN}\` must end with \`${OPENAI_PATCH_END}\`. Add the closing line and retry.`);
  }
  const files = new Map<string, PatchFile>();
  let current: PatchFile | null = null;
  let moveAllowed = false;
  // Typed explicitly so control flow narrows `current` past a call that never returns.
  const invalid: (line: number, what: string) => never = (line, what) => {
    throw new TerminalToolError("patch_invalid", `Line ${line} of the patch ${what}. Regenerate the patch and retry.`);
  };
  const section = (line: number, named: string, operation: PatchFile["operation"]): PatchFile => {
    if (!named) invalid(line, "names no file");
    const path = safeRelativePath(named, "patch");
    if (files.has(path)) invalid(line, "names a file the patch already changes");
    const file: PatchFile = { path, operation, additions: 0, deletions: 0 };
    files.set(path, file);
    return file;
  };
  for (let index = start + 1; index < end - 1; index += 1) {
    const line = lines[index]!;
    const number = index + 1;
    if (line.startsWith("*** Add File: ")) {
      current = section(number, line.slice("*** Add File: ".length), "created");
      moveAllowed = false;
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      current = section(number, line.slice("*** Update File: ".length), "edited");
      moveAllowed = true;
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      current = section(number, line.slice("*** Delete File: ".length), "deleted");
      moveAllowed = false;
      continue;
    }
    if (line.startsWith("*** Move to: ")) {
      if (!current || !moveAllowed) invalid(number, "moves a file anywhere but directly under its `*** Update File:` line");
      const named = line.slice("*** Move to: ".length);
      if (!named) invalid(number, "moves a file to no path");
      const target = safeRelativePath(named, "patch");
      if (files.has(target)) invalid(number, "moves a file onto one the patch already changes");
      const moved: PatchFile = { path: target, previousPath: current.path, operation: "renamed", additions: current.additions, deletions: current.deletions };
      files.delete(current.path);
      files.set(target, moved);
      current = moved;
      moveAllowed = false;
      continue;
    }
    moveAllowed = false;
    if (line === "*** End of File") continue;
    if (line.startsWith("***")) invalid(number, "is not a file section header");
    if (!current) invalid(number, "precedes the first file section");
    if (current.operation === "deleted") invalid(number, "follows a `*** Delete File:` section, which takes no lines");
    if (current.operation === "created") {
      if (!line.startsWith("+")) invalid(number, "is inside an `*** Add File:` section, where every line starts with `+`");
      current.additions += 1;
      continue;
    }
    if (line.startsWith("@@")) continue;
    if (line.startsWith("+")) {
      current.additions += 1;
      continue;
    }
    if (line.startsWith("-")) {
      current.deletions += 1;
      continue;
    }
    if (line.startsWith(" ") || line === "") continue;
    invalid(number, "is not a context, added, removed or `@@` line");
  }
  return finish(files, `No file sections were found between \`${OPENAI_PATCH_BEGIN}\` and \`${OPENAI_PATCH_END}\`. Add an \`*** Add File:\`, \`*** Update File:\` or \`*** Delete File:\` section and retry.`);
}
