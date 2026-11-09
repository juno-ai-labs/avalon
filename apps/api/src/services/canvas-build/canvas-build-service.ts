import { DEFAULT_MAX_ATTACHMENT_BYTES } from "@rally/contracts";
import type { HarnessToolContext } from "@rally/agent-harness";
import { asUserId } from "@rally/contracts";
import { zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";
import { newId } from "@rally/db";
import { z } from "zod";

import type { AuthContext, Env } from "../../env";
import { numericEnv } from "../../env";
import { ApiError } from "../../lib/api-error";
import { sha256Hex } from "../../lib/crypto";
import { logStructuredEvent } from "../../observability/logger";
import { createHarnessRunPortFactory, type HarnessRunPortFactory } from "../../runtime/harness-run-port";
import { createResourcePortFactory, type ResourcePortFactory } from "../../runtime/resource-port";
import { parseTerminalRegionConfiguration } from "../terminal/contract";
import {
  PUBLICATION_BUILD_HOLDER,
  TerminalSandboxCoordinator,
  type AcquiredTerminalSandbox,
  type TerminalClock,
} from "../terminal/coordinator";
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
 * inside the operation lease (16 minutes) the build renews just before it
 * starts. Not a new number.
 */
const BUILD_TIMEOUT_MS = 900_000;

/**
 * The deadline on the build's small sandbox steps: making its directories and
 * removing them. Each finishes in well under a second; this only stops a hung
 * provider call from holding the publish. Half the Terminal's own default
 * command deadline (120 s); not measured, and the team's to change.
 */
const SANDBOX_STEP_TIMEOUT_MS = 60_000;

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
 * the person, so the sandbox's rules hold: it is the Canvas's one shared
 * sandbox for its selected repository, the same one every participant's agent
 * run uses, not one of the person's own. The build holds the operation lease
 * as a publication build (`PUBLICATION_BUILD_HOLDER`), which the storage keeps
 * live until it expires: an agent run waits (`sandbox_busy`) rather than
 * taking the sandbox mid-build, and the idle sweep does not stop it. The
 * lease is renewed before the build runs and again before its output is read,
 * by claiming it again as the same holder, and the build stops if it was lost
 * in between. The build works outside the agent's `/workspace`, in a
 * directory it deletes when it ends, and stops waiting when the publish that
 * asked for it is abandoned (`signal`), giving the sandbox back.
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
    files: ReadonlyArray<{ path: string; bytes: Uint8Array }>, signal: AbortSignal = new AbortController().signal): Promise<BuiltSite> {
    // A project build runs the publisher's own package.json scripts, with no
    // model between them and the shared sandbox, which holds the Canvas's
    // repository checkout and its GitHub credentials. A guest may publish a
    // component, whose code only the pinned toolchain runs; a project build is
    // for the Organization's members (the team's decision of 2026-11-09).
    if (source.kind === "project" && this.auth.role === null) {
      throw new ApiError(403, "canvas_build_project_members_only",
        "Only the Organization's members can publish a project that Rally builds; build it yourself and publish its built files with their index.html");
    }
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
    const context: HarnessToolContext = {
      workspaceId: this.auth.workspaceId,
      workstreamId: canvasId,
      harnessRunId: buildId,
      toolCallId: buildId,
      executionPrincipal: { type: "user", userId: asUserId(this.auth.userId) },
      signal,
    };
    const cancelled = () => new ApiError(409, "canvas_build_cancelled", "The publish was abandoned before its build finished");
    // The lease again, as the same holder, for the next step; the step does
    // not start on a sandbox someone else now holds or that was replaced.
    const renew = async (sandbox: AcquiredTerminalSandbox) => {
      if (signal.aborted) throw cancelled();
      const held = await coordinator.claimForOperation(context, sandbox).catch((error: unknown) => {
        if (error instanceof TerminalToolError) throw new ApiError(409, `canvas_build_sandbox_lost:${error.code}`, "Rally needed this Canvas's workspace during the build; publish again in a moment");
        throw error;
      });
      if (held !== "held") throw new ApiError(409, "canvas_build_sandbox_lost:stale", "This Canvas's workspace changed during the build; publish again");
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
      await provider.runUtilityCommand(sandboxId, { operation: "canvas.build.run", cwd: "/workspace", timeoutMs: SANDBOX_STEP_TIMEOUT_MS,
        command: `mkdir -p ${[...parents].map(quote).join(" ")}`, signal });
      for (const file of files) await provider.writeFile(sandboxId, `${sourceDirectory}/${file.path}`, file.bytes, signal);
      const encoder = new TextEncoder();
      await provider.writeFile(sandboxId, `${directory}/build.mjs`, encoder.encode(BUILD_SCRIPT), signal);
      await provider.writeFile(sandboxId, `${directory}/request.json`, encoder.encode(JSON.stringify({
        sourceDirectory, workDirectory: `${directory}/work`, kind: source.kind, ...(source.kind === "component" ? { entry: source.entry } : {}),
      })), signal);
      await renew(sandbox);

      // The build's own output goes to a log beside it; only the report, its
      // last line, comes back.
      const ran = await provider.runUtilityCommand(sandboxId, { operation: "canvas.build.run", cwd: "/workspace", timeoutMs: BUILD_TIMEOUT_MS,
        command: `node ${quote(`${directory}/build.mjs`)} ${quote(`${directory}/request.json`)} > ${quote(`${directory}/build.log`)} 2>&1; tail -n 1 ${quote(`${directory}/build.log`)}`,
        signal });
      if (ran.timedOut) throw new ApiError(422, "canvas_build_timed_out", "The build did not finish in time");
      const report = parseReport(ran.stdout);
      if (!report.ok) throw new ApiError(422, report.code, report.message);
      if (!withinDirectory(report.outputDirectory, `${directory}/work`)) throw new ApiError(500, "canvas_build_output_outside", "canvas_build_output_outside");

      // The report's list, read once each and hashed here: the digest an
      // asset is stored under is the Worker's, of the bytes it holds.
      const maximum = numericEnv(this.env, "MAX_ATTACHMENT_BYTES", DEFAULT_MAX_ATTACHMENT_BYTES);
      const reported = report.files.reduce((sum, file) => sum + file.size, 0);
      if (reported > maximum) throw new ApiError(413, "attachment_too_large", `The built site is ${reported} bytes; an artifact may be at most ${maximum}`);
      await renew(sandbox);
      const built: BuiltFile[] = [];
      let total = 0;
      for (const file of [...report.files].sort((left, right) => left.path.localeCompare(right.path))) {
        if (signal.aborted) throw cancelled();
        const bytes = await provider.readFile(sandboxId, `${report.outputDirectory}/${file.path}`);
        total += bytes.byteLength;
        if (total > maximum) throw new ApiError(413, "attachment_too_large", `The built site is over ${maximum} bytes, the most an artifact may be`);
        built.push({ path: file.path, bytes, sha256: await sha256Hex(bytes) });
      }
      logStructuredEvent(this.env, "info", "canvas_build_succeeded", {
        workspace_id: this.auth.workspaceId, canvas_id: canvasId, build_id: buildId, source: source.kind, files: built.length,
      });
      return { files: built, renderedTextLength: report.rendered.text };
    } catch (caught) {
      // Whatever a call cut short by the abort threw, the reason is the abort.
      const error = signal.aborted && !(caught instanceof ApiError && caught.code === "canvas_build_cancelled") ? cancelled() : caught;
      logStructuredEvent(this.env, "warn", "canvas_build_failed", {
        workspace_id: this.auth.workspaceId, canvas_id: canvasId, build_id: buildId, source: source.kind,
        code: error instanceof ApiError ? error.code : error instanceof Error ? error.name : "unknown",
      });
      throw error;
    } finally {
      if (sandboxId) {
        await provider.runUtilityCommand(sandboxId, { operation: "canvas.build.cleanup", cwd: "/workspace", timeoutMs: SANDBOX_STEP_TIMEOUT_MS,
          command: `rm -rf ${quote(directory)}` }).catch(() => undefined);
      }
      await coordinator.release(context).catch(() => undefined);
      owned?.[Symbol.dispose]();
    }
  }
}

/** Whether `path`, an absolute path with no `.` or `..` segment, lies strictly inside `directory`. */
function withinDirectory(path: string, directory: string): boolean {
  return path.startsWith(`${directory}/`) && !path.split("/").some((segment) => segment === ".." || segment === ".");
}

/** A path relative to the output directory that stays inside it. */
const BuiltPathSchema = z.string().min(1).refine((path) => !path.startsWith("/")
  && path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."), "outside_output");

/** What `build.sandbox.mjs` reports on its last line. */
const BuildReportSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    outputDirectory: z.string(),
    files: z.array(z.object({ path: BuiltPathSchema, size: z.number().int().nonnegative() })),
    rendered: z.object({ text: z.number().int().nonnegative() }),
  }),
  z.object({ ok: z.literal(false), code: z.string().min(1), message: z.string() }),
]);
type BuildReport = z.infer<typeof BuildReportSchema>;

/**
 * The report on the build's last line. A line that is not JSON is no report
 * (the build died before writing one, its log keeps why); a report that is
 * JSON but not this shape is refused naming the field it got wrong.
 */
function parseReport(stdout: string): BuildReport {
  const line = stdout.trim().split("\n").at(-1) ?? "";
  let value: unknown;
  try { value = JSON.parse(line); } catch {
    return { ok: false, code: "canvas_build_report_missing", message: "The build ended without saying what happened" };
  }
  const parsed = BuildReportSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const code = zodDiagnosticCode(parsed.error, "canvas_build_report")!;
  throw new ApiError(500, code, code);
}
