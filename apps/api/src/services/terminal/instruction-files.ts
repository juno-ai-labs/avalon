import {
  MAX_RESIDENT_CONTEXT_BLOCK_BYTES,
  truncateOnCodePoints,
} from "../resident-context/blocks";

/**
 * Discovery of a checkout's own working instructions.
 *
 * Two primitives live here, both free of sandbox knowledge: the chain of
 * candidate instruction-file paths a set of touched paths implies, and the
 * probe script the Terminal runtime appends to a sandbox command to report
 * which candidates exist, at what content. Reading the results back and
 * recording them is the runtime's job; deciding what to do with a block is the
 * ledger's.
 *
 * Design: `docs/PRDs/2026-09-08_repository-instruction-files/prd.md`.
 */

/** The file names that count as an instruction file, tried at every level. */
export const INSTRUCTION_FILE_NAMES = ["AGENTS.md"] as const;

/**
 * Directories Rally owns inside the work space. Nothing beneath them is
 * repository content, so no instruction file is looked for there.
 */
const RALLY_OWNED_DIRECTORIES = new Set([".rally", ".rally-output", ".git"]);

/**
 * The candidate instruction-file paths for a set of touched paths, relative to
 * the work-space root, root first and leaf last, each once.
 *
 * The chain for `apps/api/src/file.ts` is `AGENTS.md`, `apps/AGENTS.md`,
 * `apps/api/AGENTS.md`, `apps/api/src/AGENTS.md`. The root is the first
 * candidate of every chain, so a call with no touched path still probes it. A
 * touched path is the file or directory a tool addressed; it is never walked.
 */
export function instructionFileCandidates(touchedPaths: readonly string[]): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const push = (directory: string) => {
    for (const name of INSTRUCTION_FILE_NAMES) {
      const candidate = directory ? `${directory}/${name}` : name;
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      ordered.push(candidate);
    }
  };
  push("");
  for (const touched of touchedPaths) {
    const segments = touched.split("/").filter((segment) => segment.length > 0 && segment !== ".");
    if (segments.some((segment) => segment === "..")) continue;
    if (segments.length > 0 && RALLY_OWNED_DIRECTORIES.has(segments[0]!)) continue;
    // A touched path names a file or a directory; the probe decides which by
    // looking. Treat every prefix as a directory candidate, including the whole
    // path: for a directory that is its own level, and for a file it is a
    // candidate the probe reports absent.
    for (let depth = 1; depth <= segments.length; depth += 1) {
      push(segments.slice(0, depth).join("/"));
    }
  }
  return ordered;
}

/** The prefix every probe marker carries; the rest is a per-invocation nonce. */
export const INSTRUCTION_PROBE_MARKER_PREFIX = "__RALLY_INSTRUCTION_PROBE_";

/**
 * A fresh marker for one probe invocation, printed by the probe before its JSON
 * and handed to the parser that splits the trailer off.
 *
 * Everything before the trailer on stdout is untrusted (a file's content, a
 * command's output) and may contain any fixed string, so a fixed marker would
 * let a repository truncate a tool's output or hide a real trailer behind a
 * planted one. A marker the repository cannot know matches only what the probe
 * printed.
 */
export function instructionProbeMarker(): string {
  return `${INSTRUCTION_PROBE_MARKER_PREFIX}${crypto.randomUUID().replace(/-/gu, "")}__`;
}

/** The exit status the probe uses to stop a mutation whose instructions are not resident. */
export const INSTRUCTIONS_PENDING_EXIT_CODE = 52;

export type InstructionProbeMode = "report" | "abort";

export interface InstructionProbeEntry {
  /** Relative to the work-space root. */
  path: string;
  /** SHA-256 of the file's bytes, or `unreadable:<reason>` when it could not be read. */
  sha256: string;
  bytes: number;
  /** Absent when the block was already resident (the probe sends no content twice). */
  content?: string;
  truncated: boolean;
  /** Set when the file exists but is not a regular, contained, UTF-8 file. */
  status?: string;
  /** The caller said this content is already resident; nothing to deliver. */
  resident: boolean;
}

export interface InstructionProbeResult {
  entries: InstructionProbeEntry[];
  /** Whether any entry is not resident; in abort mode this is why the command stopped. */
  pending: boolean;
}

/**
 * The probe. Arguments: `root mode max_bytes known_json marker candidate...`.
 *
 * For each candidate beneath the root it refuses a symlink or a non-regular
 * file, refuses a real path that escapes the root, hashes the bytes, refuses a
 * file that is not valid UTF-8 whatever its size, and, when `<path>@<sha>` is
 * not in the caller's known-resident list, reports the content (cut on a
 * code-point boundary at or below `max_bytes`, where 0 means no cut).
 * It prints the marker it was given followed by one JSON object on the same
 * line, and in `abort` mode
 * exits 52 when any candidate is not resident so the enclosing command stops
 * before it mutates anything. Every other failure exits 0 with what it has: the
 * probe is best-effort and never decides a tool's own outcome.
 */
export const TERMINAL_INSTRUCTION_PROBE_PYTHON = [
  "import hashlib, json, os, sys",
  "root, mode, max_bytes, known, marker, candidates = os.path.realpath(sys.argv[1]), sys.argv[2], int(sys.argv[3]), set(json.loads(sys.argv[4])), sys.argv[5], sys.argv[6:]",
  "entries, pending = [], False",
  "def cut(data, limit):",
  "    text = data.decode('utf-8')",
  "    if limit <= 0 or len(data) <= limit: return text, False",
  "    return data[:limit].decode('utf-8', 'ignore'), True",
  "for rel in candidates:",
  "    path = os.path.join(root, rel)",
  "    if not os.path.lexists(path): continue",
  "    entry = {'path': rel, 'bytes': 0, 'truncated': False, 'resident': False}",
  "    if os.path.islink(path) or not os.path.isfile(path): entry['status'] = 'not a regular file'",
  "    elif os.path.commonpath([root, os.path.realpath(path)]) != root: entry['status'] = 'not a regular file'",
  "    if 'status' in entry:",
  "        entry['sha256'] = 'unreadable:' + entry['status']",
  "    else:",
  "        try:",
  "            data = open(path, 'rb').read()",
  "            entry['bytes'] = len(data)",
  "            entry['sha256'] = hashlib.sha256(data).hexdigest()",
  "            try: text, truncated = cut(data, max_bytes)",
  "            except UnicodeDecodeError: entry['status'] = 'not valid UTF-8'; entry['sha256'] = 'unreadable:not valid UTF-8'",
  "        except OSError: entry['status'] = 'unreadable'; entry['sha256'] = 'unreadable:unreadable'",
  "    key = rel + '@' + entry['sha256']",
  "    if key in known: entry['resident'] = True",
  "    elif 'status' not in entry: entry['content'] = text; entry['truncated'] = truncated",
  "    if not entry['resident']: pending = True",
  "    entries.append(entry)",
  "print(marker + json.dumps({'entries': entries, 'pending': pending}, ensure_ascii=False, separators=(',', ':')))",
  `sys.exit(${INSTRUCTIONS_PENDING_EXIT_CODE} if mode == 'abort' and pending else 0)`,
].join("\n");

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

/**
 * The shell fragment a Terminal command carries to run the probe.
 *
 * Isolated from the enclosing command's exit status: it runs in a subshell that
 * resets `set +e`, and only the pending exit code (52) is allowed to escape, in
 * `abort` mode, so a probe that fails for any other reason leaves the tool's own
 * outcome alone. The bootstrap command runs under `set -euo pipefail`, which is
 * why the isolation is here rather than assumed.
 */
export function instructionProbeFragment(input: {
  root: string;
  mode: InstructionProbeMode;
  candidates: readonly string[];
  knownResident: readonly string[];
  /** From `instructionProbeMarker()`; the same value goes to `splitInstructionProbeTrailer`. */
  marker: string;
  maxBytes?: number;
}): string {
  const maxBytes = input.maxBytes ?? MAX_RESIDENT_CONTEXT_BLOCK_BYTES;
  const args = [
    input.root,
    input.mode,
    String(Number.isFinite(maxBytes) ? maxBytes : 0),
    JSON.stringify(input.knownResident),
    input.marker,
    ...input.candidates,
  ].map(shellQuote).join(" ");
  const invoke = `python3 -c ${shellQuote(TERMINAL_INSTRUCTION_PROBE_PYTHON)} ${args}`;
  return input.mode === "abort"
    ? `( set +e; ${invoke}; s=$?; [ "$s" -eq ${INSTRUCTIONS_PENDING_EXIT_CODE} ] && exit ${INSTRUCTIONS_PENDING_EXIT_CODE}; exit 0 ) || exit $?`
    : `( set +e; ${invoke} ) || true`;
}

/**
 * Split a probe trailer off a command's stdout, given the marker that probe
 * invocation was told to print.
 *
 * The tool's own stdout comes back without the marker line; a stdout with no
 * marker (a probe that never ran or failed) comes back whole with `probe: null`.
 * Content is re-cut in TypeScript against the same bound the probe was given,
 * so an open bound stays inert here and a finite one holds even if the probe's
 * cut and this one ever disagreed.
 */
export function splitInstructionProbeTrailer(stdout: string, marker: string): { stdout: string; probe: InstructionProbeResult | null } {
  // The marker is searched for anywhere, not only at a line start: a tool
  // whose own output ends without a newline would otherwise glue the trailer
  // onto its last line and hide it. Anywhere is safe because the marker is a
  // per-invocation nonce no earlier byte of stdout can contain.
  const start = marker.startsWith(INSTRUCTION_PROBE_MARKER_PREFIX) ? stdout.indexOf(marker) : -1;
  if (start === -1) return { stdout, probe: null };
  const lineEnd = stdout.indexOf("\n", start);
  const stop = lineEnd === -1 ? stdout.length : lineEnd + 1;
  const raw = stdout.slice(start + marker.length, lineEnd === -1 ? stdout.length : lineEnd);
  const rest = stdout.slice(0, start) + stdout.slice(stop);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { stdout: rest, probe: null };
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { entries?: unknown }).entries)) {
    return { stdout: rest, probe: null };
  }
  const entries: InstructionProbeEntry[] = [];
  for (const candidate of (parsed as { entries: unknown[] }).entries) {
    if (!candidate || typeof candidate !== "object") continue;
    const entry = candidate as Record<string, unknown>;
    if (typeof entry.path !== "string" || typeof entry.sha256 !== "string") continue;
    const cut = typeof entry.content === "string"
      ? truncateOnCodePoints(entry.content, MAX_RESIDENT_CONTEXT_BLOCK_BYTES)
      : null;
    entries.push({
      path: entry.path,
      sha256: entry.sha256,
      bytes: typeof entry.bytes === "number" ? entry.bytes : 0,
      ...(cut ? { content: cut.text } : {}),
      truncated: Boolean(entry.truncated) || Boolean(cut?.truncated),
      ...(typeof entry.status === "string" ? { status: entry.status } : {}),
      resident: Boolean(entry.resident),
    });
  }
  return {
    stdout: rest,
    probe: { entries, pending: entries.some((entry) => !entry.resident) },
  };
}
