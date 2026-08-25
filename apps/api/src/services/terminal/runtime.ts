import type { HarnessToolContext } from "@rally/agent-harness";
import { newId } from "@rally/db";

import { sha256Hex } from "../../lib/crypto";
import type { AcquiredTerminalSandbox, TerminalSandboxCoordinator } from "./coordinator";
import {
  DAYTONA_REQUEST_TIMEOUT_MS,
  isTerminalProviderNotFound,
  type TerminalSandboxProvider,
} from "./daytona-provider";
import type {
  TerminalCommandOutput,
  TerminalImportResourceOutput,
  TerminalPatchOutput,
  TerminalPublishedBranchAndPrOutput,
  TerminalPublishedResourceOutput,
  TerminalRuntime,
} from "./tools";
import { requireTerminalEffectIntent, sanitizeTerminalOutput, TerminalToolError } from "./tools";
import type { TerminalPortFactory } from "./object-port";
import type { TerminalTaskRecord } from "../../durable-objects/workstream-terminal-storage";
import type { TerminalRepositorySelector } from "./repository-selection";

const ROOT = "/workspace";
const RESOURCE_ROOT = ".rally/resources";
const OUTPUT_ROOT = ".rally-output";
const MAX_PROVIDER_CAPTURE_BYTES = 128 * 1_024;
const MAX_COMMAND_LOG_BYTES = 5_000_000;
const OUTPUT_LIMIT_MARKER_RESERVE_BYTES = 256;

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
    input: PublishInput,
    bytes: Uint8Array,
  ): Promise<TerminalPublishedResourceOutput>;
}

export interface TerminalRepositoryPublisher {
  publishBranchAndPr(
    context: HarnessToolContext,
    input: PublishPrInput,
    sandbox: AcquiredTerminalSandbox,
    provider: TerminalSandboxProvider,
  ): Promise<TerminalPublishedBranchAndPrOutput>;
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
  prepareSandbox?: (
    context: HarnessToolContext,
    sandbox: AcquiredTerminalSandbox,
    provider: TerminalSandboxProvider,
  ) => Promise<void>,
): TerminalRuntime {
  async function acquire(context: HarnessToolContext): Promise<AcquiredTerminalSandbox> {
    const sandbox = await coordinator.acquire(context);
    await prepareSandbox?.(context, sandbox, provider);
    return sandbox;
  }

  async function resolveInsideRoot(
    context: HarnessToolContext,
    sandbox: AcquiredTerminalSandbox,
    relativePath: string,
  ): Promise<string> {
    const intended = absolutePath(relativePath);
    const result = await provider.runCommand(sandbox.providerSandboxId, {
      taskName: `avalon-path-${context.toolCallId.replace(/[^a-zA-Z0-9_-]/gu, "").slice(0, 80)}`,
      command: `realpath -m -- ${shellQuote(intended)}`,
      cwd: ROOT,
      timeoutMs: 10_000,
      signal: context.signal,
    });
    const resolved = result.stdout.trim();
    if (result.exitCode !== 0 || (resolved !== ROOT && !resolved.startsWith(`${ROOT}/`))) {
      throw new TerminalToolError(
        "path_outside_root",
        "The requested path resolves outside the Terminal workspace, possibly through a symlink. Choose a path under the workspace root.",
        { field: "filePath", reason: "Use a path that does not traverse an escaping symlink." },
      );
    }
    return intended;
  }

  async function inspectGeneratedFile(
    context: HarnessToolContext,
    sandbox: AcquiredTerminalSandbox,
    path: string,
    phase: "before" | "after",
  ): Promise<{ size: number; sha256: string }> {
    const result = await provider.runCommand(sandbox.providerSandboxId, {
      taskName: `avalon-publish-${phase}-${context.toolCallId.replace(/[^a-zA-Z0-9_-]/gu, "").slice(0, 64)}`,
      command: [
        `target=${shellQuote(path)}`,
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
    async checkoutRepository(context, input) {
      if (!selector) {
        throw new TerminalToolError("repository_checkout_unavailable", "Repository checkout is unavailable in this Terminal runtime.");
      }
      return selector.checkout(context, input);
    },
    async readFile(context, filePath) {
      const sandbox = await acquire(context);
      const path = await resolveInsideRoot(context, sandbox, filePath);
      const metadata = await provider.runCommand(sandbox.providerSandboxId, {
        taskName: `avalon-read-stat-${context.toolCallId.replace(/[^a-zA-Z0-9_-]/gu, "").slice(0, 64)}`,
        command: [
          `target=${shellQuote(path)}`,
          'if [ ! -e "$target" ]; then exit 44; fi',
          'if [ -L "$target" ] || [ ! -f "$target" ]; then exit 45; fi',
          'stat -c %s -- "$target"',
        ].join("\n"),
        cwd: ROOT,
        timeoutMs: 10_000,
        signal: context.signal,
      });
      if (metadata.exitCode === 44) return null;
      if (metadata.exitCode === 45) {
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

    async writeFile(context, filePath, bytes) {
      const sandbox = await acquire(context);
      const target = await resolveInsideRoot(context, sandbox, filePath);
      const temporary = `${ROOT}/.rally/tmp/${newId()}`;
      await provider.writeFile(sandbox.providerSandboxId, temporary, bytes, context.signal);
      const result = await provider.runCommand(sandbox.providerSandboxId, {
        taskName: `avalon-write-${newId()}`,
        command: `target=${shellQuote(target)}; mkdir -p -- "$(dirname -- "$target")" && mv -- ${shellQuote(temporary)} "$target"`,
        cwd: ROOT,
        timeoutMs: 30_000,
        signal: context.signal,
      });
      if (result.exitCode !== 0) {
        throw new TerminalToolError("file_write_failed", "The atomic file replacement failed. Inspect the parent directory and retry.", { reason: "Inspect the parent directory and available space, then retry." });
      }
    },

    async applyPatch(context, patch) {
      const parsed = parsePatch(patch);
      const sandbox = await acquire(context);
      const temporary = `${ROOT}/.rally/tmp/${newId()}.patch`;
      await provider.writeFile(sandbox.providerSandboxId, temporary, new TextEncoder().encode(patch), context.signal);
      const result = await provider.runCommand(sandbox.providerSandboxId, {
        taskName: `avalon-patch-${newId()}`,
        command: `git apply --check -- ${shellQuote(temporary)} && git apply -- ${shellQuote(temporary)}; status=$?; rm -f -- ${shellQuote(temporary)}; exit $status`,
        cwd: ROOT,
        timeoutMs: 60_000,
        signal: context.signal,
      });
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
          "The earlier command may have run, but Avalon cannot prove that the current sandbox and input match it. Stop and report the ambiguity; do not repeat the command.",
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
            ? "Cancellation interrupted provider observation. Avalon retained the durable task so a linked run can prove the named command stopped; do not repeat the command."
            : "Avalon lost provider observation before the command reached a final state. Retry this exact tool call so Avalon can reattach to its durable task; do not submit a different command.",
          context.signal.aborted
            ? { reason: "Continue in a linked run so Avalon can clean up the retained provider command before using Terminal again." }
            : { reason: "Resume this run so Avalon can reattach to the same durable command task." },
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
            filePath: `.rally/logs/${effectIntentId}.log`,
            displayName: `Terminal command log ${effectIntentId}`,
            description: outputLimitExceeded
              ? "Bounded command log; provider output exceeded Avalon's capture limit."
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
      const path = await resolveInsideRoot(context, sandbox, `${OUTPUT_ROOT}/${input.filePath}`);
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
          "The output changed or disappeared while Avalon was reading it. Wait for its producer to finish, then retry publish_resource with the final file.",
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
          "The output changed while Avalon was reading it. Wait for its command to finish, then write or rename the final file and use a new publish_resource invocation.",
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
