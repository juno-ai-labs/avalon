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

function fixture(answer: (input: { operation: string; command: string }) => { exitCode: number; stdout: string; stderr: string }) {
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
    sessionId: "session", userId: USER_ID, workspaceId: asWorkspaceId(WORKSPACE_ID), region: "global", role: "member",
  }, {
    provider,
    terminalPort: testTerminalPortFactory(objectStore),
    resourcePort: testResourcePortFactory(objectStore),
    runsPort: () => testHarnessRunPort(objectStore),
  });
  return { service, provider, objectStore, written, leaseDuringBuild };
}

/** The build directory the service staged into, read off the request it wrote. */
function buildDirectory(written: Map<string, Uint8Array>): string {
  const request = [...written.keys()].find((path) => path.endsWith("/request.json"))!;
  return request.slice(0, -"/request.json".length);
}

async function listing(...files: Array<[string, Uint8Array]>) {
  return (await Promise.all(files.map(async ([path, bytes]) => `${bytes.byteLength} ${await sha256Hex(bytes)} ${path}`))).join("\n");
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
        return { exitCode: 0, stderr: "", stdout: JSON.stringify({ ok: true, outputDirectory: `${directory}/work/dist`,
          files: ["app.js", "index.html"], rendered: { text: 2, elements: 3 } }) };
      }
      if (input.operation === "canvas.build.inspect") return { exitCode: 0, stderr: "", stdout: await listing(["app.js", script], ["index.html", page]) };
      return { exitCode: 0, stderr: "", stdout: "" };
    });

    const built = await service.build(CANVAS_ID, { kind: "component", entry: "Dashboard.jsx" }, source);

    expect(built.files.map((file) => [file.path, new TextDecoder().decode(file.bytes)]))
      .toEqual([["app.js", "console.log('built')"], ["index.html", new TextDecoder().decode(page)]]);
    expect(built.renderedTextLength).toBe(2);
    expect(written.get(`${directory}/source/Dashboard.jsx`)).toEqual(source[0]!.bytes);
    expect(JSON.parse(new TextDecoder().decode(written.get(`${directory}/request.json`))))
      .toEqual({ sourceDirectory: `${directory}/source`, workDirectory: `${directory}/work`, kind: "component", entry: "Dashboard.jsx" });
    // Held as a build while it ran; given back, and its directory gone, after.
    expect(leaseDuringBuild).toEqual([{ operation_run_substream_id: PUBLICATION_BUILD_HOLDER }]);
    expect(workstreamObjectGet(objectStore, "SELECT operation_run_id FROM terminal_workspace WHERE id = 1")).toEqual({ operation_run_id: null });
    expect(vi.mocked(provider.runUtilityCommand).mock.calls.at(-1)![1]).toMatchObject({
      operation: "canvas.build.cleanup", command: `rm -rf '${directory}'` });
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

  it("refuses output that does not match what the build listed", async () => {
    const { service, provider, written } = fixture(() => ({ exitCode: 0, stderr: "", stdout: "" }));
    vi.mocked(provider.runUtilityCommand).mockImplementation(async (_id, input) => {
      if (input.operation === "canvas.build.run" && input.command.startsWith("node ")) {
        return { exitCode: 0, stderr: "", stdout: JSON.stringify({ ok: true, outputDirectory: `${buildDirectory(written)}/work/dist`,
          files: ["index.html"], rendered: { text: 2, elements: 3 } }) };
      }
      // Listed as other bytes than the sandbox then hands back.
      if (input.operation === "canvas.build.inspect") return { exitCode: 0, stderr: "", stdout: await listing(["index.html", script]) };
      return { exitCode: 0, stderr: "", stdout: "" };
    });

    await expect(service.build(CANVAS_ID, { kind: "component", entry: "Dashboard.jsx" }, source))
      .rejects.toMatchObject({ code: "canvas_build_output_changed" });
  });
});
