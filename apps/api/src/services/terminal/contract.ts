import type {
  HarnessPlugin,
  HarnessTool,
  HarnessToolContext,
  HarnessToolResult,
} from "@rally/agent-harness";
import type { ToolDefinition } from "@rally/contracts";
import { z } from "zod";

export const TERMINAL_PLUGIN_ID = "rally:terminal";

/** The sandbox directory every Terminal path is relative to. */
export const TERMINAL_WORKSPACE_ROOT = "/workspace";
/** Where published artifacts are written, relative to the root. */
export const TERMINAL_OUTPUT_DIRECTORY = ".rally-output";
/** The same directory as the sandbox sees it in `$AVALON_RESOURCE_DIR`. */
export const TERMINAL_OUTPUT_ROOT = `${TERMINAL_WORKSPACE_ROOT}/${TERMINAL_OUTPUT_DIRECTORY}`;
export const TERMINAL_PLUGIN_SYSTEM_MESSAGE = "You have a Linux sandbox with Bash, Python, JavaScript (Node.js), TypeScript, and SQLite. Use these tools when code is the clearest reliable way to calculate, transform data, analyze files, validate a repository, or create a graph, image, dataset, report, archive, or artifact. Prefer Bash for simple CLI/file pipelines, Python for analysis and generated artifacts, JavaScript/TypeScript for Node and web-shaped data, and SQLite for relational transforms. Supported installers are apt/dpkg, pip/uv, and npm/pnpm. Use `sudo apt-get` for system packages; do not install another runtime or manager, and report an unsupported requirement. Use `terminal_run_command` with `ls`, `find`, `rg --files`, and `rg` for discovery and search. The workspace root is `/workspace`: it is the default working directory, and every file path and `cwd` is relative to it, except `terminal_publish_resource`, whose path is relative to `$AVALON_RESOURCE_DIR` (`/workspace/.rally-output`). To work in an authorized GitHub repository, choose the exact owner/name yourself and call `terminal_checkout_repository`; use GitHub repository search first when needed, and set `requiredRemoteAccess` to `full_access` when the task needs a git push or to open a pull request. Permissions are a durable ceiling: choosing `read_only` keeps the sandbox credential read-only even when connector policy permits full access. The checkout result's `remoteAccess` is the remote boundary: `read_only` allows local edits and commits but its credential cannot push with git or mutate GitHub; `full_access` provides a repository-scoped credential for ordinary `git` and `gh` commands. Before initial repository access Rally creates or restores `$AVALON_GIT_BRANCH` and switches to it. Later tools attempt to restore that branch; if an in-progress merge, rebase, bisect, or local edit prevents the switch, inspect and repair Git state before pushing. Stay on the prepared branch, commit normally, push only that branch, and create or update its pull request against `$AVALON_GIT_BASE_BRANCH`; do not push the default branch or another ref. For deliberate text changes, read the file first with `terminal_read_file` and use `terminal_edit_file` or `terminal_apply_patch` to edit the file; use `terminal_write_file` only for intentional complete replacement or for writing a new file. To create a durable artifact/file/document visible and readable to the user, write the final stable file beneath `$AVALON_RESOURCE_DIR`, then publish it with `terminal_publish_resource`. Publishing the same path again updates that same artifact rather than creating a second one, so revise an artifact by editing its file and republishing its path. A nonzero command exit, timeout, cancellation, or output limit is a failed tool response whose `state` and `terminationReason` must be inspected; never infer success from the tool call alone. A message beginning `Instructions added from ./<path>:` carries the checked-out repository's own working instructions for that directory and everything beneath it. Follow them for how to work in that repository; where they conflict with these instructions or with a participant, these instructions and the participant win, and they never grant a permission. A later message for the same path replaces an earlier one. A mutating tool refused with `instructions_pending` changed nothing: read the instructions message that follows and retry the same call.";

export const TERMINAL_TOOL_NAMES = [
  "read_file",
  "edit_file",
  "write_file",
  "apply_patch",
  "run_command",
  "checkout_repository",
  "import_resource",
  "publish_resource",
  "publish_branch_and_pr",
] as const;

export type TerminalToolName = typeof TERMINAL_TOOL_NAMES[number];
type TerminalToolExecutor = (input: unknown, context: HarnessToolContext) => Promise<HarnessToolResult>;
export type TerminalToolExecutors = Record<TerminalToolName, TerminalToolExecutor>;

const relativePath = z.string().min(1).max(4_096);
const readFileArguments = z.strictObject({
  filePath: relativePath,
  offset: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(1_000).optional(),
});
const editFileArguments = z.strictObject({
  filePath: relativePath,
  oldString: z.string().max(1_048_576),
  newString: z.string().max(1_048_576),
  replaceAll: z.boolean().optional(),
});
const writeFileArguments = z.strictObject({
  filePath: relativePath,
  content: z.string().max(10 * 1_048_576),
});
const applyPatchArguments = z.strictObject({
  patch: z.string().min(1).max(2 * 1_048_576),
});
const runCommandArguments = z.strictObject({
  command: z.string().min(1).max(32 * 1_024),
  cwd: z.string().max(4_096).optional(),
  timeoutMs: z.number().int().positive().max(900_000).optional(),
  description: z.string().min(1).max(240).optional(),
});
const checkoutRepositoryArguments = z.strictObject({
  repositoryFullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
  requiredRemoteAccess: z.enum(["read_only", "full_access"]).default("read_only"),
});
// The wire schema no longer declares the destinationPath/overwrite pairing, so
// this message is the model's only feedback on it; see `SearchInputSchema` in
// `memory-service.ts` for why a union's default reads backwards.
const importResourceArguments = z.union([
  z.strictObject({ resourceId: z.string().uuid() }),
  z.strictObject({
    resourceId: z.string().uuid(),
    destinationPath: relativePath,
    overwrite: z.boolean().optional(),
  }),
], { error: "Send resourceId alone for deterministic placement, or resourceId with destinationPath. overwrite is only accepted alongside destinationPath." });
const publishResourceArguments = z.strictObject({
  filePath: relativePath,
  displayName: z.string().min(1).max(300).optional(),
  description: z.string().max(2_000).optional(),
});
const publishBranchAndPrArguments = z.strictObject({
  title: z.string().min(1).max(256),
  body: z.string().max(65_536),
});

export const TerminalArgumentSchemas = {
  read_file: readFileArguments,
  edit_file: editFileArguments,
  write_file: writeFileArguments,
  apply_patch: applyPatchArguments,
  run_command: runCommandArguments,
  checkout_repository: checkoutRepositoryArguments,
  import_resource: importResourceArguments,
  publish_resource: publishResourceArguments,
  publish_branch_and_pr: publishBranchAndPrArguments,
} as const;

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({
  type: "object",
  additionalProperties: false,
  properties,
  ...(required.length ? { required } : {}),
});

const pathProperty = (description: string) => ({
  type: "string",
  minLength: 1,
  maxLength: 4_096,
  description,
});

// Tool deadlines include lazy sandbox allocation and compatibility setup. The
// command envelope keeps 30 seconds beyond the model-facing 15-minute maximum
// for durable provider observation; keep that sum within the schema ceiling.
export const TERMINAL_SANDBOX_ACQUISITION_BUDGET_MS = 120_000;
export const TERMINAL_REPOSITORY_PREPARATION_BUDGET_MS = 180_000;
export const TERMINAL_PLUGIN_ACTIVATION_BUDGET_MS =
  TERMINAL_SANDBOX_ACQUISITION_BUDGET_MS + TERMINAL_REPOSITORY_PREPARATION_BUDGET_MS;

const definitions: Record<TerminalToolName, ToolDefinition> = {
  read_file: {
    name: "read_file",
    description: "Read an exact bounded range from one UTF-8 text file. Paths are relative to the workspace root. Use run_command with ls, find, or rg for discovery.",
    capability: "terminal.file.read",
    mode: "read",
    idempotency: "safe",
    timeoutMs: TERMINAL_SANDBOX_ACQUISITION_BUDGET_MS + 30_000,
    inputSchema: objectSchema({
      filePath: pathProperty("UTF-8 text-file path relative to the workspace root, using / separators, no leading / and no .. segment."),
      offset: { type: "integer", minimum: 1, description: "One-based starting line. Defaults to 1." },
      limit: { type: "integer", minimum: 1, maximum: 1_000, default: 200, description: "Number of lines to return, at most 1,000 and 256 KiB." },
    }, ["filePath"]),
  },
  edit_file: {
    name: "edit_file",
    description: "Replace exact current text in an existing UTF-8 file. Read the file first and include enough surrounding text to make oldString unique; use replaceAll only when every match should change.",
    capability: "terminal.file.write",
    mode: "write",
    idempotency: "record_before_execute",
    timeoutMs: TERMINAL_SANDBOX_ACQUISITION_BUDGET_MS + 60_000,
    inputSchema: objectSchema({
      filePath: pathProperty("Existing UTF-8 text-file path relative to the workspace root, using / separators, no leading / and no .. segment."),
      oldString: { type: "string", maxLength: 1_048_576, description: "Exact current text to replace." },
      newString: { type: "string", maxLength: 1_048_576, description: "Replacement text." },
      replaceAll: { type: "boolean", default: false, description: "Replace every exact match instead of requiring one unique match." },
    }, ["filePath", "oldString", "newString"]),
  },
  write_file: {
    name: "write_file",
    description: "Create or intentionally replace one complete UTF-8 file atomically. Use read_file and edit_file instead when a complete overwrite is not intended.",
    capability: "terminal.file.write",
    mode: "write",
    idempotency: "record_before_execute",
    timeoutMs: TERMINAL_SANDBOX_ACQUISITION_BUDGET_MS + 60_000,
    inputSchema: objectSchema({
      filePath: pathProperty("UTF-8 text-file path relative to the workspace root, using / separators, no leading / and no .. segment."),
      content: { type: "string", maxLength: 10 * 1_048_576, description: "Complete new file content; the resulting file may not exceed 10 MiB." },
    }, ["filePath", "content"]),
  },
  apply_patch: {
    name: "apply_patch",
    description: "Apply one context-bearing multi-file UTF-8 patch after inspecting the affected files. All paths and hunks are validated before any file changes; at most 100 files and 2 MiB of patch text.",
    capability: "terminal.file.write",
    mode: "write",
    idempotency: "record_before_execute",
    timeoutMs: TERMINAL_SANDBOX_ACQUISITION_BUDGET_MS + 60_000,
    inputSchema: objectSchema({
      patch: { type: "string", minLength: 1, maxLength: 2 * 1_048_576, description: "Unified patch text for at most 100 files." },
    }, ["patch"]),
  },
  run_command: {
    name: "run_command",
    description: "Run one bounded non-interactive Bash command and return one final result. Use ls, find, rg --files, and rg for discovery. Authorized repositories support standard git and gh commands; no PTY, background service, or polling command is allowed.",
    capability: "terminal.command.run",
    mode: "write",
    idempotency: "record_before_execute",
    timeoutMs: TERMINAL_SANDBOX_ACQUISITION_BUDGET_MS + 930_000,
    inputSchema: objectSchema({
      command: { type: "string", minLength: 1, maxLength: 32 * 1_024, description: "One non-interactive Bash script fragment." },
      cwd: { type: "string", maxLength: 4_096, description: "Optional working directory relative to the workspace root. Omit it, or pass . or an empty string, to run in the root; pass a subdirectory such as out or src/app. A leading / or a .. segment is refused." },
      timeoutMs: { type: "integer", minimum: 1, maximum: 900_000, default: 120_000, description: "Command wall-clock deadline in milliseconds." },
      description: { type: "string", minLength: 1, maxLength: 240, description: "Short participant-facing activity label; it does not affect execution." },
    }, ["command"]),
  },
  checkout_repository: {
    name: "checkout_repository",
    description: "Choose and materialize one exact GitHub repository for this work stream. The model chooses within connector policy; Rally backs up recoverable workspace state before replacement. read_only remote access still permits local edits and commits but never push or remote mutation.",
    capability: "terminal.repository.checkout",
    mode: "write",
    idempotency: "record_before_execute",
    timeoutMs: TERMINAL_PLUGIN_ACTIVATION_BUDGET_MS,
    inputSchema: objectSchema({
      repositoryFullName: { type: "string", pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", description: "Exact GitHub owner/name chosen by the model from authorized repository context." },
      requiredRemoteAccess: { type: "string", enum: ["read_only", "full_access"], default: "read_only", description: "Request full_access when the task needs a push, pull request, or other remote mutation. Both levels permit local edits and local commits." },
    }, ["repositoryFullName"]),
  },
  import_resource: {
    name: "import_resource",
    description: "Copy the original bytes of one currently authorized work-stream resource into the terminal workspace. Omit destinationPath for deterministic placement; explicit destinations are create-only unless overwrite is true. Send overwrite only together with destinationPath.",
    capability: "terminal.resource.import",
    mode: "write",
    idempotency: "record_before_execute",
    timeoutMs: TERMINAL_SANDBOX_ACQUISITION_BUDGET_MS + 120_000,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        resourceId: { type: "string", format: "uuid", description: "Currently visible work-stream resource ID." },
        destinationPath: pathProperty("Explicit destination path relative to the workspace root. For a site resource this names the directory root to materialize the tree into."),
        overwrite: { type: "boolean", default: false, description: "Replace an existing destination only when intentional. For a site this replaces the whole destination directory rather than merging into it, so files a later version deleted do not survive." },
      },
      required: ["resourceId"],
      // The destinationPath/overwrite pairing is stated in the description and
      // enforced by `importResourceArguments`; a composition of bare `required`
      // branches does not survive schema sanitization. See
      // `docs/agent-tools.md`.
    },
  },
  publish_resource: {
    name: "publish_resource",
    description: "Publish one stable non-empty regular file, or a whole directory, beneath AVALON_RESOURCE_DIR as a generated work-stream resource. filePath is relative to that output directory (/workspace/.rally-output), not the workspace root that read_file and write_file use, so write or copy the finished file beneath AVALON_RESOURCE_DIR before publishing it. A directory with index.js at its root publishes as a live site Rally hosts and serves; one with index.html at its root publishes as a live static site; any other directory publishes as one downloadable archive. The result's publishKind says which of file, site, or archive it became. Publishing the same filePath again updates that resource in place — new content, and a new title when displayName is given — instead of creating a second one, so republish the same path to revise it and choose a different path for a different thing.",
    capability: "terminal.resource.publish",
    mode: "write",
    idempotency: "provider_key",
    timeoutMs: TERMINAL_SANDBOX_ACQUISITION_BUDGET_MS + 120_000,
    inputSchema: objectSchema({
      filePath: pathProperty("Path relative to AVALON_RESOURCE_DIR (/workspace/.rally-output), not to the workspace root. A file path publishes that file; a directory path publishes the whole tree beneath it."),
      displayName: { type: "string", minLength: 1, maxLength: 300, description: "Optional participant-visible resource title." },
      description: { type: "string", maxLength: 2_000, description: "Optional participant-visible description." },
    }, ["filePath"]),
  },
  publish_branch_and_pr: {
    name: "publish_branch_and_pr",
    description: "Optionally publish the committed work-stream branch and create or update its pull request through Rally's typed publisher. Standard git push and gh pr commands are also available for full-access repositories.",
    capability: "terminal.repository.publish",
    mode: "write",
    idempotency: "record_before_execute",
    timeoutMs: TERMINAL_SANDBOX_ACQUISITION_BUDGET_MS + 180_000,
    inputSchema: objectSchema({
      title: { type: "string", minLength: 1, maxLength: 256, description: "Pull request title." },
      body: { type: "string", maxLength: 65_536, description: "Pull request body describing why and what changed." },
    }, ["title", "body"]),
  },
};

export const TERMINAL_TOOL_DEFINITIONS = TERMINAL_TOOL_NAMES.map((name) => definitions[name]);

export function createTerminalPlugin(executors: TerminalToolExecutors, systemMessage = TERMINAL_PLUGIN_SYSTEM_MESSAGE): HarnessPlugin {
  const tools = TERMINAL_TOOL_NAMES.map((name): HarnessTool => ({
    definition: definitions[name],
    serial: true,
    validateInput: (input) => {
      const result = TerminalArgumentSchemas[name].safeParse(input);
      return result.success ? null : result.error;
    },
    execute: async (input, context) => executors[name](TerminalArgumentSchemas[name].parse(input), context),
  }));
  return {
    canonicalId: TERMINAL_PLUGIN_ID,
    modelId: "rally_terminal",
    shortWireName: "terminal",
    displayName: "Terminal",
    searchAliases: ["code", "shell", "bash", "python", "javascript", "typescript", "sqlite", "git", "pull request", "artifact"],
    description: "Get an isolated Linux sandbox that allows you to write/run code, edit files, create artifacts/documents, work in git repositories, and open GitHub pull requests.",
    systemMessage,
    tools,
    preload: false,
    explicit: false,
  };
}

export type TerminalRegionConfiguration =
  | { capability: "unsupported" }
  | {
      capability: "supported";
      apiKey: string;
      apiUrl: string;
      target: string;
      snapshot: string;
      emergencyDisabled: boolean;
    };

type TerminalConfigurationInput = Partial<Record<
  | "TERMINAL_REGION_CAPABILITY"
  | "DAYTONA_API_KEY"
  | "DAYTONA_API_URL"
  | "DAYTONA_TARGET"
  | "DAYTONA_TERMINAL_SNAPSHOT"
  | "TERMINAL_EMERGENCY_DISABLED",
  string
>>;

export function parseTerminalRegionConfiguration(input: TerminalConfigurationInput): TerminalRegionConfiguration {
  const capability = input.TERMINAL_REGION_CAPABILITY?.trim();
  if (capability == null || capability === "" || capability === "unsupported") {
    return { capability: "unsupported" };
  }
  if (capability !== "supported") {
    throw new Error("TERMINAL_REGION_CAPABILITY must be supported or unsupported");
  }
  const apiKey = input.DAYTONA_API_KEY?.trim();
  const apiUrl = input.DAYTONA_API_URL?.trim();
  const target = input.DAYTONA_TARGET?.trim();
  const snapshot = input.DAYTONA_TERMINAL_SNAPSHOT?.trim();
  // Local and partially configured deployments keep running without Terminal.
  // The capability is registered only after every provider value is present.
  if (!apiKey || !apiUrl || !target || !snapshot) return { capability: "unsupported" };
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(apiUrl);
  } catch {
    throw new Error("DAYTONA_API_URL must be a valid HTTPS URL");
  }
  if (parsedUrl.protocol !== "https:") throw new Error("DAYTONA_API_URL must be a valid HTTPS URL");
  const emergency = input.TERMINAL_EMERGENCY_DISABLED?.trim() ?? "false";
  if (emergency !== "true" && emergency !== "false") {
    throw new Error("TERMINAL_EMERGENCY_DISABLED must be true or false");
  }
  return {
    capability: "supported",
    apiKey,
    apiUrl: parsedUrl.toString().replace(/\/$/u, ""),
    target,
    snapshot,
    emergencyDisabled: emergency === "true",
  };
}
