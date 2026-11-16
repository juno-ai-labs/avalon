import { asUserId, asWorkspaceId } from "@rally/contracts";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sha256Hex } from "../src/lib/crypto";
import { CanvasBuildService } from "../src/services/canvas-build/canvas-build-service";
import { PUBLICATION_BUILD_HOLDER } from "../src/services/terminal/coordinator";
import type { TerminalSandboxProvider } from "../src/services/terminal/daytona-provider";
import { compileTerminalNetworkPolicy } from "../src/services/terminal/network-policy";
import { createTestEnv } from "./helpers/cloudflare-test";
import {
  seedWorkstreamObjectRoot,
  testHarnessRunPort,
  testResourcePortFactory,
  testTerminalPortFactory,
  testWorkstreamObjectStore,
  workstreamObjectGet,
  workstreamObjectRun,
} from "./helpers/durable-authority";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { createTestWorkspaceDO, testWorkspaceObjectBinding } from "./helpers/workspace-object-rpcs";

// The build service over the real coordinator and the Canvas's real sandbox
// row. Daytona is the one collaborator that cannot run here, so the provider
// is a double that answers as the build script would. The script itself is
// exercised against real artifacts by hand (`docs/rally-mcp.md#building`).

const WORKSPACE_ID = "00000000-0000-4000-8000-0000000000c1";
const CANVAS_ID = "00000000-0000-4000-8000-0000000000c2";
const USER_ID = asUserId("00000000-0000-4000-8000-0000000000c3");

const open: Array<{ close(): void }> = [];
afterEach(() => { for (const database of open.splice(0)) database.close(); });

const page = new TextEncoder().encode("<!doctype html><div id=root></div><script type=module src=app.js></script>");
const script = new TextEncoder().encode("console.log('built')");

function fixture(answer: (input: { operation: string; command: string }) => { exitCode: number; stdout: string; stderr: string },
  clock?: { now(): Date }, role: "member" | null = "member") {
  const database = preRetirementProductSqliteDatabase();
  open.push(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${USER_ID}', 'build-user', 'build@example.com', 'Build', '2026-11-09', '2026-11-09');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${WORKSPACE_ID}', 'Build', 'build', 'global', '${USER_ID}', '2026-11-09', '2026-11-09');
  `);
  const objectStore = testWorkstreamObjectStore();
  open.push(objectStore);
  seedWorkstreamObjectRoot(objectStore, { workstreamId: CANVAS_ID, workspaceId: WORKSPACE_ID });
  const objects: DatabaseSync[] = [];
  const written = new Map<string, Uint8Array>();
  const leaseDuringBuild: unknown[] = [];
  const provider: TerminalSandboxProvider = {
    createSandbox: vi.fn(async (input) => ({ id: "sandbox-1", name: input.stableName, state: "running" as const, domainAllowList: input.domainAllowList })),
    getSandbox: vi.fn(async (name) => ({ id: "sandbox-1", name, state: "running" as const,
      domainAllowList: compileTerminalNetworkPolicy("trusted_only", []).effectiveDomains })),
    recoverSandbox: vi.fn(async () => undefined), startSandbox: vi.fn(async () => undefined), stopSandbox: vi.fn(async () => undefined),
    archiveSandbox: vi.fn(async () => undefined), deleteSandbox: vi.fn(async () => undefined), updateNetworkPolicy: vi.fn(async () => undefined),
    configureGitHubReadAccess: vi.fn(async () => undefined), clearGitHubReadAccess: vi.fn(async () => undefined),
    writeFile: vi.fn(async (_id: string, path: string, bytes: Uint8Array) => { written.set(path, bytes); }),
    readFile: vi.fn(async (_id: string, path: string) => {
      if (path.endsWith("/index.html")) return page;
      if (path.endsWith("/app.js")) return script;
      throw new Error(`unexpected read ${path}`);
    }),
    runUtilityCommand: vi.fn(async (_id: string, input: { operation: string; command: string }) => {
      if (input.operation === "canvas.build.run" && input.command.startsWith("node ")) {
        leaseDuringBuild.push(workstreamObjectGet(objectStore,
          "SELECT operation_run_substream_id FROM terminal_workspace WHERE id = 1"));
      }
      return answer(input);
    }),
    runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    cleanupCommand: vi.fn(async () => undefined),
  };
  const env = createTestEnv({
    DB: sqliteD1(database), AVALON_REGION: "global", APP_ENV: "test",
    WORKSPACE_DOS: testWorkspaceObjectBinding(createTestWorkspaceDO({
      workspaceId: WORKSPACE_ID, regionalDatabase: database, register: (created) => { objects.push(created); open.push(created); },
    }).instance, ["terminalNetworkSettings"]),
  });
  const service = new CanvasBuildService(env, {
    sessionId: "session", userId: USER_ID, workspaceId: asWorkspaceId(WORKSPACE_ID), region: "global", role,
  }, {
    provider,
    terminalPort: testTerminalPortFactory(objectStore),
    resourcePort: testResourcePortFactory(objectStore),
    runsPort: () => testHarnessRunPort(objectStore),
    ...(clock ? { clock: { now: () => clock.now(), sleep: async () => undefined } } : {}),
  });
  return { service, provider, objectStore, written, leaseDuringBuild };
}

/** The build directory the service staged into, read off the request it wrote. */
function buildDirectory(written: Map<string, Uint8Array>): string {
  const request = [...written.keys()].find((path) => path.endsWith("/request.json"))!;
  return request.slice(0, -"/request.json".length);
}

/** A successful build's report on its last line, as `build.sandbox.mjs` writes it. */
function succeeded(directory: string, files: Array<[string, Uint8Array]>, overrides: Record<string, unknown> = {}) {
  return { exitCode: 0, stderr: "", stdout: `npm output\n${JSON.stringify({ ok: true, outputDirectory: `${directory}/work/dist`,
    files: files.map(([path, bytes]) => ({ path, size: bytes.byteLength })), rendered: { text: 2, visibleElements: 0 }, ...overrides })}` };
}

const source = [{ path: "Dashboard.jsx", bytes: new TextEncoder().encode("export default function App() { return <h1>Hi</h1>; }") }];

describe("building a person's component in the Canvas's sandbox", () => {
  it("builds under the publication build's lease, returns exactly the files the build reported, and leaves nothing held", async () => {
    let directory = "";
    const { service, provider, objectStore, written, leaseDuringBuild } = fixture(() => ({ exitCode: 0, stderr: "", stdout: "" }));
    vi.mocked(provider.runUtilityCommand).mockImplementation(async (_id, input) => {
      if (input.operation === "canvas.build.run" && input.command.startsWith("node ")) {
        leaseDuringBuild.push(workstreamObjectGet(objectStore, "SELECT operation_run_substream_id FROM terminal_workspace WHERE id = 1"));
        directory = buildDirectory(written);
        return succeeded(directory, [["index.html", page], ["app.js", script]]);
      }
      return { exitCode: 0, stderr: "", stdout: "" };
    });

    const built = await service.build(CANVAS_ID, { kind: "component", entry: "Dashboard.jsx" }, source);

    expect(built.files.map((file) => [file.path, new TextDecoder().decode(file.bytes)]))
      .toEqual([["app.js", "console.log('built')"], ["index.html", new TextDecoder().decode(page)]]);
    expect(built.files.map((file) => file.sha256)).toEqual([await sha256Hex(script), await sha256Hex(page)]);
    expect(built.renderedTextLength).toBe(2);
    // Each reported file read once, and nothing listed or hashed in the sandbox.
    expect(vi.mocked(provider.readFile).mock.calls.map((call) => call[1]))
      .toEqual([`${directory}/work/dist/app.js`, `${directory}/work/dist/index.html`]);
    expect(vi.mocked(provider.runUtilityCommand).mock.calls.map((call) => call[1].operation))
      .toEqual(["canvas.build.run", "canvas.build.run", "canvas.build.cleanup"]);
    expect(written.get(`${directory}/source/Dashboard.jsx`)).toEqual(source[0]!.bytes);
    expect(JSON.parse(new TextDecoder().decode(written.get(`${directory}/request.json`))))
      .toEqual({ sourceDirectory: `${directory}/source`, workDirectory: `${directory}/work`, kind: "component", entry: "Dashboard.jsx" });
    // Held as a build while it ran; given back, and its directory gone, after.
    expect(leaseDuringBuild).toEqual([{ operation_run_substream_id: PUBLICATION_BUILD_HOLDER }]);
    expect(workstreamObjectGet(objectStore, "SELECT operation_run_id FROM terminal_workspace WHERE id = 1")).toEqual({ operation_run_id: null });
    expect(vi.mocked(provider.runUtilityCommand).mock.calls.at(-1)![1]).toMatchObject({
      operation: "canvas.build.cleanup", command: `rm -rf '${directory}'` });
  });

  it("refuses a guest's project before anything reaches the sandbox, and builds a guest's component", async () => {
    const answer = () => ({ exitCode: 0, stderr: "", stdout: "" });
    const guest = fixture(answer, undefined, null);
    await expect(guest.service.build(CANVAS_ID, { kind: "project" }, source))
      .rejects.toMatchObject({ status: 403, code: "canvas_build_project_members_only" });
    expect(guest.provider.runUtilityCommand).not.toHaveBeenCalled();
    expect(guest.written.size).toBe(0);
    // A component runs only the pinned toolchain, so a guest reaches the build.
    await guest.service.build(CANVAS_ID, { kind: "component", entry: "Dashboard.jsx" }, source).catch(() => undefined);
    expect(guest.provider.runUtilityCommand).toHaveBeenCalled();
  });

  it("refuses with the build's own reason, and still gives the sandbox back", async () => {
    const { service, provider, objectStore } = fixture((input) => input.command.startsWith("node ")
      ? { exitCode: 0, stderr: "", stdout: JSON.stringify({ ok: false, code: "canvas_build_check_failed",
        message: "The site does not run: error: Cannot read properties of undefined (reading 'map')" }) }
      : { exitCode: 0, stderr: "", stdout: "" });

    await expect(service.build(CANVAS_ID, { kind: "component", entry: "Dashboard.jsx" }, source)).rejects.toMatchObject({
      status: 422, code: "canvas_build_check_failed" });
    expect(provider.readFile).not.toHaveBeenCalled();
    expect(workstreamObjectGet(objectStore, "SELECT operation_run_id FROM terminal_workspace WHERE id = 1")).toEqual({ operation_run_id: null });
    expect(vi.mocked(provider.runUtilityCommand).mock.calls.at(-1)![1]).toMatchObject({ operation: "canvas.build.cleanup" });
  });

  it("names the field a malformed report got wrong, and refuses an output path that climbs out", async () => {
    const malformed = fixture(() => ({ exitCode: 0, stderr: "", stdout: JSON.stringify({ ok: true, outputDirectory: "/x",
      files: [{ path: "index.html" }], rendered: { text: 1 } }) }));
    await expect(malformed.service.build(CANVAS_ID, { kind: "component", entry: "Dashboard.jsx" }, source))
      .rejects.toMatchObject({ status: 500, code: "canvas_build_report_invalid:files.0.size:invalid_type" });

    const climbing = fixture(() => ({ exitCode: 0, stderr: "", stdout: "" }));
    vi.mocked(climbing.provider.runUtilityCommand).mockImplementation(async (_id, input) => input.command.startsWith("node ")
      ? succeeded(buildDirectory(climbing.written), [["index.html", page]], { outputDirectory: `${buildDirectory(climbing.written)}/work/../../../etc` })
      : { exitCode: 0, stderr: "", stdout: "" });
    await expect(climbing.service.build(CANVAS_ID, { kind: "component", entry: "Dashboard.jsx" }, source))
      .rejects.toMatchObject({ code: "canvas_build_output_outside" });

    const escaping = fixture(() => ({ exitCode: 0, stderr: "", stdout: "" }));
    vi.mocked(escaping.provider.runUtilityCommand).mockImplementation(async (_id, input) => input.command.startsWith("node ")
      ? succeeded(buildDirectory(escaping.written), [["../../secret", page]])
      : { exitCode: 0, stderr: "", stdout: "" });
    await expect(escaping.service.build(CANVAS_ID, { kind: "component", entry: "Dashboard.jsx" }, source))
      .rejects.toMatchObject({ code: "canvas_build_report_invalid:files.0.path:custom" });
    expect(climbing.provider.readFile).not.toHaveBeenCalled();
    expect(escaping.provider.readFile).not.toHaveBeenCalled();
  });

  it("renews the lease after staging, so the build runs with a full lease however long staging took", async () => {
    let now = Date.parse("2026-11-09T12:00:00.000Z");
    const leases: unknown[] = [];
    const { service, provider, objectStore, written } = fixture(() => ({ exitCode: 0, stderr: "", stdout: "" }), { now: () => new Date(now) });
    vi.mocked(provider.writeFile).mockImplementation(async (_id, path, bytes) => {
      written.set(path, bytes);
      now += 10 * 60_000; // staging is slow
    });
    vi.mocked(provider.runUtilityCommand).mockImplementation(async (_id, input) => {
      if (!input.command.startsWith("node ")) return { exitCode: 0, stderr: "", stdout: "" };
      leases.push(workstreamObjectGet(objectStore, "SELECT operation_lease_expires_at FROM terminal_workspace WHERE id = 1"));
      return succeeded(buildDirectory(written), [["index.html", page]]);
    });

    await service.build(CANVAS_ID, { kind: "component", entry: "Dashboard.jsx" }, source);

    // Staged with three writes, ten minutes each; the lease runs 16 minutes from then.
    expect(leases).toEqual([{ operation_lease_expires_at: Date.parse("2026-11-09T12:30:00.000Z") + 16 * 60_000 }]);
  });

  it("stops before building when the lease was lost while staging, and leaves the new holder's lease alone", async () => {
    const { service, provider, objectStore, written } = fixture(() => ({ exitCode: 0, stderr: "", stdout: "" }));
    vi.mocked(provider.writeFile).mockImplementation(async (_id, path, bytes) => {
      written.set(path, bytes);
      if (path.endsWith("/request.json")) {
        workstreamObjectRun(objectStore, `UPDATE terminal_workspace SET operation_run_id = 'other-build',
          operation_run_substream_id = ?, operation_lease_expires_at = ? WHERE id = 1`, PUBLICATION_BUILD_HOLDER, Date.now() + 60_000);
      }
    });

    await expect(service.build(CANVAS_ID, { kind: "component", entry: "Dashboard.jsx" }, source))
      .rejects.toMatchObject({ status: 409, code: "canvas_build_sandbox_lost:sandbox_busy" });
    expect(vi.mocked(provider.runUtilityCommand).mock.calls.some((call) => call[1].command.startsWith("node "))).toBe(false);
    expect(workstreamObjectGet(objectStore, "SELECT operation_run_id FROM terminal_workspace WHERE id = 1"))
      .toEqual({ operation_run_id: "other-build" });
  });

  it("stops waiting on the build when the publish is abandoned, and still cleans up and gives the sandbox back", async () => {
    const abandoned = new AbortController();
    const { service, provider, objectStore } = fixture(() => ({ exitCode: 0, stderr: "", stdout: "" }));
    vi.mocked(provider.runUtilityCommand).mockImplementation(async (_id, input) => {
      if (!input.command.startsWith("node ")) return { exitCode: 0, stderr: "", stdout: "" };
      // The build is running when the person goes away; the provider's wait
      // ends with the signal, as the RPC client's does.
      return new Promise((_resolve, reject) => {
        input.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        abandoned.abort();
      });
    });

    await expect(service.build(CANVAS_ID, { kind: "component", entry: "Dashboard.jsx" }, source, abandoned.signal))
      .rejects.toMatchObject({ status: 409, code: "canvas_build_cancelled" });
    expect(provider.readFile).not.toHaveBeenCalled();
    expect(workstreamObjectGet(objectStore, "SELECT operation_run_id FROM terminal_workspace WHERE id = 1")).toEqual({ operation_run_id: null });
    expect(vi.mocked(provider.runUtilityCommand).mock.calls.at(-1)![1]).toMatchObject({ operation: "canvas.build.cleanup" });
  });
});
