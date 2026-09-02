import type { HarnessToolContext, HarnessToolResult } from "@rally/agent-harness";
import type { AttachmentKind } from "@rally/contracts";
import type { z } from "zod";

import { TerminalArgumentSchemas, type TerminalToolExecutors } from "./contract";
import type { TerminalCheckoutRepositoryOutput } from "./repository-selection";

const MAX_FILE_BYTES = 10 * 1_048_576;
const MAX_INLINE_OUTPUT_BYTES = 128 * 1_024;

type ReadFileInput = z.infer<typeof TerminalArgumentSchemas.read_file>;
type EditFileInput = z.infer<typeof TerminalArgumentSchemas.edit_file>;
type WriteFileInput = z.infer<typeof TerminalArgumentSchemas.write_file>;
type ApplyPatchInput = z.infer<typeof TerminalArgumentSchemas.apply_patch>;
type RunCommandInput = z.infer<typeof TerminalArgumentSchemas.run_command>;
type CheckoutRepositoryInput = z.infer<typeof TerminalArgumentSchemas.checkout_repository>;
type ImportResourceInput = z.infer<typeof TerminalArgumentSchemas.import_resource>;
type PublishResourceInput = z.infer<typeof TerminalArgumentSchemas.publish_resource>;
type PublishBranchAndPrInput = z.infer<typeof TerminalArgumentSchemas.publish_branch_and_pr>;

export interface TerminalPatchOutput {
  files: Array<{
    path: string;
    previousPath?: string;
    operation: "created" | "edited" | "renamed" | "deleted";
    additions: number;
    deletions: number;
  }>;
  additions: number;
  deletions: number;
}

export interface TerminalCommandOutput {
  state: "completed" | "failed" | "timed_out" | "cancelled";
  terminationReason: "exited" | "timed_out" | "cancelled" | "output_limit_exceeded";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputResourceId?: string;
  startedAt: string;
  completedAt: string;
  /** Time spent making the existing or new sandbox ready for this invocation. */
  acquisitionDurationMs: number;
  /** Wall time inside the Terminal runtime, including acquisition and settlement. */
  totalDurationMs: number;
}

export interface TerminalImportResourceOutput {
  resourceId: string;
  filePath: string;
  outcome: "created" | "reused" | "replaced";
  mimeType: string;
  sizeBytes: number;
  sourceSha256: string;
}

export interface TerminalPublishedResourceOutput {
  resourceId: string;
  title: string;
  /**
   * What this path published as.
   *
   * The real discriminant, and it exists because `resourceType` is not one: a
   * document and an archive are both `generated_file`, so a model told to
   * switch on `resourceType` would have to infer the archive branch from the
   * presence of `fileCount` — which is inference, not a contract.
   */
  publishKind: "file";
  resourceType: "generated_file";
  provider: "avalon_generated";
  mimeType: string;
  sizeBytes: number;
  sourceSha256: string;
  attachmentKind: AttachmentKind;
  contentMode: "read" | "view" | "unsupported";
  derivativeStatus: "pending" | "ready" | "unsupported";
  createdAt: string;
}

/**
 * A directory that carried no site entry, bundled into one downloadable zip.
 *
 * It shares `resourceType: "generated_file"` with the file shape because it
 * *is* a generated file — the zip Rally produced. What distinguishes it is
 * `fileCount`, and nothing downstream needs it to be a different kind.
 */
export interface TerminalPublishedArchiveOutput
  extends Omit<TerminalPublishedResourceOutput, "publishKind"> {
  publishKind: "archive";
  fileCount: number;
  totalBytes: number;
}

/**
 * A directory that published as a live site.
 *
 * `sizeBytes` and `sourceSha256` from the file shape are deliberately renamed
 * here rather than reused: `totalBytes` is the tree's total and
 * `manifestSha256` hashes a manifest, and a caller comparing either against a
 * file's would be comparing different things. `contentMode` and
 * `derivativeStatus` are absent — a site has no single content body to read and
 * no derivative to wait on, which is exactly why a content read on one
 * redirects to the Terminal import instead.
 */
export interface TerminalPublishedSiteOutput {
  resourceId: string;
  title: string;
  publishKind: "site";
  resourceType: "generated_site";
  provider: "avalon_generated";
  attachmentKind: "site";
  slug: string | null;
  url: string;
  mode: "static" | "active";
  stateful: boolean;
  version: number;
  mimeType: string;
  fileCount: number;
  totalBytes: number;
  manifestSha256: string;
  createdAt: string;
}

/**
 * What `publish_resource` returns, discriminated by `publishKind`.
 *
 * Three shapes from one tool, so a model reading the registry can tell which it
 * got without guessing — and `publishKind` rather than `resourceType`, because
 * a document and an archive share the latter. Every member carries
 * `resourceId`, `title`, `provider`, `attachmentKind`, and `createdAt`, so the
 * discriminant and the identity are always in the same places.
 */
export type TerminalPublishOutput =
  | TerminalPublishedResourceOutput
  | TerminalPublishedArchiveOutput
  | TerminalPublishedSiteOutput;

export interface TerminalPublishedBranchAndPrOutput {
  repository: string;
  baseRef: string;
  headRef: string;
  commitSha: string;
  publishedSha: string;
  outcome: "created" | "updated" | "unchanged";
  pullRequest: {
    number: number;
    url: string;
    title: string;
    state: "open";
  };
}

export interface TerminalWriteFileOutput {
  created: boolean;
  previousLines: number;
}

export interface TerminalWriteFileOptions {
  /** UTF-8 content this same tool invocation already read and validated. */
  previousText: string;
}

export interface TerminalReadFilePage {
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  nextOffset?: number;
}

export interface TerminalRuntime {
  readFile(context: HarnessToolContext, filePath: string): Promise<Uint8Array | null>;
  readFilePage(
    context: HarnessToolContext,
    filePath: string,
    offset: number,
    limit: number,
  ): Promise<TerminalReadFilePage | null>;
  writeFile(
    context: HarnessToolContext,
    filePath: string,
    bytes: Uint8Array,
    options?: TerminalWriteFileOptions,
  ): Promise<TerminalWriteFileOutput>;
  applyPatch(context: HarnessToolContext, patch: string): Promise<TerminalPatchOutput>;
  runCommand(context: HarnessToolContext, input: {
    command: string;
    cwd?: string;
    timeoutMs: number;
    description?: string;
  }): Promise<TerminalCommandOutput>;
  checkoutRepository(context: HarnessToolContext, input: CheckoutRepositoryInput): Promise<TerminalCheckoutRepositoryOutput>;
  importResource(context: HarnessToolContext, input: ImportResourceInput): Promise<TerminalImportResourceOutput>;
  publishResource(context: HarnessToolContext, input: PublishResourceInput): Promise<TerminalPublishOutput>;
  publishBranchAndPr(context: HarnessToolContext, input: PublishBranchAndPrInput): Promise<TerminalPublishedBranchAndPrOutput>;
}

export class TerminalToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TerminalToolError";
  }
}

/**
 * The receipt identity a Terminal effect is keyed to, or a typed refusal.
 *
 * Read this *before* anything reaches the provider. It used to be a query, so
 * the three call sites did their sandbox work first and checked afterwards;
 * now that the identity arrives on the tool context the check is a field read,
 * and running it late means a call that was always going to be rejected can
 * still create or start a sandbox, claim the mutation lease, and burn a
 * generation on the way out.
 *
 * The message differs per path because it tells the model which call to
 * retry, and those strings are participant-facing.
 */
const MISSING_RECEIPT = {
  command: {
    message: "Rally could not find the durable tool receipt. Retry the command so it can be recorded safely.",
    reason: "Retry the same command call so Rally can create its durable receipt first.",
  },
  publication: {
    message: "Rally could not find the durable tool receipt. Retry publication so it can be recorded safely.",
    reason: "Retry the same publication call so Rally can create its durable receipt first.",
  },
  repositoryPublication: {
    message: "Rally could not find the durable publication receipt. Retry publication.",
    reason: "Retry the same publication call so Rally can create its durable receipt first.",
  },
} as const;

export function requireTerminalEffectIntent(
  context: HarnessToolContext,
  path: keyof typeof MISSING_RECEIPT,
): string {
  const effectIntentId = context.effectIntentId;
  if (effectIntentId) return effectIntentId;
  const { message, reason } = MISSING_RECEIPT[path];
  throw new TerminalToolError("tool_receipt_missing", message, { reason });
}

function pathOutsideRoot(field: "filePath" | "cwd"): never {
  throw new TerminalToolError(
    "path_outside_root",
    "The path must stay inside the terminal workspace. Use a relative path with `/` separators and no `..`.",
    { field, reason: "Use a workspace-relative path with / separators." },
  );
}

function safeRelativePath(value: string, field: "filePath" | "cwd"): string {
  if (
    !value
    || value.startsWith("/")
    || value.includes("\\")
    || value.includes("\0")
    || value.split("/").some((segment) => segment === "..")
  ) {
    return pathOutsideRoot(field);
  }
  const normalized = value.split("/").filter((segment) => segment && segment !== ".").join("/");
  if (!normalized) return pathOutsideRoot(field);
  return normalized;
}

function decodeText(bytes: Uint8Array, filePath: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TerminalToolError(
      "not_text_file",
      "This is not a regular UTF-8 text file. Use `terminal_run_command` with `file` or `ls -l` for metadata, or use resource tools for binary bytes.",
      { reason: `Use terminal_run_command to inspect ${filePath} without reading binary bytes into the model.` },
    );
  }
}

function boundedUtf8(value: string, maximumBytes: number, field: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > maximumBytes) {
    throw new TerminalToolError(
      "limit_exceeded",
      "The request exceeds this tool’s limit. Reduce the identified range, bytes, output, or file count and try again.",
      { field, expected: `at most ${maximumBytes} UTF-8 bytes` },
    );
  }
  return bytes;
}

function linesIn(value: string): number {
  if (!value) return 0;
  const lines = value.split("\n");
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

function countMatches(value: string, search: string): number {
  if (!search) return value.length + 1;
  let count = 0;
  let offset = 0;
  while (true) {
    const match = value.indexOf(search, offset);
    if (match < 0) return count;
    count += 1;
    offset = match + search.length;
  }
}

export function sanitizeTerminalOutput(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex -- provider output may contain ANSI terminal escapes
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "")
    // eslint-disable-next-line no-control-regex -- strip every non-printing terminal control except tab/newline/CR
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "")
    .replace(/\b(?:(?:gh[pousr]|github_pat|npm)_[A-Za-z0-9_-]{16,}|sk[-_][A-Za-z0-9_-]{16,}|dtn_(?:secret_)?[A-Za-z0-9_-]{8,})\b/gu, "[REDACTED]");
}

function truncateHeadTail(value: string): { value: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= MAX_INLINE_OUTPUT_BYTES) return { value, truncated: false };
  const half = Math.floor(MAX_INLINE_OUTPUT_BYTES / 2);
  const decoder = new TextDecoder();
  const head = decoder.decode(bytes.slice(0, half));
  const tail = decoder.decode(bytes.slice(bytes.byteLength - half));
  return {
    value: `${head}\n… ${bytes.byteLength - MAX_INLINE_OUTPUT_BYTES} bytes omitted …\n${tail}`,
    truncated: true,
  };
}

function rejectCommand(command: string): void {
  const reason = (() => {
    if (/\b(?:nohup|setsid|disown|tmux|screen)\b/iu.test(command) || /(?<!&)&\s*$/u.test(command)) {
      return "Background processes and detached sessions are unavailable; use one bounded foreground command.";
    }
    if (/\b(?:ssh|telnet)\b/iu.test(command)) {
      return "Interactive terminal and remote shell commands are unavailable.";
    }
    return null;
  })();
  if (reason) {
    throw new TerminalToolError(
      "command_rejected",
      "This command requests unsupported terminal behavior. Use one bounded non-interactive command or a dedicated file tool instead.",
      { reason },
    );
  }
}

function summarizeCommand(input: RunCommandInput, output: TerminalCommandOutput): string {
  const label = input.description?.trim() || input.command.trim().split("\n", 1)[0]!.slice(0, 120);
  return `${output.state === "completed" ? "Completed" : "Finished"} ${label}`;
}

export function createTerminalToolExecutors(runtime: TerminalRuntime): TerminalToolExecutors {
  return {
    async read_file(rawInput, context): Promise<HarnessToolResult> {
      const input: ReadFileInput = TerminalArgumentSchemas.read_file.parse(rawInput);
      const filePath = safeRelativePath(input.filePath, "filePath");
      const offset = input.offset ?? 1;
      const requestedLimit = input.limit ?? 200;
      const page = await runtime.readFilePage(context, filePath, offset, requestedLimit);
      if (!page) {
        throw new TerminalToolError(
          "not_found",
          "The requested file was not found. Use `terminal_run_command` with `pwd` and `ls -la` or `find` to inspect available paths before trying another file.",
          { reason: "Inspect the terminal workspace root before choosing another path." },
        );
      }
      return {
        output: {
          filePath,
          ...page,
        },
        summary: `Read ${filePath} lines ${page.startLine}–${page.endLine}`,
      };
    },
    async edit_file(rawInput, context): Promise<HarnessToolResult> {
      const input: EditFileInput = TerminalArgumentSchemas.edit_file.parse(rawInput);
      const filePath = safeRelativePath(input.filePath, "filePath");
      const priorBytes = await runtime.readFile(context, filePath);
      if (!priorBytes) {
        throw new TerminalToolError("not_found", "The requested file was not found. Use `terminal_run_command` with `pwd` and `ls -la` or `find` to inspect available paths before trying another file.", { reason: "Inspect the terminal workspace root, then read the current file." });
      }
      const prior = decodeText(priorBytes, filePath);
      const matches = countMatches(prior, input.oldString);
      if (matches === 0) {
        throw new TerminalToolError("match_not_found", "`oldString` was not found. Read the file again, copy exact current text, and rebuild the edit.", { reason: `Call terminal_read_file for ${filePath}, then rebuild oldString from current text.` });
      }
      if (!input.replaceAll && matches !== 1) {
        throw new TerminalToolError("match_not_unique", "`oldString` matches more than once. Include more surrounding text, or use `replaceAll: true` only if every match should change.", { reason: `oldString has ${matches} exact matches; include unique context or intentionally replace all ${matches}.` });
      }
      const replacements = input.replaceAll ? matches : 1;
      const content = input.replaceAll
        ? prior.split(input.oldString).join(input.newString)
        : prior.replace(input.oldString, input.newString);
      const bytes = boundedUtf8(content, MAX_FILE_BYTES, "filePath");
      await runtime.writeFile(context, filePath, bytes, { previousText: prior });
      return {
        output: {
          filePath,
          replacements,
          additions: linesIn(input.newString) * replacements,
          deletions: linesIn(input.oldString) * replacements,
        },
        summary: `Edited ${filePath}`,
      };
    },
    async write_file(rawInput, context): Promise<HarnessToolResult> {
      const input: WriteFileInput = TerminalArgumentSchemas.write_file.parse(rawInput);
      const filePath = safeRelativePath(input.filePath, "filePath");
      const bytes = boundedUtf8(input.content, MAX_FILE_BYTES, "content");
      const replaced = await runtime.writeFile(context, filePath, bytes);
      return {
        output: {
          filePath,
          created: replaced.created,
          bytes: bytes.byteLength,
          additions: linesIn(input.content),
          deletions: replaced.previousLines,
        },
        summary: `${replaced.created ? "Created" : "Replaced"} ${filePath}`,
      };
    },
    async apply_patch(rawInput, context): Promise<HarnessToolResult> {
      const input: ApplyPatchInput = TerminalArgumentSchemas.apply_patch.parse(rawInput);
      const paths = [...input.patch.matchAll(/^(?:\+\+\+|---)\s+(.+?)(?:\t.*)?$/gmu)]
        .map((match) => {
          const raw = match[1]!;
          try { return (raw.startsWith('"') ? JSON.parse(raw) as string : raw).replace(/^[ab]\//u, ""); }
          catch { throw new TerminalToolError("patch_invalid", "A patch file header is malformed. Regenerate the unified patch and retry."); }
        })
        .filter((path) => path !== "/dev/null");
      if (new Set(paths).size > 100) {
        throw new TerminalToolError("limit_exceeded", "The request exceeds this tool’s limit. Reduce the identified range, bytes, output, or file count and try again.", { field: "patch", expected: "at most 100 files" });
      }
      for (const path of paths) safeRelativePath(path, "filePath");
      try {
        const output = await runtime.applyPatch(context, input.patch);
        return { output, summary: `Patched ${output.files.length} file${output.files.length === 1 ? "" : "s"}` };
      } catch (error) {
        if (error instanceof TerminalToolError) throw error;
        throw new TerminalToolError("patch_does_not_apply", "The patch does not apply to the current contents. Read the affected files again and regenerate the whole patch.", { reason: "Read every affected file again; none of the patch was applied." });
      }
    },
    async run_command(rawInput, context): Promise<HarnessToolResult> {
      const input: RunCommandInput = TerminalArgumentSchemas.run_command.parse(rawInput);
      rejectCommand(input.command);
      const cwd = input.cwd ? safeRelativePath(input.cwd, "cwd") : undefined;
      const result = await runtime.runCommand(context, {
        command: input.command,
        ...(cwd ? { cwd } : {}),
        timeoutMs: input.timeoutMs ?? 120_000,
        ...(input.description ? { description: input.description } : {}),
      });
      const stdout = truncateHeadTail(sanitizeTerminalOutput(result.stdout));
      const stderr = truncateHeadTail(sanitizeTerminalOutput(result.stderr));
      const started = Date.parse(result.startedAt);
      const completed = Date.parse(result.completedAt);
      return {
        output: {
          ...result,
          stdout: stdout.value,
          stderr: stderr.value,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          durationMs: Number.isFinite(started) && Number.isFinite(completed) ? Math.max(0, completed - started) : 0,
        },
        summary: summarizeCommand(input, result),
      };
    },
    async checkout_repository(rawInput, context): Promise<HarnessToolResult> {
      const input: CheckoutRepositoryInput = TerminalArgumentSchemas.checkout_repository.parse(rawInput);
      const output = await runtime.checkoutRepository(context, input);
      const access = output.remoteAccess === "full_access"
        ? "full remote access"
        : "read-only remote access; local edits remain allowed";
      return { output, summary: `Checked out ${output.repository} with ${access}` };
    },
    async import_resource(rawInput, context): Promise<HarnessToolResult> {
      const input: ImportResourceInput = TerminalArgumentSchemas.import_resource.parse(rawInput);
      const placed = "destinationPath" in input
        ? { ...input, destinationPath: safeRelativePath(input.destinationPath, "filePath") }
        : input;
      const output = await runtime.importResource(context, placed);
      return { output, summary: `Imported resource ${input.resourceId}` };
    },
    async publish_resource(rawInput, context): Promise<HarnessToolResult> {
      const input: PublishResourceInput = TerminalArgumentSchemas.publish_resource.parse(rawInput);
      const output = await runtime.publishResource(context, {
        ...input,
        filePath: safeRelativePath(input.filePath, "filePath"),
      });
      return { output, summary: `Published ${output.title}` };
    },
    async publish_branch_and_pr(rawInput, context): Promise<HarnessToolResult> {
      const input: PublishBranchAndPrInput = TerminalArgumentSchemas.publish_branch_and_pr.parse(rawInput);
      const output = await runtime.publishBranchAndPr(context, input);
      return { output, summary: `Published pull request ${output.pullRequest.number}` };
    },
  };
}
