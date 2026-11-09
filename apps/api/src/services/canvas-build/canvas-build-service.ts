import type { HarnessToolContext } from "@rally/agent-harness";
import { asUserId } from "@rally/contracts";
import { newId } from "@rally/db";

import type { AuthContext, Env } from "../../env";
import { numericEnv } from "../../env";
import { ApiError } from "../../lib/api-error";
import { sha256Hex } from "../../lib/crypto";
import { logStructuredEvent } from "../../observability/logger";
import { createHarnessRunPortFactory, type HarnessRunPortFactory } from "../../runtime/harness-run-port";
import { createResourcePortFactory, type ResourcePortFactory } from "../../runtime/resource-port";
import { parseTerminalRegionConfiguration } from "../terminal/contract";
import { PUBLICATION_BUILD_HOLDER, TerminalSandboxCoordinator, type TerminalClock } from "../terminal/coordinator";
import { createTerminalPortFactory, type TerminalPortFactory } from "../terminal/object-port";
import type { TerminalSandboxProvider } from "../terminal/provider-contract";
import { terminalShellQuote as quote } from "../terminal/provider-contract";
import { createTerminalProviderRpcClient } from "../terminal/provider-rpc-client";
import { TerminalToolError } from "../terminal/tools";
import { withWorkspaceRuntimeDatabase } from "../workspace-runtime-database";
import { refreshWorkspaceSchedule } from "../workstream-wakeup-service";
import BUILD_SCRIPT from "./build.sandbox.mjs";

/**
 * How long one build may run: the Terminal's own ceiling for a command
 * (`runCommandArguments.timeoutMs` in `terminal/contract.ts`, 900 seconds),
 * inside the operation lease (16 minutes) the build holds. Not a new number.
 */
const BUILD_TIMEOUT_MS = 900_000;

/** One file of what was built, read back out of the sandbox and checked. */
export interface BuiltFile { path: string; bytes: Uint8Array; sha256: string }

export interface BuiltSite {
  files: BuiltFile[];
  renderedTextLength: number;
}

/**
 * Builds a person's published component or project into a static site in the
 * Canvas's own Terminal sandbox, and checks it renders.
 *
 * The sandbox is acquired through the same coordinator an agent run uses, as
 * the person, so the sandbox's rules hold: its files are frozen to the person
 * who last used it, and someone else acquiring it gets a fresh one, exactly
 * as their own agent run would. The build holds the operation lease as a
 * publication build (`PUBLICATION_BUILD_HOLDER`), which the storage keeps live
 * until it expires: an agent run waits (`sandbox_busy`) rather than taking
 * the sandbox mid-build, and the idle sweep does not stop it. The build works
 * outside the agent's `/workspace`, in a directory it deletes when it ends.
 * `docs/rally-mcp.md#building`.
 */
export class CanvasBuildService {
  constructor(
    private readonly env: Env,
    private readonly auth: AuthContext,
    /**
     * What a test builds with in place of the region's Daytona and the
     * Canvas's own objects. Production passes nothing.
     */
    private readonly injected: {
      provider: TerminalSandboxProvider;
      terminalPort: TerminalPortFactory;
      resourcePort: ResourcePortFactory;
      runsPort: HarnessRunPortFactory;
      clock?: TerminalClock;
    } | null = null,
  ) {}

  async build(canvasId: string, source: { kind: "component"; entry: string } | { kind: "project" },
    files: ReadonlyArray<{ path: string; bytes: Uint8Array }>): Promise<BuiltSite> {
    const runtime = withWorkspaceRuntimeDatabase(this.env, this.auth.workspaceId);
    const configuration = parseTerminalRegionConfiguration(runtime);
    if (!this.injected && configuration.capability !== "supported") {
      throw new ApiError(503, "canvas_build_unavailable", "Rally cannot build components or projects in this deployment; publish the built files with their index.html");
    }
    const owned = this.injected ? null : configuration.capability === "supported"
      ? createTerminalProviderRpcClient(runtime.TERMINAL_PROVIDER, configuration) : null;
    const provider = this.injected?.provider ?? owned!;
    const coordinator = new TerminalSandboxCoordinator(
      runtime,
      this.injected?.terminalPort ?? createTerminalPortFactory(runtime, undefined, "0"),
      this.injected?.resourcePort ?? createResourcePortFactory(runtime),
      provider,
      this.injected?.clock,
      (workspaceId) => refreshWorkspaceSchedule(runtime, workspaceId),
      configuration.capability === "supported" ? configuration.emergencyDisabled : false,
      undefined,
      { parentKind: "canvas", backgroundAgent: false, runSubstreamId: PUBLICATION_BUILD_HOLDER, authoritySubstreamId: "0",
        runsPort: this.injected?.runsPort ?? createHarnessRunPortFactory(runtime) },
    );
    const buildId = newId();
    const abort = new AbortController();
    const context: HarnessToolContext = {
      workspaceId: this.auth.workspaceId,
      workstreamId: canvasId,
      harnessRunId: buildId,
      toolCallId: buildId,
      executionPrincipal: { type: "user", userId: asUserId(this.auth.userId) },
      signal: abort.signal,
    };
    const directory = `/tmp/rally-canvas-build/${buildId}`;
    let sandboxId: string | null = null;
    try {
      const sandbox = await coordinator.acquire(context).catch((error: unknown) => {
        if (error instanceof TerminalToolError && error.code === "sandbox_busy") {
          throw new ApiError(409, "canvas_build_sandbox_busy", "Rally is using this Canvas's workspace right now; publish again in a moment");
        }
        if (error instanceof TerminalToolError) {
          throw new ApiError(503, `canvas_build_sandbox_unavailable:${error.code}`, error.message);
        }
        throw error;
      });
      sandboxId = sandbox.providerSandboxId;
      const sourceDirectory = `${directory}/source`;
      const parents = new Set([directory, sourceDirectory,
        ...files.map((file) => `${sourceDirectory}/${file.path}`.split("/").slice(0, -1).join("/"))]);
      await provider.runUtilityCommand(sandboxId, { operation: "canvas.build.run", cwd: "/workspace", timeoutMs: 60_000,
        command: `mkdir -p ${[...parents].map(quote).join(" ")}`, signal: abort.signal });
      for (const file of files) await provider.writeFile(sandboxId, `${sourceDirectory}/${file.path}`, file.bytes, abort.signal);
      const encoder = new TextEncoder();
      await provider.writeFile(sandboxId, `${directory}/build.mjs`, encoder.encode(BUILD_SCRIPT), abort.signal);
      await provider.writeFile(sandboxId, `${directory}/request.json`, encoder.encode(JSON.stringify({
        sourceDirectory, workDirectory: `${directory}/work`, kind: source.kind, ...(source.kind === "component" ? { entry: source.entry } : {}),
      })), abort.signal);

      // The build's own output goes to a log beside it; only the report, its
      // last line, comes back.
      const ran = await provider.runUtilityCommand(sandboxId, { operation: "canvas.build.run", cwd: "/workspace", timeoutMs: BUILD_TIMEOUT_MS,
        command: `node ${quote(`${directory}/build.mjs`)} ${quote(`${directory}/request.json`)} > ${quote(`${directory}/build.log`)} 2>&1; tail -n 1 ${quote(`${directory}/build.log`)}`,
        signal: abort.signal });
      if (ran.timedOut) throw new ApiError(422, "canvas_build_timed_out", "The build did not finish in time");
      const report = parseReport(ran.stdout);
      if (!report.ok) throw new ApiError(422, report.code, report.message);
      if (!report.outputDirectory.startsWith(`${directory}/work/`)) throw new ApiError(500, "canvas_build_output_outside", "canvas_build_output_outside");

      const listed = await provider.runUtilityCommand(sandboxId, { operation: "canvas.build.inspect", cwd: "/workspace", timeoutMs: 60_000,
        command: `cd ${quote(report.outputDirectory)} && find . -type f -printf "%s %P\\n" | sort -k2 | while read -r size path; do printf "%s %s %s\\n" "$size" "$(sha256sum "$path" | cut -d" " -f1)" "$path"; done`,
        signal: abort.signal });
      const entries = listed.stdout.split("\n").filter(Boolean).map((line) => {
        const [size, sha256, ...rest] = line.split(" ");
        return { sizeBytes: Number(size), sha256: sha256!, path: rest.join(" ") };
      });
      const total = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
      const maximum = numericEnv(this.env, "MAX_ATTACHMENT_BYTES", 25_000_000);
      if (total > maximum) throw new ApiError(413, "attachment_too_large", `The built site is ${total} bytes; an artifact may be at most ${maximum}`);
      const built: BuiltFile[] = [];
      for (const entry of entries) {
        const bytes = await provider.readFile(sandboxId, `${report.outputDirectory}/${entry.path}`);
        const digest = await sha256Hex(bytes);
        if (digest !== entry.sha256 || bytes.byteLength !== entry.sizeBytes) {
          throw new ApiError(500, "canvas_build_output_changed", "canvas_build_output_changed");
        }
        built.push({ path: entry.path, bytes, sha256: digest });
      }
      logStructuredEvent(this.env, "info", "canvas_build_succeeded", {
        workspace_id: this.auth.workspaceId, canvas_id: canvasId, build_id: buildId, source: source.kind, files: built.length,
      });
      return { files: built, renderedTextLength: report.rendered.text };
    } catch (error) {
      logStructuredEvent(this.env, "warn", "canvas_build_failed", {
        workspace_id: this.auth.workspaceId, canvas_id: canvasId, build_id: buildId, source: source.kind,
        code: error instanceof ApiError ? error.code : error instanceof Error ? error.name : "unknown",
      });
      throw error;
    } finally {
      if (sandboxId) {
        await provider.runUtilityCommand(sandboxId, { operation: "canvas.build.cleanup", cwd: "/workspace", timeoutMs: 60_000,
          command: `rm -rf ${quote(directory)}` }).catch(() => undefined);
      }
      await coordinator.release(context).catch(() => undefined);
      owned?.[Symbol.dispose]();
    }
  }
}

type BuildReport =
  | { ok: true; outputDirectory: string; files: string[]; rendered: { text: number; elements: number } }
  | { ok: false; code: string; message: string };

/** The report on the build's last line, or a refusal naming why there is none. */
function parseReport(stdout: string): BuildReport {
  const line = stdout.trim().split("\n").at(-1) ?? "";
  try {
    const report = JSON.parse(line) as BuildReport;
    if (typeof report === "object" && report !== null && typeof report.ok === "boolean") return report;
  } catch { /* named below */ }
  return { ok: false, code: "canvas_build_report_missing", message: "The build ended without saying what happened" };
}
