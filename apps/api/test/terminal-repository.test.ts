import type { HarnessToolContext } from "@avalon/agent-harness";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TerminalSandboxProvider } from "../src/services/terminal/daytona-provider";
import {
  admitTerminalPublicationGrant,
  bootstrapTerminalRepository,
  createGitHubRestReadGateway,
  createTerminalRepositoryPublisher,
  type TerminalGitHubPublicationGateway,
} from "../src/services/terminal/repository";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const W = "20000000-0000-4000-8000-000000000001";
const S = "20000000-0000-4000-8000-000000000002";
const R = "20000000-0000-4000-8000-000000000003";
const U = "20000000-0000-4000-8000-000000000004";
const I = "20000000-0000-4000-8000-000000000005";
const CONNECTION = "20000000-0000-4000-8000-000000000006";
const MESSAGE = "20000000-0000-4000-8000-000000000007";
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const HEAD_REF = "avalon/workstream-20000000";

const openDatabases: ReturnType<typeof migratedSqliteDatabase>[] = [];
afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
  vi.unstubAllGlobals();
});

function fixture(message = "Please publish these changes and open a pull request") {
  const database = migratedSqliteDatabase();
  openDatabases.push(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${U}', 'repository-user', 'repository@example.com', 'Repository', '2026-08-13', '2026-08-13');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${W}', 'Repository', 'terminal-repository', 'global', '${U}', '2026-08-13', '2026-08-13');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('${W}', '${U}', 'owner', 'active', '2026-08-13');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id,
       harness_status, last_activity_at, created_at, updated_at)
    VALUES ('${S}', '${W}', 'Repository', 'Repository', 'ad_hoc', '${U}', 'idle',
            '2026-08-13', '2026-08-13', '2026-08-13');
    INSERT INTO workstream_participants
      (workstream_id, user_id, added_by_user_id, participation_reason, joined_at)
    VALUES ('${S}', '${U}', '${U}', 'creator', '2026-08-13');
    INSERT INTO connector_connections
      (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
       display_name, granted_scopes_json, model_plugin_id, status, created_at, updated_at)
    VALUES ('${CONNECTION}', '${W}', 'github', 'workspace', NULL, '123', 'GitHub',
            '["github.contents.read","github.pull_requests.read"]', 'plugin_github', 'healthy', '2026-08-13', '2026-08-13');
    INSERT INTO workstream_terminal_repositories
      (workspace_id, workstream_id, connection_id, repository_id, repository_full_name, base_ref,
       base_sha, head_ref, state, selected_by_user_id, created_at, updated_at)
    VALUES ('${W}', '${S}', '${CONNECTION}', 42, 'owner/repo', 'main', '${BASE}', '${HEAD_REF}',
            'selected', '${U}', '2026-08-13', '2026-08-13');
    INSERT INTO messages
      (id, workspace_id, workstream_id, author_type, author_user_id, message_type,
       text_content, sequence_number, created_at)
    VALUES ('${MESSAGE}', '${W}', '${S}', 'human', '${U}', 'text', '${message.replaceAll("'", "''")}', 1, '2026-08-13');
    INSERT INTO harness_runs
      (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at, trigger_message_id)
    VALUES ('${R}', '${W}', '${S}', 'test', '{"type":"user","userId":"${U}"}', 'running', '2026-08-13', '${MESSAGE}');
    INSERT INTO tool_invocations
      (id, workspace_id, workstream_id, harness_run_id, tool_call_id, tool_name, input_hash, input_json, status)
    VALUES ('${I}', '${W}', '${S}', '${R}', 'publish-call', 'terminal_publish_branch_and_pr', 'hash', '{}', 'started');
  `);
  const env = createTestEnv({ DB: sqliteD1(database), AVALON_REGION: "global" });
  const gateway: TerminalGitHubPublicationGateway = {
    mintWriteToken: vi.fn(async () => ({ accessToken: "write-token" })),
    verifyRepositoryIdentity: vi.fn(async () => undefined),
    getRef: vi.fn(async (_selection, ref) => ref === HEAD_REF ? null : BASE),
    findPullRequest: vi.fn(async () => null),
    createPullRequest: vi.fn(async () => ({ number: 9, url: "https://github.com/owner/repo/pull/9", state: "open" as const, headSha: HEAD, title: "Ship it" })),
    updatePullRequest: vi.fn(),
  };
  const provider: TerminalSandboxProvider = {
    createSandbox: vi.fn(), getSandbox: vi.fn(), startSandbox: vi.fn(), stopSandbox: vi.fn(), archiveSandbox: vi.fn(), deleteSandbox: vi.fn(), updateNetworkPolicy: vi.fn(),
    configureGitHubReadAccess: vi.fn(), clearGitHubReadAccess: vi.fn(),
    readFile: vi.fn(async () => new Uint8Array([1, 2, 3])), writeFile: vi.fn(),
    runCommand: vi.fn(async (_id, input) => {
      if (input.command.includes("status --porcelain")) return { exitCode: 0, stdout: "", stderr: "" };
      if (input.command.includes("branch --show-current")) return { exitCode: 0, stdout: `${HEAD_REF}\n`, stderr: "" };
      if (input.command.includes("rev-parse HEAD")) return { exitCode: 0, stdout: `${HEAD}\n`, stderr: "" };
      if (input.command.includes("diff --name-only")) return { exitCode: 0, stdout: "src/app.ts\n", stderr: "" };
      if (input.command.includes("git bundle create")) return { exitCode: 0, stdout: "3\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    }),
    publishGitBundle: vi.fn(async (input) => ({ publishedSha: input.headSha })),
  };
  const context: HarnessToolContext = {
    workspaceId: W, workstreamId: S, harnessRunId: R, toolCallId: "publish-call",
    executionPrincipal: { type: "user", userId: U }, signal: new AbortController().signal,
  };
  return { database, env, gateway, provider, context };
}

describe("Terminal repository publication", () => {
  it("bootstraps the selected repository with read-only secret placeholders and the fixed branch", async () => {
    const { database, env, provider, context } = fixture();
    const readGateway = {
      mintReadToken: vi.fn(async () => ({ accessToken: "read-token", expiresAt: "2026-08-13T13:00:00.000Z" })),
      verifyRepositoryIdentity: vi.fn(async () => undefined),
      resolveBaseRef: vi.fn(async () => BASE),
    };

    await expect(bootstrapTerminalRepository(
      env,
      context,
      { providerSandboxId: "sandbox", stableName: "sandbox", generation: 1, state: "running", authorityFingerprint: "a", networkRevision: 1 },
      provider,
      readGateway,
    )).resolves.toMatchObject({ repositoryFullName: "owner/repo", baseSha: BASE, headRef: HEAD_REF, outcome: "cloned" });
    expect(provider.configureGitHubReadAccess).toHaveBeenCalledWith("sandbox", {
      gitBasicCredential: btoa("x-access-token:read-token"),
      ghToken: "read-token",
    });
    expect(provider.runCommand).toHaveBeenCalledWith("sandbox", expect.objectContaining({
      command: expect.stringContaining("clone --no-checkout 'https://github.com/owner/repo.git'"),
    }));
    expect(database.prepare(
      "SELECT bootstrapped_sandbox_generation, read_token_expires_at FROM workstream_terminal_repositories WHERE workspace_id = ? AND workstream_id = ?",
    ).get(W, S)).toEqual({ bootstrapped_sandbox_generation: 1, read_token_expires_at: "2026-08-13T13:00:00.000Z" });
  });

  it("admits a two-hour single-use grant only from explicit current participant intent", async () => {
    const explicit = fixture();
    await expect(admitTerminalPublicationGrant(explicit.env, {
      workspaceId: W, workstreamId: S, harnessRunId: R, triggerMessageId: MESSAGE,
      executionPrincipal: { type: "user", userId: U },
    }, new Date("2026-08-13T12:00:00.000Z"))).resolves.toMatchObject({ admitted: true });
    expect(explicit.database.prepare(
      "SELECT expires_at, consumed_at FROM terminal_publication_grants WHERE workspace_id = ? AND harness_run_id = ?",
    ).get(W, R)).toEqual({ expires_at: "2026-08-13T14:00:00.000Z", consumed_at: null });

    const generic = fixture("Please make the requested code edits");
    await expect(admitTerminalPublicationGrant(generic.env, {
      workspaceId: W, workstreamId: S, harnessRunId: R, triggerMessageId: MESSAGE,
      executionPrincipal: { type: "user", userId: U },
    }, new Date("2026-08-13T12:00:00.000Z"))).resolves.toEqual({ admitted: false, reason: "intent_not_explicit" });

    for (const deniedText of [
      "Do not create or open a PR; only make local edits",
      "Can you explain how to open a pull request?",
      "Publish the changes without creating a PR",
      "The ticket says \"open a PR\" after the edit",
      "Here is an example instruction: publish and open a PR",
    ]) {
      const denied = fixture(deniedText);
      await expect(admitTerminalPublicationGrant(denied.env, {
        workspaceId: W, workstreamId: S, harnessRunId: R, triggerMessageId: MESSAGE,
        executionPrincipal: { type: "user", userId: U },
      }, new Date("2026-08-13T12:00:00.000Z"))).resolves.toEqual({ admitted: false, reason: "intent_not_explicit" });
    }
  });

  it("validates committed repository state, consumes the grant, and converges one PR", async () => {
    const { database, env, gateway, provider, context } = fixture();
    await admitTerminalPublicationGrant(env, {
      workspaceId: W, workstreamId: S, harnessRunId: R, triggerMessageId: MESSAGE,
      executionPrincipal: { type: "user", userId: U },
    }, new Date(Date.now() - 1_000));
    const publisher = createTerminalRepositoryPublisher(env, gateway);

    await expect(publisher.publishBranchAndPr(context, { title: "Ship it", body: "Automated change" }, {
      providerSandboxId: "sandbox", stableName: "sandbox", generation: 1, state: "running",
      authorityFingerprint: "authority", networkRevision: 1,
    }, provider)).resolves.toEqual({
      repository: "owner/repo", baseRef: "main", headRef: HEAD_REF, commitSha: HEAD,
      publishedSha: HEAD, outcome: "created",
      pullRequest: { number: 9, url: "https://github.com/owner/repo/pull/9", title: "Ship it", state: "open" },
    });
    expect(provider.publishGitBundle).toHaveBeenCalledWith(expect.objectContaining({
      bundle: new Uint8Array([1, 2, 3]), repositoryFullName: "owner/repo",
      baseSha: BASE, headSha: HEAD, headRef: HEAD_REF, expectedOldSha: null,
      githubBasicCredential: btoa("x-access-token:write-token"),
    }));
    expect(gateway.createPullRequest).toHaveBeenCalledOnce();
    expect(gateway.verifyRepositoryIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryId: 42, repositoryFullName: "owner/repo" }),
      "write-token",
      context.signal,
    );
    expect(database.prepare(
      "SELECT state, published_sha, pull_request_number FROM repository_publications WHERE workspace_id = ?",
    ).get(W)).toEqual({ state: "completed", published_sha: HEAD, pull_request_number: 9 });
    expect(database.prepare(
      "SELECT consumed_by_invocation_id FROM terminal_publication_grants WHERE workspace_id = ?",
    ).get(W)).toEqual({ consumed_by_invocation_id: I });
  });

  it("refuses a dirty tree with actionable guidance", async () => {
    const dirty = fixture();
    await admitTerminalPublicationGrant(dirty.env, {
      workspaceId: W, workstreamId: S, harnessRunId: R, triggerMessageId: MESSAGE,
      executionPrincipal: { type: "user", userId: U },
    }, new Date(Date.now() - 1_000));
    vi.mocked(dirty.provider.runCommand).mockResolvedValueOnce({ exitCode: 0, stdout: " M src/app.ts\n", stderr: "" });
    await expect(createTerminalRepositoryPublisher(dirty.env, dirty.gateway).publishBranchAndPr(
      dirty.context, { title: "Ship", body: "" },
      { providerSandboxId: "sandbox", stableName: "sandbox", generation: 1, state: "running", authorityFingerprint: "a", networkRevision: 1 },
      dirty.provider,
    )).rejects.toMatchObject({ code: "working_tree_dirty", message: expect.stringContaining("commit") });
  });

  it("refuses committed GitHub Actions workflow changes", async () => {
    const workflow = fixture();
    await admitTerminalPublicationGrant(workflow.env, {
      workspaceId: W, workstreamId: S, harnessRunId: R, triggerMessageId: MESSAGE,
      executionPrincipal: { type: "user", userId: U },
    }, new Date(Date.now() - 1_000));
    const runCommand = vi.mocked(workflow.provider.runCommand);
    const defaultImplementation = runCommand.getMockImplementation()!;
    runCommand.mockImplementation(async (sandboxId, input) => input.command.includes("diff --name-only")
      ? { exitCode: 0, stdout: ".github/workflows/release.yml\n", stderr: "" }
      : defaultImplementation(sandboxId, input));

    await expect(createTerminalRepositoryPublisher(workflow.env, workflow.gateway).publishBranchAndPr(
      workflow.context, { title: "Ship", body: "" },
      { providerSandboxId: "sandbox", stableName: "sandbox", generation: 1, state: "running", authorityFingerprint: "a", networkRevision: 1 },
      workflow.provider,
    )).rejects.toMatchObject({
      code: "publication_policy_denied",
      message: expect.stringContaining("GitHub Actions workflow"),
    });
    expect(workflow.provider.publishGitBundle).not.toHaveBeenCalled();
  });

  it("revalidates current work-stream participation immediately before minting a write token", async () => {
    const removed = fixture();
    await admitTerminalPublicationGrant(removed.env, {
      workspaceId: W, workstreamId: S, harnessRunId: R, triggerMessageId: MESSAGE,
      executionPrincipal: { type: "user", userId: U },
    }, new Date(Date.now() - 1_000));
    removed.database.prepare(
      "UPDATE workstream_participants SET removed_at = '2026-08-13' WHERE workstream_id = ? AND user_id = ?",
    ).run(S, U);

    await expect(createTerminalRepositoryPublisher(removed.env, removed.gateway).publishBranchAndPr(
      removed.context, { title: "Ship", body: "" },
      { providerSandboxId: "sandbox", stableName: "sandbox", generation: 1, state: "running", authorityFingerprint: "a", networkRevision: 1 },
      removed.provider,
    )).rejects.toMatchObject({ code: "publication_not_authorized", message: expect.stringContaining("no longer belongs") });
    expect(removed.gateway.mintWriteToken).not.toHaveBeenCalled();
  });

  it("rejects a replacement repository that reuses the selected owner/name", async () => {
    const { env } = fixture();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: 99,
      full_name: "owner/repo",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createGitHubRestReadGateway(env);

    await expect(gateway.verifyRepositoryIdentity({
      workspaceId: W,
      workstreamId: S,
      connectionId: CONNECTION,
      repositoryId: 42,
      repositoryFullName: "owner/repo",
      baseRef: "main",
      baseSha: BASE,
      headRef: HEAD_REF,
    }, "read-token", new AbortController().signal)).rejects.toMatchObject({
      code: "connection_revoked",
      message: expect.stringContaining("identity changed"),
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repositories/42",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer read-token" }) }),
    );
  });
});
