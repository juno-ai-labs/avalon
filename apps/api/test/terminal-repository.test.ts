import { asUserId } from "@rally/contracts";
import type { HarnessToolContext } from "@rally/agent-harness";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { createTerminalInstructionFiles } from "../src/services/terminal/instructions";
import { WorkstreamResidentContextStorage } from "../src/durable-objects/workstream-resident-context-storage";
import { createResidentContextPortFactory } from "../src/runtime/resident-context-port";
import { createTestSqlStorage } from "./helpers/sql-storage";

import type { TerminalSandboxProvider } from "../src/services/terminal/daytona-provider";
import {
  admitTerminalPublicationGrant,
  bootstrapTerminalRepository,
  createGitHubRestReadGateway,
  createTerminalRepositoryPublisher,
  type TerminalGitHubPublicationGateway,
} from "../src/services/terminal/repository";
import { createCloudflareTestBinding, createTestEnv } from "./helpers/cloudflare-test";
import {
  seedWorkstreamObjectRoot,
  seedWorkstreamRun,
  seedCanonicalConversationTurn,
  testWorkstreamObjectStore,
  workstreamObjectGet,
  workstreamObjectRun,
  testSubstreamAgentsBinding,
  seedToolReceipt,
  seedWorkstreamObjectParticipant,
} from "./helpers/durable-authority";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const W = "20000000-0000-4000-8000-000000000001";
const S = "20000000-0000-4000-8000-000000000002";
const R = "20000000-0000-4000-8000-000000000003";
const U = asUserId("20000000-0000-4000-8000-000000000004");
const I = "20000000-0000-4000-8000-000000000005";
const CONNECTION = "20000000-0000-4000-8000-000000000006";
const MESSAGE = "20000000-0000-4000-8000-000000000007";
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const SECOND_HEAD = "c".repeat(40);
const HEAD_REF = "avalon/workstream-20000000";

const openDatabases: ReturnType<typeof preRetirementProductSqliteDatabase>[] = [];
afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
  vi.unstubAllGlobals();
});

function fixture(message = "Please publish these changes and open a pull request") {
  const database = preRetirementProductSqliteDatabase();
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
    INSERT INTO connector_connections
      (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
       display_name, granted_scopes_json, model_plugin_id, status, created_at, updated_at)
    VALUES ('${CONNECTION}', '${W}', 'github', 'workspace', NULL, '123', 'GitHub',
            '["github.contents.read","github.pull_requests.read"]', 'plugin_github', 'healthy', '2026-08-13', '2026-08-13');
  `);
  // The publication tables, the transcript, and the run rows moved into the
  // work stream's object with migration 0090; the fixture writes them through
  // the same compat port the routed statements travel.
  const objectStore = testWorkstreamObjectStore();
  openDatabases.push(objectStore);
  seedWorkstreamObjectRoot(objectStore, { workstreamId: S, workspaceId: W });
  seedWorkstreamObjectParticipant(objectStore, {
    userId: U,
    participationReason: "creator",
    addedAt: Date.parse("2026-08-13T00:00:00.000Z"),
  });
  workstreamObjectRun(
    objectStore,
    `INSERT INTO terminal_repository
       (id, connection_id, repository_id, repository_full_name, base_ref,
        base_sha, head_ref, state, selected_by_user_id, created_at, updated_at)
     VALUES (1, ?, 42, 'owner/repo', 'main', ?, ?, 'selected', ?, ?, ?)`,
    CONNECTION,
    BASE,
    HEAD_REF,
    U,
    Date.parse("2026-08-13T00:00:00.000Z"),
    Date.parse("2026-08-13T00:00:00.000Z"),
  );
  seedCanonicalConversationTurn(objectStore, {
    turnId: MESSAGE,
    clientMessageId: MESSAGE,
    actor: "human",
    authorUserId: U,
    authorSnapshot: { displayName: "Terminal user", avatarUrl: null },
    text: message,
    transcriptSequence: 1,
    createdAt: "2026-08-13",
  });
  seedWorkstreamRun(objectStore, { id: R,
    executionPrincipalJson: JSON.stringify({ type: "user", userId: U }),
    triggerPartId: MESSAGE });
  seedToolReceipt(objectStore, {
    id: I, runId: R, toolCallId: 'publish-call',
    toolName: 'terminal_publish_branch_and_pr', mode: 'write',
  });
  const env = createTestEnv({
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    // Terminal repository and grant state is object-local, so these paths hold
    // the agent binding rather than only a database handle.
    SUBSTREAM_AGENTS: testSubstreamAgentsBinding(objectStore),
  });
  const gateway: TerminalGitHubPublicationGateway = {
    mintWriteToken: vi.fn(async () => ({
      accessToken: "write-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
    })),
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
    runUtilityCommand: vi.fn(),
    runCommand: vi.fn(async (_id, input) => {
      if (input.command.includes("status --porcelain")) return { exitCode: 0, stdout: "", stderr: "" };
      if (input.command.includes("branch --show-current")) return { exitCode: 0, stdout: `${HEAD_REF}\n`, stderr: "" };
      if (input.command.includes("rev-parse HEAD")) return { exitCode: 0, stdout: `${HEAD}\n`, stderr: "" };
      if (input.command.includes("diff --name-only")) return { exitCode: 0, stdout: "src/app.ts\n", stderr: "" };
      if (input.command.includes("core.hooksPath=/dev/null push")) return { exitCode: 0, stdout: "published\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    }),
  };
  const utilityImplementation = vi.mocked(provider.runCommand).getMockImplementation()!;
  provider.runUtilityCommand = vi.fn((id, input) => utilityImplementation(id, {
    ...input,
    taskName: "terminal-utility",
  }));
  const context: HarnessToolContext = {
    workspaceId: W, workstreamId: S, harnessRunId: R, toolCallId: "publish-call",
    // The publication's durable identity: the grant it consumes and its
    // `repository_publications` row both key to this.
    effectIntentId: I,
    executionPrincipal: { type: "user", userId: U }, signal: new AbortController().signal,
  };
  return { database, objectStore, env, gateway, provider, context };
}

function publicationPushes(provider: TerminalSandboxProvider) {
  return vi.mocked(provider.runUtilityCommand).mock.calls.filter(
    ([, input]) => input.operation === "repository.publish.push",
  );
}

function executePublicationScript(
  command: string,
  input: {
    remoteBefore: string;
    remoteAfter: string;
    failOperation?: "ls-remote" | "push";
  },
) {
  const directory = mkdtempSync(join(tmpdir(), "rally-terminal-publication-"));
  const statePath = join(directory, "ls-remote-count");
  const gitPath = join(directory, "git");
  writeFileSync(gitPath, `#!/usr/bin/env bash
set -euo pipefail
operation=""
for argument in "$@"; do
  case "$argument" in
    ls-remote|push) operation="$argument"; break ;;
  esac
done
case "$operation" in
  ls-remote)
    count=0
    if [ -f "$RALLY_GIT_STATE" ]; then count=$(cat "$RALLY_GIT_STATE"); fi
    printf '%s' "$((count + 1))" > "$RALLY_GIT_STATE"
    if [ "$RALLY_FAIL_OPERATION" = "ls-remote" ] && [ "$count" -eq 0 ]; then exit 128; fi
    if [ "$count" -eq 0 ]; then sha="$RALLY_REMOTE_BEFORE"; else sha="$RALLY_REMOTE_AFTER"; fi
    if [ -n "$sha" ]; then printf '%s\\trefs/heads/test\\n' "$sha"; fi
    ;;
  push)
    if [ "$RALLY_FAIL_OPERATION" = "push" ]; then exit 1; fi
    ;;
  *) exit 2 ;;
esac
`, { mode: 0o700 });
  try {
    const result = spawnSync("bash", ["-c", command], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ""}`,
        RALLY_FAIL_OPERATION: input.failOperation ?? "",
        RALLY_GIT_STATE: statePath,
        RALLY_REMOTE_AFTER: input.remoteAfter,
        RALLY_REMOTE_BEFORE: input.remoteBefore,
      },
    });
    return {
      exitCode: result.status ?? 1,
      stdout: result.stdout,
      stderr: "",
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("Terminal repository publication", () => {
  it("probes the root instruction file inside the bootstrap command and records it for delivery", async () => {
    const { objectStore, env, provider, context } = fixture();
    const readGateway = {
      mintRepositoryToken: vi.fn(async () => ({ accessToken: "write-token", expiresAt: "2026-08-13T13:00:00.000Z" })),
      verifyRepositoryIdentity: vi.fn(async () => undefined),
      resolveBaseRef: vi.fn(async () => BASE),
    };
    const ledger = new WorkstreamResidentContextStorage(createCloudflareTestBinding<DurableObjectStorage>({
      getAlarm: async () => null,
      setAlarm: async () => undefined,
      transactionSync: (body: () => unknown) => body(),
      sql: createTestSqlStorage(objectStore),
    }));
    const failures: string[] = [];
    const instructions = createTerminalInstructionFiles(
      createResidentContextPortFactory(createTestEnv({}), ledger)(W, S, "0"),
      (_error, stage) => { failures.push(stage); },
    );
    // The simulated sandbox answers the bootstrap with the probe's trailer, as
    // the real one would after the clone: the root file exists, at this content.
    const sha = "d".repeat(64);
    vi.mocked(provider.runUtilityCommand).mockImplementationOnce(async (_id, input) => ({
      exitCode: 0,
      // The trailer starts with the marker this invocation was told to print.
      stdout: `${/'(__RALLY_INSTRUCTION_PROBE_[0-9a-f]{32}__)'/u.exec(input.command)?.[1]}${JSON.stringify({ entries: [{ path: "AGENTS.md", sha256: sha, bytes: 11, content: "root rules\n", truncated: false, resident: false }], pending: true })}\n`,
      stderr: "",
    }));

    await expect(bootstrapTerminalRepository(
      env,
      context,
      { providerSandboxId: "sandbox", stableName: "sandbox", generation: 3, state: "running", authorityFingerprint: "a", networkRevision: 1, operationLeaseExpiresAt: Number.MAX_SAFE_INTEGER },
      provider,
      readGateway,
      undefined,
      instructions,
    )).resolves.toMatchObject({ outcome: "cloned" });
    const bootstrapCommand = vi.mocked(provider.runUtilityCommand).mock.calls.at(-1)?.[1].command ?? "";
    // After the checkout, isolated from `set -e`, reporting only.
    expect(bootstrapCommand.indexOf(".git/info/exclude")).toBeLessThan(bootstrapCommand.indexOf("( set +e; python3 -c '"));
    expect(bootstrapCommand).toMatch(/'\/workspace' 'report' '0' '\[\]' '__RALLY_INSTRUCTION_PROBE_[0-9a-f]{32}__' 'AGENTS\.md' \) \|\| true$/u);
    expect(ledger.pendingDeliveries().map((delivery) => [delivery.block.blockId, delivery.block.sourceGeneration, delivery.block.content]))
      .toEqual([["AGENTS.md", 3, "root rules\n"]]);
    expect(failures).toEqual([]);
  });

  it("bootstraps full-access repositories with scoped secret placeholders and a prepared branch", async () => {
    const { objectStore, env, provider, context } = fixture();
    const readGateway = {
      mintRepositoryToken: vi.fn(async () => ({ accessToken: "write-token", expiresAt: "2026-08-13T13:00:00.000Z" })),
      verifyRepositoryIdentity: vi.fn(async () => undefined),
      resolveBaseRef: vi.fn(async () => BASE),
    };

    await expect(bootstrapTerminalRepository(
      env,
      context,
      { providerSandboxId: "sandbox", stableName: "sandbox", generation: 1, state: "running", authorityFingerprint: "a", networkRevision: 1, operationLeaseExpiresAt: Number.MAX_SAFE_INTEGER },
      provider,
      readGateway,
    )).resolves.toMatchObject({ repositoryFullName: "owner/repo", baseSha: BASE, headRef: HEAD_REF, outcome: "cloned" });
    expect(provider.configureGitHubReadAccess).toHaveBeenCalledWith("sandbox", {
      gitBasicCredential: btoa("x-access-token:write-token"),
      ghToken: "write-token",
    });
    expect(readGateway.mintRepositoryToken).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryFullName: "owner/repo" }),
      "full_access",
      context.signal,
    );
    expect(provider.runUtilityCommand).toHaveBeenCalledWith("sandbox", expect.objectContaining({
      command: expect.stringMatching(/rm -rf -- \/workspace\/repository\.tmp\n.*clone --no-checkout 'https:\/\/github\.com\/owner\/repo\.git'/su),
    }));
    expect(provider.runUtilityCommand).toHaveBeenCalledWith("sandbox", expect.objectContaining({
      command: expect.stringContaining("grep -qxF '.rally/' .git/info/exclude || printf '.rally/\\n' >> .git/info/exclude"),
    }));
    expect(provider.runUtilityCommand).toHaveBeenCalledWith("sandbox", expect.objectContaining({
      command: expect.not.stringContaining("git push --set-upstream"),
    }));
    expect(provider.runUtilityCommand).toHaveBeenCalledWith("sandbox", expect.objectContaining({
      command: expect.stringContaining(`export AVALON_GIT_BRANCH=${HEAD_REF}`),
    }));
    expect(provider.runUtilityCommand).toHaveBeenCalledWith("sandbox", expect.objectContaining({
      command: expect.stringContaining("export AVALON_GIT_BASE_BRANCH=main"),
    }));
    expect(provider.runUtilityCommand).toHaveBeenCalledWith("sandbox", expect.objectContaining({
      command: expect.stringContaining('export GIT_SSL_CAINFO="$CURL_CA_BUNDLE"'),
    }));
    expect(provider.runUtilityCommand).toHaveBeenCalledWith("sandbox", expect.objectContaining({
      command: expect.stringContaining("printf 'export GIT_SSL_CAINFO=%q\\n' \"$GIT_SSL_CAINFO\" >> '/workspace/.rally/session.env'"),
    }));
    const bootstrapCommand = vi.mocked(provider.runUtilityCommand).mock.calls.at(-1)?.[1].command ?? "";
    expect(bootstrapCommand).toContain("git config user.name 'Rally Agent'");
    expect(bootstrapCommand).toContain("git config user.email 'rally-agent@users.noreply.github.com'");
    expect(bootstrapCommand.indexOf('export GIT_SSL_CAINFO="$CURL_CA_BUNDLE"'))
      .toBeLessThan(bootstrapCommand.indexOf("clone --no-checkout"));
    expect(workstreamObjectGet(
      objectStore,
      "SELECT bootstrapped_sandbox_generation, read_token_expires_at FROM terminal_repository WHERE id = 1",
    )).toEqual({ bootstrapped_sandbox_generation: 1, read_token_expires_at: Date.parse("2026-08-13T13:00:00.000Z") });
  });

  it("fails closed with a revoked-access error when the selected connection is disabled", async () => {
    const { database, env, provider, context } = fixture();
    database.prepare("UPDATE connector_connections SET status = 'disabled' WHERE id = ?")
      .run(CONNECTION);
    const gateway = {
      mintRepositoryToken: vi.fn(async () => ({ accessToken: "token", expiresAt: "2099-01-01T00:00:00.000Z" })),
      verifyRepositoryIdentity: vi.fn(async () => undefined),
      resolveBaseRef: vi.fn(async () => BASE),
    };

    await expect(bootstrapTerminalRepository(
      env,
      context,
      { providerSandboxId: "sandbox", stableName: "sandbox", generation: 1, state: "running", authorityFingerprint: "a", networkRevision: 1, operationLeaseExpiresAt: Number.MAX_SAFE_INTEGER },
      provider,
      gateway,
    )).rejects.toMatchObject({ code: "repository_access_revoked" });
    expect(gateway.mintRepositoryToken).not.toHaveBeenCalled();
    expect(provider.runUtilityCommand).not.toHaveBeenCalled();
  });

  it("keeps an already-bootstrapped workspace repairable when branch restoration cannot switch", async () => {
    const { objectStore, env, provider, context } = fixture();
    workstreamObjectRun(
      objectStore,
      `UPDATE terminal_repository
          SET bootstrapped_sandbox_generation = 1, read_token_expires_at = ?
        WHERE id = 1`,
      Date.parse("2099-01-01T00:00:00.000Z"),
    );
    const gateway = {
      mintRepositoryToken: vi.fn(async () => ({ accessToken: "token", expiresAt: "2099-01-01T00:00:00.000Z" })),
      verifyRepositoryIdentity: vi.fn(async () => undefined),
      resolveBaseRef: vi.fn(async () => BASE),
    };

    await expect(bootstrapTerminalRepository(
      env,
      context,
      { providerSandboxId: "sandbox", stableName: "sandbox", generation: 1, state: "running", authorityFingerprint: "a", networkRevision: 1, operationLeaseExpiresAt: Number.MAX_SAFE_INTEGER },
      provider,
      gateway,
    )).resolves.toMatchObject({ outcome: "refreshed" });
    const command = vi.mocked(provider.runUtilityCommand).mock.calls.at(-1)?.[1].command ?? "";
    expect(command).toContain(`if ! git checkout '${HEAD_REF}'; then`);
    expect(command).not.toContain('test "$(git branch --show-current)"');
    expect(gateway.mintRepositoryToken).not.toHaveBeenCalled();
  });

  it("keeps read-only repositories locally editable without creating a remote branch", async () => {
    const { database, env, provider, context } = fixture();
    database.prepare("UPDATE connector_connections SET config_json = ? WHERE id = ?").run(JSON.stringify({
      githubRepositoryAccess: {
        version: 1,
        revision: 1,
        mode: "all_repositories",
        defaultAccess: "read_only",
        repositories: [],
      },
    }), CONNECTION);
    const gateway = {
      mintRepositoryToken: vi.fn(async () => ({ accessToken: "read-token", expiresAt: "2099-01-01T00:00:00.000Z" })),
      verifyRepositoryIdentity: vi.fn(async () => undefined),
      resolveBaseRef: vi.fn(async () => BASE),
    };

    await bootstrapTerminalRepository(
      env,
      context,
      { providerSandboxId: "sandbox", stableName: "sandbox", generation: 1, state: "running", authorityFingerprint: "a", networkRevision: 1, operationLeaseExpiresAt: Number.MAX_SAFE_INTEGER },
      provider,
      gateway,
    );

    expect(gateway.mintRepositoryToken).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryFullName: "owner/repo" }),
      "read_only",
      context.signal,
    );
    const command = vi.mocked(provider.runUtilityCommand).mock.calls.at(-1)?.[1].command ?? "";
    expect(command).toContain(`git checkout -b '${HEAD_REF}' --track 'origin/${HEAD_REF}'`);
    expect(command).not.toContain("git push --set-upstream");
    expect(command).toContain("export AVALON_REMOTE_ACCESS=read_only");
  });

  it("records current-participant publication provenance without parsing the request prose", async () => {
    const explicit = fixture();
    await expect(admitTerminalPublicationGrant(explicit.env, {
      workspaceId: W, workstreamId: S, harnessRunId: R, triggerMessageId: MESSAGE,
      executionPrincipal: { type: "user", userId: U },
    }, new Date("2026-08-13T12:00:00.000Z"))).resolves.toMatchObject({ admitted: true });
    expect(workstreamObjectGet(
      explicit.objectStore,
      "SELECT expires_at, consumed_at FROM terminal_publication_grants WHERE run_id = ?",
      R,
    )).toEqual({ expires_at: Date.parse("2026-08-13T14:00:00.000Z"), consumed_at: null });

    const generic = fixture("Please make the requested code edits");
    await expect(admitTerminalPublicationGrant(generic.env, {
      workspaceId: W, workstreamId: S, harnessRunId: R, triggerMessageId: MESSAGE,
      executionPrincipal: { type: "user", userId: U },
    }, new Date("2026-08-13T12:00:00.000Z"))).resolves.toMatchObject({ admitted: true });
  });

  it("refreshes a stale mounted credential, validates the commit, and converges one PR", async () => {
    const { objectStore, env, gateway, provider, context } = fixture();
    workstreamObjectRun(
      objectStore,
      `UPDATE terminal_repository
          SET bootstrapped_sandbox_generation = 1, read_token_expires_at = ?
        WHERE id = 1`,
      Date.parse("2026-08-13T00:00:00.000Z"),
    );
    await admitTerminalPublicationGrant(env, {
      workspaceId: W, workstreamId: S, harnessRunId: R, triggerMessageId: MESSAGE,
      executionPrincipal: { type: "user", userId: U },
    }, new Date(Date.now() - 1_000));
    const publisher = createTerminalRepositoryPublisher(env, gateway);

    await expect(publisher.publishBranchAndPr(context, { title: "Ship it", body: "Automated change" }, {
      providerSandboxId: "sandbox", stableName: "sandbox", generation: 1, state: "running",
      authorityFingerprint: "authority", networkRevision: 1, operationLeaseExpiresAt: Number.MAX_SAFE_INTEGER,
    }, provider)).resolves.toEqual({
      repository: "owner/repo", baseRef: "main", headRef: HEAD_REF, commitSha: HEAD,
      publishedSha: HEAD, outcome: "created",
      pullRequest: { number: 9, url: "https://github.com/owner/repo/pull/9", title: "Ship it", state: "open" },
    });
    expect(publicationPushes(provider)).toEqual([["sandbox", expect.objectContaining({
      operation: "repository.publish.push",
      cwd: "/workspace",
      timeoutMs: 180_000,
      command: expect.stringMatching(new RegExp(
        `git -c 'url\\.https://github\\.com/owner/repo\\.git\\.insteadOf=rally-publish-[^']+://repository' -c 'url\\.https://github\\.com/owner/repo\\.git\\.pushInsteadOf=rally-publish-[^']+://repository' -c core\\.hooksPath=/dev/null -c push\\.followTags=false push 'rally-publish-[^']+://repository' '${HEAD}:refs/heads/${HEAD_REF}'`,
        "u",
      )),
    })]]);
    expect(provider.readFile).not.toHaveBeenCalled();
    expect(provider.configureGitHubReadAccess).toHaveBeenCalledWith("sandbox", {
      gitBasicCredential: btoa("x-access-token:write-token"),
      ghToken: "write-token",
    });
    const pushCallIndex = vi.mocked(provider.runUtilityCommand).mock.calls.findIndex(
      ([, operation]) => operation.operation === "repository.publish.push",
    );
    expect(vi.mocked(provider.configureGitHubReadAccess).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(provider.runUtilityCommand).mock.invocationCallOrder[pushCallIndex]!);
    expect(gateway.createPullRequest).toHaveBeenCalledOnce();
    expect(gateway.verifyRepositoryIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryId: 42, repositoryFullName: "owner/repo" }),
      "write-token",
      context.signal,
    );
    expect(workstreamObjectGet(
      objectStore,
      "SELECT state, published_sha, pull_request_number FROM repository_publications",
    )).toEqual({ state: "completed", published_sha: HEAD, pull_request_number: 9 });
    expect(workstreamObjectGet(
      objectStore,
      "SELECT consumed_by_effect_intent_id FROM terminal_publication_grants",
    )).toEqual({ consumed_by_effect_intent_id: I });
    expect(workstreamObjectGet(
      objectStore,
      "SELECT bootstrapped_sandbox_generation, read_token_expires_at FROM terminal_repository WHERE id = 1",
    )).toEqual({
      bootstrapped_sandbox_generation: 1,
      read_token_expires_at: Date.parse("2099-01-01T00:00:00.000Z"),
    });

    await expect(publisher.publishBranchAndPr(context, { title: "Ship it", body: "Automated change" }, {
      providerSandboxId: "sandbox", stableName: "sandbox", generation: 1, state: "running",
      authorityFingerprint: "authority", networkRevision: 1, operationLeaseExpiresAt: Number.MAX_SAFE_INTEGER,
    }, provider)).resolves.toMatchObject({ outcome: "unchanged", publishedSha: HEAD });
    expect(publicationPushes(provider)).toHaveLength(1);
    expect(workstreamObjectGet(
      objectStore,
      "SELECT COUNT(*) AS count FROM repository_publications WHERE effect_intent_id = ?",
      I,
    )).toEqual({ count: 1 });
  });

  it("refuses to publish when the harness supplied no receipt identity", async () => {
    const { env, gateway, provider, context } = fixture();
    await admitTerminalPublicationGrant(env, {
      workspaceId: W, workstreamId: S, harnessRunId: R, triggerMessageId: MESSAGE,
      executionPrincipal: { type: "user", userId: U },
    }, new Date(Date.now() - 1_000));
    const publisher = createTerminalRepositoryPublisher(env, gateway);
    const unreceipted: HarnessToolContext = { ...context };
    delete unreceipted.effectIntentId;

    await expect(publisher.publishBranchAndPr(unreceipted, { title: "Ship it", body: "Automated change" }, {
      providerSandboxId: "sandbox", stableName: "sandbox", generation: 1, state: "running",
      authorityFingerprint: "authority", networkRevision: 1, operationLeaseExpiresAt: Number.MAX_SAFE_INTEGER,
    }, provider)).rejects.toMatchObject({ code: "tool_receipt_missing" });
    // The receipt is what makes a publication replayable. Without it nothing
    // may reach GitHub, or a retry opens a second pull request.
    expect(publicationPushes(provider)).toHaveLength(0);
    expect(gateway.createPullRequest).not.toHaveBeenCalled();
  });

  it.each([
    { stdout: "RALLY_PUBLISH_FAILED_STAGE=remote_push\n", stage: "remote_push" },
    { stdout: "", stage: "unknown_stage" },
  ])("reports direct publication failure stage $stage", async ({ stdout, stage }) => {
    const failed = fixture();
    await admitTerminalPublicationGrant(failed.env, {
      workspaceId: W, workstreamId: S, harnessRunId: R, triggerMessageId: MESSAGE,
      executionPrincipal: { type: "user", userId: U },
    }, new Date(Date.now() - 1_000));
    const runUtility = vi.mocked(failed.provider.runUtilityCommand);
    const defaultImplementation = runUtility.getMockImplementation()!;
    runUtility.mockImplementation(async (sandboxId, input) => input.operation === "repository.publish.push"
      ? { exitCode: 1, stdout, stderr: "" }
      : defaultImplementation(sandboxId, input));

    await expect(createTerminalRepositoryPublisher(failed.env, failed.gateway).publishBranchAndPr(
      failed.context,
      { title: "Ship", body: "" },
      { providerSandboxId: "sandbox", stableName: "sandbox", generation: 1, state: "running", authorityFingerprint: "a", networkRevision: 1, operationLeaseExpiresAt: Number.MAX_SAFE_INTEGER },
      failed.provider,
    )).rejects.toThrow(`Trusted Git publication failed at ${stage} with exit code 1`);
    expect(publicationPushes(failed.provider)).toEqual([["sandbox", expect.objectContaining({
      command: expect.stringContaining("-c core.hooksPath=/dev/null -c push.followTags=false push"),
    })]]);
    expect(failed.gateway.createPullRequest).not.toHaveBeenCalled();
    expect(workstreamObjectGet(
      failed.objectStore,
      "SELECT state FROM repository_publications WHERE effect_intent_id = ?",
      I,
    )).toEqual({ state: "ambiguous" });
  });

  it.each([
    { name: "first push", expectedOld: null, remoteBefore: "", remoteAfter: HEAD, expectedStage: null },
    { name: "existing branch", expectedOld: BASE, remoteBefore: BASE, remoteAfter: HEAD, expectedStage: null },
    { name: "remote moved", expectedOld: null, remoteBefore: BASE, remoteAfter: HEAD, expectedStage: "remote_verify" },
    { name: "remote authentication failed", expectedOld: null, remoteBefore: "", remoteAfter: HEAD, failOperation: "ls-remote" as const, expectedStage: "remote_verify" },
    { name: "push rejected", expectedOld: null, remoteBefore: "", remoteAfter: HEAD, failOperation: "push" as const, expectedStage: "remote_push" },
    { name: "post-push ref mismatch", expectedOld: null, remoteBefore: "", remoteAfter: BASE, expectedStage: "post_push_verify" },
  ])("executes the generated publication script for $name", async ({
    expectedOld,
    remoteBefore,
    remoteAfter,
    failOperation,
    expectedStage,
  }) => {
    const scenario = fixture();
    await admitTerminalPublicationGrant(scenario.env, {
      workspaceId: W, workstreamId: S, harnessRunId: R, triggerMessageId: MESSAGE,
      executionPrincipal: { type: "user", userId: U },
    }, new Date(Date.now() - 1_000));
    vi.mocked(scenario.gateway.getRef).mockResolvedValue(expectedOld);
    const runUtility = vi.mocked(scenario.provider.runUtilityCommand);
    const defaultImplementation = runUtility.getMockImplementation()!;
    runUtility.mockImplementation(async (sandboxId, operation) => operation.operation === "repository.publish.push"
      ? executePublicationScript(operation.command, { remoteBefore, remoteAfter, ...(failOperation ? { failOperation } : {}) })
      : defaultImplementation(sandboxId, operation));

    const publication = createTerminalRepositoryPublisher(scenario.env, scenario.gateway).publishBranchAndPr(
      scenario.context,
      { title: "Ship", body: "" },
      { providerSandboxId: "sandbox", stableName: "sandbox", generation: 1, state: "running", authorityFingerprint: "a", networkRevision: 1, operationLeaseExpiresAt: Number.MAX_SAFE_INTEGER },
      scenario.provider,
    );
    if (expectedStage) {
      await expect(publication).rejects.toMatchObject({
        code: "provider_publication_failed",
        details: { stage: expectedStage },
      });
      expect(workstreamObjectGet(
        scenario.objectStore,
        "SELECT state, failure_code FROM repository_publications WHERE effect_intent_id = ?",
        I,
      )).toEqual({ state: "ambiguous", failure_code: "provider_publication_failed" });
    } else {
      await expect(publication).resolves.toMatchObject({ outcome: "created", publishedSha: HEAD });
    }
    expect(publicationPushes(scenario.provider)).toHaveLength(1);
    // The budget covers forking a real bash up to four times on a contended machine, not the assertion.
  }, 30_000);

  it("publishes later commits from the same authorized run to the existing open PR", async () => {
    const { objectStore, env, gateway, provider, context } = fixture();
    await admitTerminalPublicationGrant(env, {
      workspaceId: W, workstreamId: S, harnessRunId: R, triggerMessageId: MESSAGE,
      executionPrincipal: { type: "user", userId: U },
    }, new Date(Date.now() - 1_000));
    const publisher = createTerminalRepositoryPublisher(env, gateway);
    const sandbox = {
      providerSandboxId: "sandbox", stableName: "sandbox", generation: 1, state: "running" as const,
      authorityFingerprint: "authority", networkRevision: 1, operationLeaseExpiresAt: Number.MAX_SAFE_INTEGER,
    };

    await publisher.publishBranchAndPr(context, { title: "Ship it", body: "First commit" }, sandbox, provider);

    const secondInvocationId = "20000000-0000-4000-8000-000000000008";
    seedToolReceipt(objectStore, {
      id: secondInvocationId, runId: R, toolCallId: 'publish-call-2',
      toolName: 'terminal_publish_branch_and_pr', mode: 'write',
      requestHash: 'hash-2', position: 1,
    });
    const runCommand = vi.mocked(provider.runUtilityCommand);
    const firstImplementation = runCommand.getMockImplementation()!;
    runCommand.mockImplementation(async (sandboxId, input) => input.command.includes("rev-parse HEAD")
      ? { exitCode: 0, stdout: `${SECOND_HEAD}\n`, stderr: "" }
      : firstImplementation(sandboxId, input));
    vi.mocked(gateway.getRef).mockResolvedValue(HEAD);
    vi.mocked(gateway.findPullRequest).mockResolvedValue({
      number: 9,
      url: "https://github.com/owner/repo/pull/9",
      state: "open",
      headSha: SECOND_HEAD,
      title: "Ship it",
    });
    vi.mocked(gateway.updatePullRequest).mockResolvedValue({
      number: 9,
      url: "https://github.com/owner/repo/pull/9",
      state: "open",
      headSha: SECOND_HEAD,
      title: "Ship it again",
    });

    await expect(publisher.publishBranchAndPr(
      { ...context, toolCallId: "publish-call-2", effectIntentId: secondInvocationId },
      { title: "Ship it again", body: "Second commit" },
      sandbox,
      provider,
    )).resolves.toMatchObject({
      outcome: "updated",
      publishedSha: SECOND_HEAD,
      pullRequest: { number: 9, title: "Ship it again" },
    });
    expect(publicationPushes(provider)).toHaveLength(2);
    expect(publicationPushes(provider)[1]?.[1]).toEqual(expect.objectContaining({
      command: expect.stringContaining(`test "$remote_sha" = '${HEAD}'`),
    }));
    expect(gateway.createPullRequest).toHaveBeenCalledOnce();
    expect(gateway.updatePullRequest).toHaveBeenCalledOnce();
    expect(gateway.mintWriteToken).toHaveBeenCalledTimes(2);
    expect(workstreamObjectGet(
      objectStore,
      "SELECT COUNT(*) AS count FROM repository_publications WHERE grant_id = (SELECT grant_id FROM terminal_publication_grants)",
    )).toEqual({ count: 2 });
  });

  it("refuses a dirty tree with actionable guidance", async () => {
    const dirty = fixture();
    await admitTerminalPublicationGrant(dirty.env, {
      workspaceId: W, workstreamId: S, harnessRunId: R, triggerMessageId: MESSAGE,
      executionPrincipal: { type: "user", userId: U },
    }, new Date(Date.now() - 1_000));
    vi.mocked(dirty.provider.runUtilityCommand).mockResolvedValueOnce({ exitCode: 0, stdout: " M src/app.ts\n", stderr: "" });
    await expect(createTerminalRepositoryPublisher(dirty.env, dirty.gateway).publishBranchAndPr(
      dirty.context, { title: "Ship", body: "" },
      { providerSandboxId: "sandbox", stableName: "sandbox", generation: 1, state: "running", authorityFingerprint: "a", networkRevision: 1, operationLeaseExpiresAt: Number.MAX_SAFE_INTEGER },
      dirty.provider,
    )).rejects.toMatchObject({ code: "working_tree_dirty", message: expect.stringContaining("commit") });
  });

  it("allows local repository work but blocks remote publication under read-only access", async () => {
    const readOnly = fixture();
    readOnly.database.prepare(
      `UPDATE connector_connections SET config_json = ? WHERE id = ?`,
    ).run(JSON.stringify({
      githubRepositoryAccess: {
        version: 1,
        revision: 2,
        mode: "all_repositories",
        defaultAccess: "read_only",
        repositories: [],
      },
    }), CONNECTION);
    await admitTerminalPublicationGrant(readOnly.env, {
      workspaceId: W, workstreamId: S, harnessRunId: R, triggerMessageId: MESSAGE,
      executionPrincipal: { type: "user", userId: U },
    }, new Date(Date.now() - 1_000));

    await expect(createTerminalRepositoryPublisher(readOnly.env, readOnly.gateway).publishBranchAndPr(
      readOnly.context, { title: "Ship", body: "" },
      { providerSandboxId: "sandbox", stableName: "sandbox", generation: 1, state: "running", authorityFingerprint: "a", networkRevision: 1, operationLeaseExpiresAt: Number.MAX_SAFE_INTEGER },
      readOnly.provider,
    )).rejects.toMatchObject({
      code: "repository_remote_read_only",
      message: expect.stringContaining("Local file edits and local commits are allowed"),
    });
    expect(readOnly.gateway.mintWriteToken).not.toHaveBeenCalled();
  });

  it("refuses committed GitHub Actions workflow changes", async () => {
    const workflow = fixture();
    await admitTerminalPublicationGrant(workflow.env, {
      workspaceId: W, workstreamId: S, harnessRunId: R, triggerMessageId: MESSAGE,
      executionPrincipal: { type: "user", userId: U },
    }, new Date(Date.now() - 1_000));
    const runCommand = vi.mocked(workflow.provider.runUtilityCommand);
    const defaultImplementation = runCommand.getMockImplementation()!;
    runCommand.mockImplementation(async (sandboxId, input) => input.command.includes("diff --name-only")
      ? { exitCode: 0, stdout: ".github/workflows/release.yml\n", stderr: "" }
      : defaultImplementation(sandboxId, input));

    await expect(createTerminalRepositoryPublisher(workflow.env, workflow.gateway).publishBranchAndPr(
      workflow.context, { title: "Ship", body: "" },
      { providerSandboxId: "sandbox", stableName: "sandbox", generation: 1, state: "running", authorityFingerprint: "a", networkRevision: 1, operationLeaseExpiresAt: Number.MAX_SAFE_INTEGER },
      workflow.provider,
    )).rejects.toMatchObject({
      code: "publication_policy_denied",
      message: expect.stringContaining("GitHub Actions workflow"),
    });
    expect(publicationPushes(workflow.provider)).toHaveLength(0);
  });

  it("revalidates current work-stream participation immediately before minting a write token", async () => {
    const removed = fixture();
    await admitTerminalPublicationGrant(removed.env, {
      workspaceId: W, workstreamId: S, harnessRunId: R, triggerMessageId: MESSAGE,
      executionPrincipal: { type: "user", userId: U },
    }, new Date(Date.now() - 1_000));
    seedWorkstreamObjectParticipant(removed.objectStore, {
      userId: U,
      participationReason: "creator",
      removedAt: Date.parse("2026-08-13T00:00:00.000Z"),
    });

    await expect(createTerminalRepositoryPublisher(removed.env, removed.gateway).publishBranchAndPr(
      removed.context, { title: "Ship", body: "" },
      { providerSandboxId: "sandbox", stableName: "sandbox", generation: 1, state: "running", authorityFingerprint: "a", networkRevision: 1, operationLeaseExpiresAt: Number.MAX_SAFE_INTEGER },
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
      remoteAccess: "full_access",
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
