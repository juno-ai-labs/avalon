import type { HarnessToolContext } from "@rally/agent-harness";
import { newId } from "@rally/db";

import { sha256Hex } from "../../lib/crypto";
import type { AcquiredTerminalSandbox, TerminalSandboxCoordinator } from "./coordinator";
import {
  DAYTONA_REQUEST_TIMEOUT_MS,
  isTerminalProviderNotFound,
  type TerminalSandboxProvider,
} from "./provider-contract";
import type {
  TerminalCommandOutput,
  TerminalImportResourceOutput,
  TerminalPatchOutput,
  TerminalPublishedBranchAndPrOutput,
  TerminalPublishedResourceOutput,
  TerminalPublishOutput,
  TerminalPublishedSiteOutput,
  TerminalRuntime,
  TerminalWriteFileOutput,
  TerminalWriteFileOptions,
} from "./tools";
import { requireTerminalEffectIntent, sanitizeTerminalOutput, TerminalToolError } from "./tools";
import {
  assertKindTransitionAllowed,
  bundleArchive,
  declaresStorageClass,
  resolveDirectoryPublish,
  type DirectoryEntry,
} from "./site-publish";
import type { TerminalPortFactory } from "./object-port";
import type { TerminalTaskRecord } from "../../durable-objects/workstream-terminal-storage";
import type { TerminalRepositorySelector } from "./repository-selection";
import { recordTerminalAcquisition } from "./tracing";

const ROOT = "/workspace";
const RESOURCE_ROOT = ".rally/resources";
const OUTPUT_ROOT = ".rally-output";
const MAX_PROVIDER_CAPTURE_BYTES = 128 * 1_024;
const MAX_COMMAND_LOG_BYTES = 5_000_000;
const OUTPUT_LIMIT_MARKER_RESERVE_BYTES = 256;
const PATH_OUTSIDE_ROOT_EXIT_CODE = 43;

/**
 * The most a single publish may carry, file or directory.
 *
 * Transcribed from the file path's existing bound rather than chosen: a
 * directory publish is the same operation over more files, and giving it a
 * different ceiling would mean two numbers nobody could date. The bundle-size
 * and file-count guards the artifact design calls for are separate, still open,
 * and the team's to set.
 */
const MAXIMUM_PUBLISH_BYTES = 25_000_000;
const FILE_NOT_FOUND_EXIT_CODE = 44;
const FILE_NOT_REGULAR_EXIT_CODE = 45;
const FILE_NOT_UTF8_EXIT_CODE = 49;
const FILE_TOO_LARGE_EXIT_CODE = 50;
const FILE_LINE_TOO_LARGE_EXIT_CODE = 51;
const COUNT_UTF8_LINES_PYTHON = "import pathlib, sys; text = pathlib.Path(sys.argv[1]).read_bytes().decode('utf-8'); print(0 if not text else len(text.split('\\n')) - int(text.endswith('\\n')))";
export const TERMINAL_READ_TEXT_PAGE_PYTHON = [
  "import json, os, pathlib, sys",
  "root, path, offset, limit, max_page, max_file = os.path.realpath(sys.argv[1]), sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6])",
  "resolved = os.path.realpath(path)",
  "if os.path.commonpath([root, resolved]) != root: sys.exit(43)",
  "target = pathlib.Path(path)",
  "if not target.exists(): sys.exit(44)",
  "if target.is_symlink() or not target.is_file(): sys.exit(45)",
  "size = target.stat().st_size",
  "if size > max_file: print(size); sys.exit(50)",
  "try: text = target.read_bytes().decode('utf-8')",
  "except UnicodeDecodeError: sys.exit(49)",
  "lines = text.split('\\n') if text else []",
  "if lines and lines[-1] == '': lines.pop()",
  "selected, selected_bytes = [], 0",
  "for line in lines[offset - 1:offset - 1 + limit]:",
  "    encoded = (('\\n' if selected else '') + line).encode('utf-8')",
  "    if not selected and len(encoded) > max_page: print(len(encoded)); sys.exit(51)",
  "    if selected_bytes + len(encoded) > max_page: break",
  "    selected.append(line); selected_bytes += len(encoded)",
  "end = offset + len(selected) - 1 if selected else min(offset - 1, len(lines))",
  "truncated = end < len(lines)",
  "result = {'content': '\\n'.join(selected), 'startLine': offset, 'endLine': end, 'totalLines': len(lines), 'truncated': truncated}",
  "if truncated: result['nextOffset'] = end + 1",
  "print(json.dumps(result, ensure_ascii=False, separators=(',', ':')))",
].join("\n");

type ImportInput = Parameters<TerminalRuntime["importResource"]>[1];
type PublishInput = Parameters<TerminalRuntime["publishResource"]>[1];
type PublishPrInput = Parameters<TerminalRuntime["publishBranchAndPr"]>[1];

export interface TerminalResourceBridge {
  importResource(
    context: HarnessToolContext,
    input: ImportInput,
    destinationPath: string,
    sandboxGeneration: number,
    providerSandboxId: string,
    provider: TerminalSandboxProvider,
  ): Promise<TerminalImportResourceOutput>;
  publishResource(
    context: HarnessToolContext,
    /**
     * `providerResourceId` is Rally's own, never the model's. A capture Rally
     * writes on the model's behalf — a command log — shares the sandbox path
     * space with files the model chooses, so deriving its identity from that
     * path would let a run republish over its own audit record. An internal
     * producer names its namespace instead, as the diff and backup captures do.
     */
    input: PublishInput & { providerResourceId?: string },
    bytes: Uint8Array,
  ): Promise<TerminalPublishedResourceOutput>;
  /**
   * Publish a directory that carried a site entry, as a served artifact.
   *
   * Separate from {@link publishResource} rather than a branch inside it,
   * because almost nothing is shared: a site's stored content is a manifest
   * rather than the thing a viewer sees, its bytes go to version-immutable keys
   * instead of one object ref, and it has a supervisor object to point at
   * afterwards. What *is* shared — the `(work stream, normalized path)`
   * identity — is shared by both calling the same derivation.
   */
  publishSiteResource(
    context: HarnessToolContext,
    input: PublishInput,
    site: {
      mode: "static" | "active";
      stateful: boolean;
      files: readonly { path: string; bytes: Uint8Array; sha256: string }[];
      serverModuleSha256: string | null;
    },
  ): Promise<TerminalPublishedSiteOutput>;
  /**
   * What this path already published as, or `null` if it never has.
   *
   * Asked before a directory publish writes anything, so the one asymmetric
   * transition — site back to archive — can be refused while the artifact is
   * still serving what it served before.
   */
  publishedKindForPath(
    context: HarnessToolContext,
    filePath: string,
  ): Promise<"site" | "archive" | "file" | null>;
}

export interface TerminalRepositoryPublisher {
  publishBranchAndPr(
    context: HarnessToolContext,
    input: PublishPrInput,
    sandbox: AcquiredTerminalSandbox,
    provider: TerminalSandboxProvider,
  ): Promise<TerminalPublishedBranchAndPrOutput>;
}

export type TerminalSandboxPreparation = (
  context: HarnessToolContext,
  sandbox: AcquiredTerminalSandbox,
  provider: TerminalSandboxProvider,
) => Promise<void>;

export interface DaytonaTerminalRuntime extends TerminalRuntime {
  /** Populate the same per-run acquisition/preparation promise every tool consumes. */
  prepare(
    context: HarnessToolContext,
    preparation?: TerminalSandboxPreparation,
  ): Promise<AcquiredTerminalSandbox>;
  /** Require the next ordinary tool to reacquire and rerun repository preparation. */
  discardPreparation(context: Pick<HarnessToolContext, "harnessRunId">): void;
}

/**
 * The object stores unix milliseconds; a tool result reports ISO-8601, which
 * is the model-facing contract. This is the only place the two meet.
 */
function isoAt(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

function absolutePath(relativePath: string): string {
  return `${ROOT}/${relativePath}`;
}

function lineCount(value: string): number {
  if (!value) return 0;
  return value.split("\n").length - Number(value.endsWith("\n"));
}

function containmentCommands(): string[] {
  return [
    `resolved=$(realpath -m -- "$target") || exit ${PATH_OUTSIDE_ROOT_EXIT_CODE}`,
    `case "$resolved" in ${shellQuote(ROOT)}|${shellQuote(`${ROOT}/`)}*) ;; *) exit ${PATH_OUTSIDE_ROOT_EXIT_CODE} ;; esac`,
  ];
}

function pathOutsideRootError(): TerminalToolError {
  return new TerminalToolError(
    "path_outside_root",
    "The requested path resolves outside the Terminal workspace, possibly through a symlink. Choose a path under the workspace root.",
    { field: "filePath", reason: "Use a path that does not traverse an escaping symlink." },
  );
}

function bounded(value: string): { head: string; tail: string; bytes: number } {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= MAX_PROVIDER_CAPTURE_BYTES) return { head: value, tail: "", bytes: bytes.byteLength };
  const half = Math.floor(MAX_PROVIDER_CAPTURE_BYTES / 2);
  const decoder = new TextDecoder();
  return {
    head: decoder.decode(bytes.slice(0, half)),
    tail: decoder.decode(bytes.slice(bytes.byteLength - half)),
    bytes: bytes.byteLength,
  };
}

function joinedCapture(head: string, tail: string): string {
  return tail ? `${head}\n… provider output omitted …\n${tail}` : head;
}

type DurableTerminalCommandOutput = Omit<
  TerminalCommandOutput,
  "acquisitionDurationMs" | "totalDurationMs"
>;

function commandOutputFromTask(task: TerminalTaskRecord): DurableTerminalCommandOutput | null {
  if (task.state !== "completed" && task.state !== "failed"
    && task.state !== "timed_out" && task.state !== "cancelled") return null;
  if (task.startedAt === null || task.completedAt === null) {
    throw new TerminalToolError(
      "command_recovery_unavailable",
      "The earlier command reached a terminal state without complete timing evidence. Stop and report the ambiguity; do not repeat the command.",
    );
  }
  const state = task.state;
  const terminationReason = (task.terminationReason
    ?? (state === "timed_out" ? "timed_out" : state === "cancelled" ? "cancelled" : "exited")
  ) as TerminalCommandOutput["terminationReason"];
  return {
    state,
    terminationReason,
    exitCode: task.exitCode,
    stdout: joinedCapture(task.stdoutHead, task.stdoutTail),
    stderr: joinedCapture(task.stderrHead, task.stderrTail),
    ...(task.outputResourceId ? { outputResourceId: task.outputResourceId } : {}),
    startedAt: isoAt(task.startedAt),
    completedAt: isoAt(task.completedAt),
  };
}

function parsePatch(patch: string): TerminalPatchOutput {
  const files = new Map<string, { path: string; previousPath?: string; operation: "created" | "edited" | "renamed" | "deleted"; additions: number; deletions: number }>();
  let current: ReturnType<typeof files.get>;
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
      if (current.path.startsWith("/") || current.path.split("/").includes("..")) {
        throw new TerminalToolError("path_outside_root", "A patch path leaves the Terminal workspace. Regenerate it using relative paths only.");
      }
      files.set(current.path, current);
    } else if (current && line.startsWith("+") && !line.startsWith("+++")) {
      current.additions += 1;
    } else if (current && line.startsWith("-") && !line.startsWith("---")) {
      current.deletions += 1;
    }
  }
  if (files.size === 0) throw new TerminalToolError("patch_invalid", "No unified file changes were found. Include --- and +++ headers and retry.");
  if (files.size > 100) throw new TerminalToolError("limit_exceeded", "A patch may change at most 100 files. Split it into smaller patches.");
  const outputFiles = [...files.values()];
  return {
    files: outputFiles,
    additions: outputFiles.reduce((total, file) => total + file.additions, 0),
    deletions: outputFiles.reduce((total, file) => total + file.deletions, 0),
  };
}

export function createDaytonaTerminalRuntime(
  terminalPort: TerminalPortFactory,
  coordinator: TerminalSandboxCoordinator,
  provider: TerminalSandboxProvider,
  resources: TerminalResourceBridge,
  publisher: TerminalRepositoryPublisher,
  selector: TerminalRepositorySelector | null = null,
  prepareSandbox?: TerminalSandboxPreparation,
  cacheNow: () => number = Date.now,
): DaytonaTerminalRuntime {
  const acquiredByRun = new Map<string, Promise<AcquiredTerminalSandbox>>();

  async function acquire(
    context: HarnessToolContext,
    preparation: TerminalSandboxPreparation | undefined = prepareSandbox,
  ): Promise<AcquiredTerminalSandbox> {
    if (context.signal.aborted) {
      throw new TerminalToolError("cancelled", "The Terminal operation was cancelled before sandbox startup.");
    }
    const cached = acquiredByRun.get(context.harnessRunId);
    if (cached) {
      const startedAt = cacheNow();
      const sandbox = await cached;
      if (sandbox.operationLeaseExpiresAt > cacheNow()) {
        recordTerminalAcquisition({ durationMs: cacheNow() - startedAt, cacheHit: true });
        return sandbox;
      }
      if (acquiredByRun.get(context.harnessRunId) === cached) {
        acquiredByRun.delete(context.harnessRunId);
      }
    }
    const startedAt = cacheNow();
    const pending = (async () => {
      const sandbox = await coordinator.acquire(context);
      await preparation?.(context, sandbox, provider);
      return sandbox;
    })();
    acquiredByRun.set(context.harnessRunId, pending);
    try {
      return await pending;
    } catch (error) {
      if (acquiredByRun.get(context.harnessRunId) === pending) {
        acquiredByRun.delete(context.harnessRunId);
      }
      throw error;
    } finally {
      recordTerminalAcquisition({ durationMs: cacheNow() - startedAt, cacheHit: false });
    }
  }

  async function cleanupTemporaryFile(providerSandboxId: string, path: string): Promise<void> {
    await provider.runUtilityCommand(providerSandboxId, {
      operation: "file.temp_cleanup",
      command: `rm -f -- ${shellQuote(path)}`,
      cwd: ROOT,
      timeoutMs: 10_000,
    }).catch(() => undefined);
  }

  async function resolveInsideRoot(
    context: HarnessToolContext,
    sandbox: AcquiredTerminalSandbox,
    relativePath: string,
  ): Promise<string> {
    const intended = absolutePath(relativePath);
    const result = await provider.runUtilityCommand(sandbox.providerSandboxId, {
      operation: "path.resolve",
      command: `realpath -m -- ${shellQuote(intended)}`,
      cwd: ROOT,
      timeoutMs: 10_000,
      signal: context.signal,
    });
    const resolved = result.stdout.trim();
    if (result.exitCode !== 0 || (resolved !== ROOT && !resolved.startsWith(`${ROOT}/`))) {
      throw pathOutsideRootError();
    }
    return intended;
  }

  /**
   * Whether a published path names a file or a directory, refusing anything
   * else — and enumerating the directory in the same pass.
   *
   * One command rather than a stat followed by a listing, because the two would
   * be a TOCTOU window on a path the model's own commands may still be writing:
   * the publish contract is that the *bytes* are verified stable afterwards, so
   * what this must not do is let the shape change between deciding it is a
   * directory and deciding what is in it.
   *
   * Symlinks are refused throughout, not followed. A published tree is served
   * from an origin whose whole job is containment, and a link that escaped the
   * output root would put an arbitrary sandbox file behind an HTTPS URL that
   * every participant can open.
   */
  async function inspectPublishTarget(
    context: HarnessToolContext,
    sandbox: AcquiredTerminalSandbox,
    path: string,
  ): Promise<
    | { shape: "file"; size: number; sha256: string }
    | { shape: "directory"; entries: DirectoryEntry[] }
  > {
    const result = await provider.runUtilityCommand(sandbox.providerSandboxId, {
      operation: "resource.publish.inspect_target",
      command: [
        `target=${shellQuote(path)}`,
        ...containmentCommands(),
        'if [ ! -e "$target" ]; then exit 44; fi',
        'if [ -L "$target" ]; then exit 45; fi',
        'if [ -f "$target" ]; then',
        '  printf "file %s %s\\n" "$(stat -c %s -- "$target")" "$(sha256sum -- "$target" | cut -d " " -f 1)"',
        '  exit 0',
        'fi',
        'if [ ! -d "$target" ]; then exit 46; fi',
        // Any symlink anywhere beneath the tree fails the whole publish rather
        // than being skipped: a silently omitted file is a site that renders
        // wrongly, and the model has no way to see which one went missing.
        'if [ -n "$(find "$target" -type l -print -quit)" ]; then exit 45; fi',
        'printf "directory\\n"',
        // `%P` is the path relative to the target, which is exactly the
        // manifest's key space, and NUL-free by the path rules the family
        // already enforces.
        'find "$target" -type f -printf "%s %P\\n" | sort -k2 | while read -r size rest; do',
        '  printf "%s %s %s\\n" "$size" "$(sha256sum -- "$target/$rest" | cut -d " " -f 1)" "$rest"',
        'done',
      ].join("\n"),
      cwd: ROOT,
      timeoutMs: 60_000,
      signal: context.signal,
    });
    if (result.exitCode === PATH_OUTSIDE_ROOT_EXIT_CODE) throw pathOutsideRootError();
    if (result.exitCode === 44) {
      throw new TerminalToolError(
        "not_found",
        "No output file or directory exists there. Use a path relative to AVALON_RESOURCE_DIR, not a repository-relative or absolute path.",
        { field: "filePath" },
      );
    }
    if (result.exitCode === 45 || result.exitCode === 46) {
      throw new TerminalToolError(
        "resource_not_ready",
        "The output is not a stable regular file or directory. Wait for its command to finish, then write or rename the final files beneath AVALON_RESOURCE_DIR and use a new invocation.",
        { reason: result.exitCode === 45 ? "symbolic links cannot be published" : "the path is neither a regular file nor a directory" },
      );
    }
    const lines = result.stdout.split("\n").filter((line) => line.trim().length > 0);
    const head = lines[0] ?? "";
    const file = /^file (\d+) ([0-9a-f]{64})$/u.exec(head);
    if (file) return { shape: "file", size: Number(file[1]), sha256: file[2]! };
    if (result.exitCode !== 0 || head !== "directory") {
      throw new TerminalToolError(
        "resource_not_ready",
        "The output could not be verified as stable. Wait for its producer to finish, then retry publish_resource with the final files.",
        { reason: "Wait for the producer to finish, then retry with the final stable output." },
      );
    }
    const entries: DirectoryEntry[] = [];
    for (const line of lines.slice(1)) {
      const parsed = /^(\d+) ([0-9a-f]{64}) (.+)$/u.exec(line);
      if (!parsed?.[3]) {
        throw new TerminalToolError(
          "resource_not_ready",
          "The output directory could not be listed reliably. Wait for its producer to finish, then retry publish_resource.",
          { reason: "Wait for the producer to finish, then retry with the final stable output." },
        );
      }
      entries.push({ path: parsed[3], sizeBytes: Number(parsed[1]), sha256: parsed[2]! });
    }
    if (entries.length === 0) {
      throw new TerminalToolError(
        "resource_empty",
        "The output directory holds no files. Write the site's files beneath it, then publish the directory again.",
        { field: "filePath", reason: "Write at least one file beneath the directory before publishing it." },
      );
    }
    return { shape: "directory", entries };
  }

  /**
   * Read every file beneath a published directory, and publish what they add up
   * to.
   *
   * The bytes come back one file at a time. That is N round trips to the
   * sandbox for an N-file site, and it is the right shape at this size: a site
   * is a handful of files, the provider has no batch read, and the alternative
   * — having the sandbox tar the tree so it can be unpacked here — adds an
   * archive format to the trust boundary to save round trips nobody has
   * measured.
   *
   * Each file is verified against the digest the listing reported. A file
   * rewritten between the listing and the read is a producer that has not
   * finished, and publishing half of one version and half of another would be a
   * site that renders inconsistently with nothing to point at.
   */
  async function publishDirectory(
    context: HarnessToolContext,
    input: PublishInput,
    sandbox: AcquiredTerminalSandbox,
    path: string,
    entries: readonly DirectoryEntry[],
  ): Promise<TerminalPublishOutput> {
    const resolved = resolveDirectoryPublish(entries);
    // Before any bytes move: a republish that would turn a live site back into
    // an archive fails loudly rather than quietly killing a URL participants
    // hold. The other direction — an archive that grew an entry file — is the
    // archive fallback's own recovery and upgrades freely.
    assertKindTransitionAllowed(
      await resources.publishedKindForPath(context, input.filePath),
      resolved.kind,
    );
    const totalBytes = entries.reduce((total, entry) => total + entry.sizeBytes, 0);
    if (totalBytes > MAXIMUM_PUBLISH_BYTES) {
      throw new TerminalToolError(
        "resource_limit_exceeded",
        `The directory holds ${totalBytes} bytes; publication allows at most ${MAXIMUM_PUBLISH_BYTES} bytes. Reduce or split it before retrying.`,
        { field: "filePath", expected: `directory bytes at most ${MAXIMUM_PUBLISH_BYTES}` },
      );
    }
    const files: { path: string; bytes: Uint8Array; sha256: string }[] = [];
    for (const entry of entries) {
      let bytes: Uint8Array;
      try {
        bytes = await provider.readFile(sandbox.providerSandboxId, `${path}/${entry.path}`);
      } catch {
        throw new TerminalToolError(
          "resource_not_ready",
          "A file in the directory changed or disappeared while Rally was reading it. Wait for its producer to finish, then retry publish_resource with the final directory.",
          { reason: "Wait for the producer to finish, then retry with the final stable directory." },
        );
      }
      const observed = await sha256Hex(bytes);
      if (observed !== entry.sha256 || bytes.byteLength !== entry.sizeBytes) {
        throw new TerminalToolError(
          "resource_not_ready",
          "A file in the directory changed while Rally was reading it. Wait for its command to finish, then retry publish_resource with the final directory.",
          { reason: "Wait for the producer to finish, then retry with the final stable directory." },
        );
      }
      files.push({ path: entry.path, bytes, sha256: observed });
    }

    if (resolved.kind === "archive") {
      // The archive rides the ordinary document publish path unchanged: it is
      // one file's bytes with a zip's mime type, so identity, replay, version
      // capture, and the rail entry all behave exactly as a document's do.
      const bundle = bundleArchive(files);
      const published = await resources.publishResource(
        context,
        // The zip's own name is the directory's, so the rail entry reads as the
        // thing the participant asked to be bundled rather than as `index`.
        { ...input, filePath: input.filePath },
        bundle,
      );
      return { ...published, fileCount: files.length, totalBytes };
    }

    const serverModule = resolved.mode === "active"
      ? files.find((file) => file.path === resolved.entryPath)
      : undefined;
    return resources.publishSiteResource(context, input, {
      mode: resolved.mode,
      // A source-text check, because publish never executes artifact code. It
      // is a promise about what Rally will *try* to load, not about what the
      // module does; a module that matches and then fails to export the class
      // is a loud serve-time error rather than a silent one.
      stateful: serverModule
        ? declaresStorageClass(new TextDecoder().decode(serverModule.bytes))
        : false,
      files,
      serverModuleSha256: serverModule?.sha256 ?? null,
    });
  }

  async function inspectGeneratedFile(
    context: HarnessToolContext,
    sandbox: AcquiredTerminalSandbox,
    path: string,
    phase: "before" | "after",
  ): Promise<{ size: number; sha256: string }> {
    const result = await provider.runUtilityCommand(sandbox.providerSandboxId, {
      operation: `resource.publish.inspect_${phase}`,
      command: [
        `target=${shellQuote(path)}`,
        ...(phase === "before" ? containmentCommands() : []),
        'if [ ! -e "$target" ]; then exit 44; fi',
        'if [ -L "$target" ]; then exit 45; fi',
        'if [ ! -f "$target" ]; then exit 46; fi',
        'size=$(stat -c %s -- "$target") || exit 47',
        'digest=$(sha256sum -- "$target" | cut -d " " -f 1) || exit 47',
        'printf "%s %s\\n" "$size" "$digest"',
      ].join("\n"),
      cwd: ROOT,
      timeoutMs: 30_000,
      signal: context.signal,
    });
    if (result.exitCode === PATH_OUTSIDE_ROOT_EXIT_CODE) throw pathOutsideRootError();
    if (result.exitCode === 44) {
      throw new TerminalToolError(
        "not_found",
        "No output file exists there. Use a path relative to AVALON_RESOURCE_DIR, not a repository-relative or absolute path.",
        { field: "filePath" },
      );
    }
    if (result.exitCode === 45 || result.exitCode === 46) {
      throw new TerminalToolError(
        "resource_not_ready",
        "The output is not a stable regular file. Wait for its command to finish, then write or rename the final file beneath AVALON_RESOURCE_DIR and use a new invocation.",
        { reason: result.exitCode === 45 ? "symbolic links cannot be published" : "the path is not a regular file" },
      );
    }
    const match = /^(\d+) ([0-9a-f]{64})\s*$/u.exec(result.stdout);
    if (result.exitCode !== 0 || !match) {
      throw new TerminalToolError(
        "resource_not_ready",
        "The output file could not be verified as stable. Wait for its producer to finish, then retry publish_resource with the final file.",
        { reason: "Wait for the producer to finish, then retry with the final stable file." },
      );
    }
    return { size: Number(match[1]), sha256: match[2]! };
  }

  return {
    prepare: acquire,
    discardPreparation(context) {
      acquiredByRun.delete(context.harnessRunId);
    },
    async checkoutRepository(context, input) {
      if (!selector) {
        throw new TerminalToolError("repository_checkout_unavailable", "Repository checkout is unavailable in this Terminal runtime.");
      }
      acquiredByRun.delete(context.harnessRunId);
      const selected = await selector.checkout(context, input);
      acquiredByRun.delete(context.harnessRunId);
      return selected;
    },
    async readFile(context, filePath) {
      const sandbox = await acquire(context);
      const path = absolutePath(filePath);
      const metadata = await provider.runUtilityCommand(sandbox.providerSandboxId, {
        operation: "file.inspect",
        command: [
          `target=${shellQuote(path)}`,
          ...containmentCommands(),
          'if [ ! -e "$target" ]; then exit 44; fi',
          'if [ -L "$target" ] || [ ! -f "$target" ]; then exit 45; fi',
          'stat -c %s -- "$target"',
        ].join("\n"),
        cwd: ROOT,
        timeoutMs: 10_000,
        signal: context.signal,
      });
      if (metadata.exitCode === PATH_OUTSIDE_ROOT_EXIT_CODE) throw pathOutsideRootError();
      if (metadata.exitCode === FILE_NOT_FOUND_EXIT_CODE) return null;
      if (metadata.exitCode === FILE_NOT_REGULAR_EXIT_CODE) {
        throw new TerminalToolError("file_read_failed", "The path is not a regular file. Use terminal_run_command with `ls -l` or `file` to inspect it.", { filePath });
      }
      const size = Number(metadata.stdout.trim());
      if (metadata.exitCode !== 0 || !Number.isSafeInteger(size) || size < 0) {
        throw new TerminalToolError("file_read_failed", "The file size could not be verified. Inspect it with terminal_run_command and retry.", { reason: "Inspect the path with ls -l or file, then retry the read." });
      }
      if (size > 10 * 1_048_576) {
        throw new TerminalToolError("limit_exceeded", `The file is ${size} bytes; terminal_read_file supports at most 10485760 bytes. Use a command to extract a smaller range.`, { field: "filePath", expected: "file bytes at most 10485760" });
      }
      try {
        return await provider.readFile(sandbox.providerSandboxId, path);
      } catch (error) {
        if (isTerminalProviderNotFound(error)) return null;
        throw new TerminalToolError(
          "file_read_failed",
          "The file could not be read. Use terminal_run_command with `ls -l` or `file` to verify that it exists and is a regular file.",
          { reason: "Inspect the path with ls -l or file, then retry the read." },
        );
      }
    },

    async readFilePage(context, filePath, offset, limit) {
      const sandbox = await acquire(context);
      const path = absolutePath(filePath);
      const result = await provider.runUtilityCommand(sandbox.providerSandboxId, {
        operation: "file.read_page",
        command: `python3 -c ${shellQuote(TERMINAL_READ_TEXT_PAGE_PYTHON)} ${shellQuote(ROOT)} ${shellQuote(path)} ${offset} ${limit} ${256 * 1_024} ${10 * 1_048_576}`,
        cwd: ROOT,
        timeoutMs: 30_000,
        signal: context.signal,
      });
      if (result.exitCode === PATH_OUTSIDE_ROOT_EXIT_CODE) throw pathOutsideRootError();
      if (result.exitCode === FILE_NOT_FOUND_EXIT_CODE) return null;
      if (result.exitCode === FILE_NOT_REGULAR_EXIT_CODE) {
        throw new TerminalToolError("file_read_failed", "The path is not a regular file. Use terminal_run_command with `ls -l` or `file` to inspect it.", { filePath });
      }
      if (result.exitCode === FILE_NOT_UTF8_EXIT_CODE) {
        throw new TerminalToolError("not_text_file", "The file is not valid UTF-8 text. Use terminal_run_command with `file` or a format-specific tool to inspect it.", { filePath });
      }
      if (result.exitCode === FILE_TOO_LARGE_EXIT_CODE) {
        const size = Number(result.stdout.trim());
        throw new TerminalToolError("limit_exceeded", `The file is ${size} bytes; terminal_read_file supports at most 10485760 bytes. Use a command to extract a smaller range.`, { field: "filePath", expected: "file bytes at most 10485760" });
      }
      if (result.exitCode === FILE_LINE_TOO_LARGE_EXIT_CODE) {
        const size = Number(result.stdout.trim());
        throw new TerminalToolError(
          "limit_exceeded",
          `A single line is ${size} bytes; terminal_read_file pages can contain at most 262144 bytes. Use terminal_run_command with a bounded text tool such as cut, fold, head -c, jq, or rg.`,
          { field: "offset", expected: "a line encoded as at most 262144 UTF-8 bytes" },
        );
      }
      if (result.exitCode !== 0) {
        throw new TerminalToolError("file_read_failed", "The file could not be read. Inspect it with terminal_run_command and retry.", { reason: "Inspect the path with ls -l or file, then retry the read." });
      }
      try {
        return JSON.parse(result.stdout) as Awaited<ReturnType<TerminalRuntime["readFilePage"]>>;
      } catch {
        throw new TerminalToolError("file_read_failed", "The sandbox returned an invalid file page. Retry the read.");
      }
    },

    async writeFile(
      context,
      filePath,
      bytes,
      options?: TerminalWriteFileOptions,
    ): Promise<TerminalWriteFileOutput> {
      const sandbox = await acquire(context);
      const target = absolutePath(filePath);
      const temporary = `${ROOT}/.rally/tmp/${newId()}`;
      await provider.writeFile(sandbox.providerSandboxId, temporary, bytes, context.signal);
      let result: Awaited<ReturnType<TerminalSandboxProvider["runUtilityCommand"]>>;
      try {
        result = await provider.runUtilityCommand(sandbox.providerSandboxId, {
          operation: "file.replace",
          command: [
            `target=${shellQuote(target)}`,
            `temporary=${shellQuote(temporary)}`,
            'trap \'rm -f -- "$temporary"\' EXIT',
            ...(options ? [
              "created=0",
              `previous_lines=${lineCount(options.previousText)}`,
            ] : [
              ...containmentCommands(),
              "created=1",
              "previous_lines=0",
              'if [ -e "$target" ]; then',
              `  if [ -L "$target" ] || [ ! -f "$target" ]; then exit ${FILE_NOT_REGULAR_EXIT_CODE}; fi`,
              '  size=$(stat -c %s -- "$target") || exit 47',
              `  if [ "$size" -gt ${10 * 1_048_576} ]; then printf '%s\\n' "$size"; exit ${FILE_TOO_LARGE_EXIT_CODE}; fi`,
              `  previous_lines=$(python3 -c ${shellQuote(COUNT_UTF8_LINES_PYTHON)} "$target") || exit ${FILE_NOT_UTF8_EXIT_CODE}`,
              "  created=0",
              "fi",
            ]),
            'mkdir -p -- "$(dirname -- "$target")" && mv -- "$temporary" "$target" || exit 47',
            "trap - EXIT",
            'printf "%s %s\\n" "$created" "$previous_lines"',
          ].join("\n"),
          cwd: ROOT,
          timeoutMs: 30_000,
          signal: context.signal,
        });
      } catch (error) {
        await cleanupTemporaryFile(sandbox.providerSandboxId, temporary);
        throw error;
      }
      if (result.exitCode === PATH_OUTSIDE_ROOT_EXIT_CODE) throw pathOutsideRootError();
      if (result.exitCode === FILE_NOT_REGULAR_EXIT_CODE) {
        throw new TerminalToolError("file_write_failed", "The path is not a regular file. Inspect it with terminal_run_command before replacing it.", { filePath });
      }
      if (result.exitCode === FILE_NOT_UTF8_EXIT_CODE) {
        throw new TerminalToolError("not_text_file", "The existing file is not UTF-8 text. Inspect it with terminal_run_command before replacing it.", { filePath });
      }
      if (result.exitCode === FILE_TOO_LARGE_EXIT_CODE) {
        const size = Number(result.stdout.trim());
        throw new TerminalToolError("limit_exceeded", `The existing file is ${size} bytes; terminal_write_file replaces files up to 10485760 bytes.`, { field: "filePath", expected: "file bytes at most 10485760" });
      }
      const summary = /^([01]) (\d+)\s*$/u.exec(result.stdout);
      if (result.exitCode !== 0 || !summary) {
        throw new TerminalToolError("file_write_failed", "The atomic file replacement failed. Inspect the parent directory and retry.", { reason: "Inspect the parent directory and available space, then retry." });
      }
      return { created: summary[1] === "1", previousLines: Number(summary[2]) };
    },

    async applyPatch(context, patch) {
      const parsed = parsePatch(patch);
      const sandbox = await acquire(context);
      const temporary = `${ROOT}/.rally/tmp/${newId()}.patch`;
      await provider.writeFile(sandbox.providerSandboxId, temporary, new TextEncoder().encode(patch), context.signal);
      let result: Awaited<ReturnType<TerminalSandboxProvider["runUtilityCommand"]>>;
      try {
        result = await provider.runUtilityCommand(sandbox.providerSandboxId, {
          operation: "file.apply_patch",
          command: `git apply --check -- ${shellQuote(temporary)} && git apply -- ${shellQuote(temporary)}; status=$?; rm -f -- ${shellQuote(temporary)}; exit $status`,
          cwd: ROOT,
          timeoutMs: 60_000,
          signal: context.signal,
        });
      } catch (error) {
        await cleanupTemporaryFile(sandbox.providerSandboxId, temporary);
        throw error;
      }
      if (result.exitCode !== 0) {
        throw new TerminalToolError(
          "patch_does_not_apply",
          "The patch no longer matches the current files. Re-read the affected files, regenerate the patch with current context, and retry.",
          { reason: "Re-read every affected file and regenerate the patch from current contents." },
        );
      }
      return parsed;
    },

    async runCommand(context, input) {
      // Before `acquire`: rejecting after it would leave a sandbox created,
      // started, and a generation burned for a call that never ran.
      const effectIntentId = requireTerminalEffectIntent(context, "command");
      const totalStartedAt = Date.now();
      const sandbox = await acquire(context);
      const acquisitionDurationMs = Date.now() - totalStartedAt;
      const cwd = input.cwd ? await resolveInsideRoot(context, sandbox, input.cwd) : ROOT;
      const taskName = `avalon-task-${effectIntentId}`;
      const commandHash = await sha256Hex(JSON.stringify({ command: input.command, cwd, timeoutMs: input.timeoutMs }));
      const terminal = terminalPort(context.workspaceId, context.workstreamId);
      const existing = await terminal.taskByEffect(effectIntentId);
      const replay = existing && commandOutputFromTask(existing);
      if (replay) {
        await provider.cleanupCommand?.(sandbox.providerSandboxId, taskName).catch(() => undefined);
        return {
          ...replay,
          acquisitionDurationMs,
          totalDurationMs: Date.now() - totalStartedAt,
        };
      }

      if (
        existing
        && (
          existing.sandboxGeneration !== sandbox.generation
          || existing.providerTaskName !== taskName
          || existing.commandSha256 !== commandHash
        )
      ) {
        throw new TerminalToolError(
          "command_recovery_unavailable",
          "The earlier command may have run, but Rally cannot prove that the current sandbox and input match it. Stop and report the ambiguity; do not repeat the command.",
        );
      }

      const startedAt = existing?.startedAt ?? Date.now();
      const deadlineAt = existing?.commandDeadlineAt
        ?? Date.now() + DAYTONA_REQUEST_TIMEOUT_MS;
      const taskAdmitted = await terminal.insertTask({
        taskId: newId(),
        runId: context.harnessRunId,
        effectIntentId,
        sandboxGeneration: sandbox.generation,
        sandboxId: sandbox.providerSandboxId,
        providerTaskName: taskName,
        commandSha256: commandHash,
        commandDeadlineAt: deadlineAt,
        startedAt,
        now: startedAt,
      });
      if (!taskAdmitted) {
        throw new TerminalToolError(
          "command_recovery_unavailable",
          "This run no longer owns Terminal command submission. Stop and report the interrupted command; do not repeat it.",
        );
      }

      let result: { exitCode: number; stdout: string; stderr: string; timedOut?: boolean };
      let state: TerminalCommandOutput["state"];
      let terminationReason: TerminalCommandOutput["terminationReason"];
      try {
        result = await provider.runCommand(sandbox.providerSandboxId, {
          taskName,
          command: input.command,
          cwd,
          timeoutMs: input.timeoutMs,
          signal: context.signal,
          retainSessionForRecovery: true,
          assertSubmissionAuthority: async () => {
            const renewedAt = Date.now();
            const authorized = await terminal.renewTaskSubmissionAuthority({
              effectIntentId,
              runId: context.harnessRunId,
              sandboxGeneration: sandbox.generation,
              sandboxId: sandbox.providerSandboxId,
              commandDeadlineAt: renewedAt + DAYTONA_REQUEST_TIMEOUT_MS,
              now: renewedAt,
            });
            if (!authorized) {
              throw new TerminalToolError(
                "command_recovery_unavailable",
                "This run lost durable Terminal submission authority before Daytona accepted the command. Stop and report the interrupted command; do not repeat it.",
              );
            }
          },
          onSubmitted: async (providerTaskId) => {
            const submittedAt = Date.now();
            const recorded = await terminal.markTaskRunning({
              effectIntentId,
              providerTaskId,
              commandDeadlineAt: submittedAt + input.timeoutMs + DAYTONA_REQUEST_TIMEOUT_MS,
              now: submittedAt,
            });
            if (!recorded) {
              throw new TerminalToolError(
                "command_recovery_unavailable",
                "The provider accepted the command after its durable authority was retired. Stop and report the ambiguity; do not repeat the command.",
              );
            }
          },
        });
        state = result.timedOut ? "timed_out" : result.exitCode === 0 ? "completed" : "failed";
        terminationReason = result.timedOut ? "timed_out" : "exited";
      } catch (error) {
        if (error instanceof TerminalToolError) throw error;
        throw new TerminalToolError(
          "command_outcome_unknown",
          context.signal.aborted
            ? "Cancellation interrupted provider observation. Rally retained the durable task so a linked run can prove the named command stopped; do not repeat the command."
            : "Rally lost provider observation before the command reached a final state. Retry this exact tool call so Rally can reattach to its durable task; do not submit a different command.",
          context.signal.aborted
            ? { reason: "Continue in a linked run so Rally can clean up the retained provider command before using Terminal again." }
            : { reason: "Resume this run so Rally can reattach to the same durable command task." },
        );
      }
      const sanitizedStdout = sanitizeTerminalOutput(result.stdout);
      const sanitizedStderr = sanitizeTerminalOutput(result.stderr);
      const stdout = bounded(sanitizedStdout);
      const stderr = bounded(sanitizedStderr);
      const completeLog = new TextEncoder().encode(
        `# stdout\n${sanitizedStdout}\n# stderr\n${sanitizedStderr}`,
      );
      const outputLimitExceeded = completeLog.byteLength > MAX_COMMAND_LOG_BYTES;
      let outputResourceId: string | undefined;
      if (outputLimitExceeded) {
        state = "failed";
        terminationReason = "output_limit_exceeded";
      }
      const completedAt = Date.now();
      const taskSettled = await terminal.settleTask({
        effectIntentId,
        runId: context.harnessRunId,
        sandboxGeneration: sandbox.generation,
        sandboxId: sandbox.providerSandboxId,
        state,
        exitCode: state === "timed_out" || outputLimitExceeded
          ? null
          : result.exitCode,
        terminationReason,
        stdoutHead: stdout.head,
        stdoutTail: stdout.tail,
        stderrHead: stderr.head,
        stderrTail: stderr.tail,
        stdoutBytes: stdout.bytes,
        stderrBytes: stderr.bytes,
        completedAt,
        now: completedAt,
      });
      if (taskSettled && (stdout.tail || stderr.tail || outputLimitExceeded)) {
        const logBytes = outputLimitExceeded
          ? new TextEncoder().encode(
              `${new TextDecoder().decode(completeLog.slice(0, Math.floor((MAX_COMMAND_LOG_BYTES - OUTPUT_LIMIT_MARKER_RESERVE_BYTES) / 2)))}\n`
              + `… ${completeLog.byteLength - MAX_COMMAND_LOG_BYTES} bytes omitted at capture limit …\n`
              + new TextDecoder().decode(completeLog.slice(completeLog.byteLength - Math.floor((MAX_COMMAND_LOG_BYTES - OUTPUT_LIMIT_MARKER_RESERVE_BYTES) / 2))),
            )
          : completeLog;
        try {
          const published = await resources.publishResource(context, {
            providerResourceId: `terminal-command-log:${effectIntentId}`,
            filePath: `.rally/logs/${effectIntentId}.log`,
            displayName: `Terminal command log ${effectIntentId}`,
            description: outputLimitExceeded
              ? "Bounded command log; provider output exceeded Rally's capture limit."
              : "Complete output from a Terminal command whose inline result was truncated.",
          }, logBytes);
          if (
            typeof published.resourceId === "string"
            && await terminal.attachTaskOutputResource({
              effectIntentId,
              runId: context.harnessRunId,
              sandboxGeneration: sandbox.generation,
              state,
              completedAt,
              outputResourceId: published.resourceId,
              now: Date.now(),
            })
          ) {
            outputResourceId = published.resourceId;
          }
        } catch {
          // The command has already executed. Returning its bounded durable
          // result is safer than throwing and inviting a model to rerun it.
        }
      }
      // Daytona returned a definitive result, so preserve it in this runtime
      // even if tokenized recovery won durable settlement first. The obsolete
      // harness continuation will discard it at its receipt fence. Only the
      // settlement winner deletes the exact effect-unique named session; a
      // recovery loser owns no provider cleanup authority.
      if (taskSettled) {
        await provider.cleanupCommand?.(sandbox.providerSandboxId, taskName).catch(() => undefined);
      }
      return {
        state,
        terminationReason,
        exitCode: state === "timed_out" || outputLimitExceeded ? null : result.exitCode,
        stdout: joinedCapture(stdout.head, stdout.tail),
        stderr: joinedCapture(stderr.head, stderr.tail),
        ...(outputResourceId ? { outputResourceId } : {}),
        startedAt: isoAt(startedAt),
        completedAt: isoAt(completedAt),
        acquisitionDurationMs,
        totalDurationMs: Date.now() - totalStartedAt,
      };
    },

    async importResource(context, input) {
      const sandbox = await acquire(context);
      const destination = "destinationPath" in input
        ? input.destinationPath
        : `${RESOURCE_ROOT}/${input.resourceId}/resource`;
      await resolveInsideRoot(context, sandbox, destination);
      return resources.importResource(
        context,
        input,
        destination,
        sandbox.generation,
        sandbox.providerSandboxId,
        provider,
      );
    },

    async publishResource(context, input) {
      // The bridge checks this too, for a direct caller; this one is what keeps
      // the four provider commands below from running for a doomed call.
      requireTerminalEffectIntent(context, "publication");
      const sandbox = await acquire(context);
      const path = absolutePath(`${OUTPUT_ROOT}/${input.filePath}`);
      // What the path *is* decides everything downstream, and it is asked once
      // rather than assumed: before this widening `publish_resource` refused a
      // directory outright, so a caller that passed one got a hard error where
      // it now gets a site or an archive.
      const target = await inspectPublishTarget(context, sandbox, path);
      if (target.shape === "directory") {
        return publishDirectory(context, input, sandbox, path, target.entries);
      }
      const before = await inspectGeneratedFile(context, sandbox, path, "before");
      if (before.size === 0) {
        throw new TerminalToolError(
          "resource_empty",
          "The output file is empty. Inspect its producer, regenerate a non-empty result, and publish that file.",
          { field: "filePath", reason: "Regenerate a non-empty final file beneath AVALON_RESOURCE_DIR." },
        );
      }
      if (before.size > 25_000_000) {
        throw new TerminalToolError(
          "resource_limit_exceeded",
          `The output file is ${before.size} bytes; publication allows at most 25000000 bytes. Reduce or split it before retrying.`,
          { field: "filePath", expected: "file bytes at most 25000000" },
        );
      }
      let bytes: Uint8Array;
      try {
        bytes = await provider.readFile(sandbox.providerSandboxId, path);
      } catch {
        throw new TerminalToolError(
          "resource_not_ready",
          "The output changed or disappeared while Rally was reading it. Wait for its producer to finish, then retry publish_resource with the final file.",
          { reason: "Wait for the producer to finish, then retry with the final stable file." },
        );
      }
      const after = await inspectGeneratedFile(context, sandbox, path, "after");
      const observedDigest = await sha256Hex(bytes);
      if (
        before.size !== bytes.byteLength
        || after.size !== before.size
        || before.sha256 !== observedDigest
        || after.sha256 !== before.sha256
      ) {
        throw new TerminalToolError(
          "resource_not_ready",
          "The output changed while Rally was reading it. Wait for its command to finish, then write or rename the final file and use a new publish_resource invocation.",
          { reason: "Wait for the producer to finish, then retry with the final stable file." },
        );
      }
      return resources.publishResource(context, input, bytes);
    },

    async publishBranchAndPr(context, input) {
      // The publisher checks this too; its guard sits behind this `acquire`.
      requireTerminalEffectIntent(context, "repositoryPublication");
      const sandbox = await acquire(context);
      return publisher.publishBranchAndPr(context, input, sandbox, provider);
    },
  };
}
