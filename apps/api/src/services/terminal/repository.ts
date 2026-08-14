import type { HarnessToolContext } from "@avalon/agent-harness";
import {
  createGitHubAppJwt,
  githubRepositoryAuthorization,
  type GitHubRepositoryAccessLevel,
} from "@avalon/connectors";
import type { ExecutionPrincipal } from "@avalon/contracts";
import { newId, nowIso } from "@avalon/db";

import type { Env } from "../../env";
import { githubConnectorConfig } from "../../lib/connector-registry";
import { executionPrincipalKey } from "../workstream-resource-visibility";
import type { TerminalSandboxProvider } from "./daytona-provider";
import type { AcquiredTerminalSandbox } from "./coordinator";
import type { TerminalRepositoryPublisher } from "./runtime";
import { TerminalToolError, type TerminalPublishedBranchAndPrOutput } from "./tools";

const MAX_BUNDLE_BYTES = 50 * 1_048_576;
const MAX_CHANGED_PATHS = 500;

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

export interface TerminalRepositorySelection {
  workspaceId: string;
  workstreamId: string;
  connectionId: string;
  repositoryId: number;
  repositoryFullName: string;
  baseRef: string;
  baseSha: string;
  headRef: string;
  remoteAccess: GitHubRepositoryAccessLevel;
  bootstrappedSandboxGeneration?: number | null;
  readTokenExpiresAt?: string | null;
}

export interface TerminalPullRequest {
  number: number;
  url: string;
  state: "open" | "closed" | "merged";
  headSha: string;
  title: string;
}

export interface TerminalGitHubPublicationGateway {
  mintWriteToken(selection: TerminalRepositorySelection, signal: AbortSignal): Promise<{ accessToken: string }>;
  revokeWriteToken(accessToken: string): Promise<void>;
  verifyRepositoryIdentity(selection: TerminalRepositorySelection, accessToken: string, signal: AbortSignal): Promise<void>;
  getRef(selection: TerminalRepositorySelection, ref: string, accessToken: string, signal: AbortSignal): Promise<string | null>;
  findPullRequest(selection: TerminalRepositorySelection, accessToken: string, signal: AbortSignal): Promise<TerminalPullRequest | null>;
  createPullRequest(
    selection: TerminalRepositorySelection,
    accessToken: string,
    input: { title: string; body: string },
    signal: AbortSignal,
  ): Promise<TerminalPullRequest>;
  updatePullRequest(
    selection: TerminalRepositorySelection,
    accessToken: string,
    pullRequestNumber: number,
    input: { title: string; body: string },
    signal: AbortSignal,
  ): Promise<TerminalPullRequest>;
}

export interface TerminalGitHubReadGateway {
  mintRepositoryToken(
    selection: TerminalRepositorySelection,
    access: GitHubRepositoryAccessLevel,
    signal: AbortSignal,
  ): Promise<{
    accessToken: string;
    expiresAt: string;
  }>;
  verifyRepositoryIdentity(selection: TerminalRepositorySelection, accessToken: string, signal: AbortSignal): Promise<void>;
  resolveBaseRef(
    selection: TerminalRepositorySelection,
    accessToken: string,
    signal: AbortSignal,
  ): Promise<string>;
}

interface SelectionRow {
  workspace_id: string;
  workstream_id: string;
  connection_id: string;
  repository_id: number;
  repository_full_name: string;
  base_ref: string;
  base_sha: string;
  head_ref: string;
  remote_access: GitHubRepositoryAccessLevel;
  bootstrapped_sandbox_generation: number | null;
  read_token_expires_at: string | null;
}

interface GrantRow {
  id: string;
  principal_key: string;
  repository_full_name: string;
  base_ref: string;
  head_ref: string;
}

interface InvocationRow { id: string }

interface CompletedPublicationRow {
  published_sha: string;
  pull_request_number: number;
  pull_request_url: string;
  head_ref: string;
  repository_full_name: string;
  base_ref: string;
  title: string;
}

function selectionFromRow(row: SelectionRow): TerminalRepositorySelection {
  return {
    workspaceId: row.workspace_id,
    workstreamId: row.workstream_id,
    connectionId: row.connection_id,
    repositoryId: row.repository_id,
    repositoryFullName: row.repository_full_name,
    baseRef: row.base_ref,
    baseSha: row.base_sha,
    headRef: row.head_ref,
    remoteAccess: row.remote_access,
    bootstrappedSandboxGeneration: row.bootstrapped_sandbox_generation,
    readTokenExpiresAt: row.read_token_expires_at,
  };
}

async function loadSelection(database: D1Database, workspaceId: string, workstreamId: string): Promise<TerminalRepositorySelection | null> {
  const row = await database.prepare(
    `SELECT repository.workspace_id, repository.workstream_id, repository.connection_id,
            repository.repository_id, repository.repository_full_name, repository.base_ref,
            repository.base_sha, repository.head_ref, repository.remote_access,
            repository.bootstrapped_sandbox_generation, repository.read_token_expires_at
       FROM workstream_terminal_repositories repository
      WHERE repository.workspace_id = ? AND repository.workstream_id = ?
        AND repository.state = 'selected'`,
  ).bind(workspaceId, workstreamId).first<SelectionRow>();
  return row ? selectionFromRow(row) : null;
}

async function assertRepositoryRemoteAccess(
  database: D1Database,
  selection: TerminalRepositorySelection,
  required: "read_only" | "full_access",
): Promise<GitHubRepositoryAccessLevel> {
  const row = await database.prepare(
    `SELECT COALESCE(config_json, '{}') AS config_json
       FROM connector_connections
      WHERE id = ? AND workspace_id = ? AND connector_type = 'github' AND status <> 'disabled'`,
  ).bind(selection.connectionId, selection.workspaceId).first<{ config_json: string }>();
  if (!row) {
    throw new TerminalToolError(
      "repository_access_revoked",
      `${selection.repositoryFullName} is no longer authorized by an active GitHub connection. Choose another authorized repository with terminal_checkout_repository or reconnect GitHub.`,
      { reason: "The selected GitHub connection was disabled or removed; choose another authorized repository." },
    );
  }
  let config: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.config_json) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) config = parsed as Record<string, unknown>;
  } catch {
    // Invalid connector policy fails closed through the missing authorization.
  }
  const authorization = githubRepositoryAuthorization(
    config,
    selection.repositoryFullName,
    selection.repositoryId,
  );
  if (!authorization) {
    throw new TerminalToolError(
      "repository_access_revoked",
      `${selection.repositoryFullName} is no longer authorized by GitHub connector settings. Choose another authorized repository with terminal_checkout_repository or ask a connector administrator to restore access.`,
      { reason: "Repository connector policy changed; choose an authorized repository before retrying." },
    );
  }
  const effectiveAccess = selection.remoteAccess === "read_only"
    ? "read_only"
    : authorization.access;
  if (required === "full_access" && effectiveAccess !== "full_access") {
    throw new TerminalToolError(
      "repository_remote_read_only",
      `${selection.repositoryFullName} has read-only remote access. Local file edits and local commits are allowed, but push and pull-request publication are blocked. Ask a connector administrator for full access before retrying publication.`,
      { reason: "Continue local work, but do not retry a remote mutation until the repository has full access." },
    );
  }
  return effectiveAccess;
}

export async function bootstrapTerminalRepository(
  env: Pick<Env, "DB">,
  context: HarnessToolContext,
  sandbox: AcquiredTerminalSandbox,
  provider: TerminalSandboxProvider,
  gateway: TerminalGitHubReadGateway,
): Promise<{
  repositoryFullName: string;
  baseRef: string;
  baseSha: string;
  headRef: string;
  outcome: "cloned" | "refreshed";
}> {
  const selection = await loadSelection(env.DB, context.workspaceId, context.workstreamId);
  if (!selection) {
    throw new TerminalToolError("repository_not_configured", "This work stream has no active GitHub repository. Choose an authorized owner/name with terminal_checkout_repository, then retry the repository operation.");
  }
  const remoteAccess = await assertRepositoryRemoteAccess(env.DB, selection, "read_only");
  const alreadyBootstrapped = selection.bootstrappedSandboxGeneration === sandbox.generation;
  const credentialFresh = alreadyBootstrapped
    && Boolean(selection.readTokenExpiresAt)
    && Date.parse(selection.readTokenExpiresAt!) > Date.now() + 5 * 60_000;
  let token: { accessToken: string; expiresAt: string } | null = null;
  if (!credentialFresh) {
    token = await gateway.mintRepositoryToken(selection, remoteAccess, context.signal);
    await gateway.verifyRepositoryIdentity(selection, token.accessToken, context.signal);
    await provider.configureGitHubReadAccess(sandbox.providerSandboxId, {
      gitBasicCredential: btoa(`x-access-token:${token.accessToken}`),
      ghToken: token.accessToken,
    });
  }
  if (!alreadyBootstrapped) {
    if (!token) throw new Error("Repository bootstrap requires a fresh GitHub credential");
    const currentBaseSha = await gateway.resolveBaseRef(selection, token.accessToken, context.signal);
    if (!/^[0-9a-f]{40}$/u.test(currentBaseSha)) {
      throw new TerminalToolError("github_unavailable", "GitHub returned an invalid base commit. Retry repository startup.", { reason: "Retry repository startup after GitHub returns a valid base commit." });
    }
    if (currentBaseSha !== selection.baseSha) {
      throw new TerminalToolError(
        "repository_base_changed",
        `The selected ${selection.baseRef} branch advanced since this workspace was planned. Ask a participant to refresh the repository selection before editing.`,
        { expectedBaseSha: selection.baseSha, currentBaseSha },
      );
    }
  }
  const repositoryUrl = `https://github.com/${selection.repositoryFullName}.git`;
  const canonicalHeader = `http.${repositoryUrl}.extraheader`;
  const sessionExports = [
    `export GH_REPO=${selection.repositoryFullName}`,
    `export AVALON_GIT_BRANCH=${selection.headRef}`,
    `export AVALON_GIT_BASE_BRANCH=${selection.baseRef}`,
    `export AVALON_REMOTE_ACCESS=${remoteAccess}`,
  ].map(shellQuote).join(" ");
  const command = [
    "set -euo pipefail",
    "mkdir -p /workspace/.avalon",
    `printf '%s\\n' ${sessionExports} > /workspace/.avalon/session.env`,
    "chmod 600 /workspace/.avalon/session.env",
    "if [ -n \"${CURL_CA_BUNDLE:-}\" ]; then",
    "  test -r \"$CURL_CA_BUNDLE\"",
    "  export GIT_SSL_CAINFO=\"$CURL_CA_BUNDLE\"",
    "  printf 'export GIT_SSL_CAINFO=%q\\n' \"$GIT_SSL_CAINFO\" >> /workspace/.avalon/session.env",
    "fi",
    "if [ ! -d /workspace/.git ]; then",
    "  rm -rf -- /workspace/repository.tmp",
    `  git -c ${shellQuote(canonicalHeader)}="Authorization: Basic $GITHUB_READ_BASIC" clone --no-checkout ${shellQuote(repositoryUrl)} /workspace/repository.tmp`,
    "  cp -a /workspace/repository.tmp/.git /workspace/.git",
    "  rm -rf /workspace/repository.tmp",
    "fi",
    `git config ${shellQuote(canonicalHeader)} "Authorization: Basic $GITHUB_READ_BASIC"`,
    "git config user.name 'Avalon Agent'",
    "git config user.email 'avalon-agent@users.noreply.github.com'",
    "git config push.default current",
    ...(alreadyBootstrapped ? [] : [
      "git fetch --prune origin '+refs/heads/*:refs/remotes/origin/*'",
      `test "$(git rev-parse ${shellQuote(`origin/${selection.baseRef}`)})" = ${shellQuote(selection.baseSha)}`,
    ]),
    ...(alreadyBootstrapped ? [
      `if ! git checkout ${shellQuote(selection.headRef)}; then`,
      `  printf '%s\n' ${shellQuote(`Avalon could not restore ${selection.headRef}; inspect git status and finish or abort the active Git operation before pushing.`)} >&2`,
      "fi",
    ] : [
      `if git show-ref --verify --quiet ${shellQuote(`refs/heads/${selection.headRef}`)}; then`,
      `  git checkout ${shellQuote(selection.headRef)}`,
      `elif git show-ref --verify --quiet ${shellQuote(`refs/remotes/origin/${selection.headRef}`)}; then`,
      `  git checkout -b ${shellQuote(selection.headRef)} --track ${shellQuote(`origin/${selection.headRef}`)}`,
      "else",
      `  git checkout -b ${shellQuote(selection.headRef)} ${shellQuote(selection.baseSha)}`,
      "fi",
      `test "$(git branch --show-current)" = ${shellQuote(selection.headRef)}`,
    ]),
    `if git show-ref --verify --quiet ${shellQuote(`refs/remotes/origin/${selection.headRef}`)}; then`,
    `  git branch --set-upstream-to=${shellQuote(`origin/${selection.headRef}`)} ${shellQuote(selection.headRef)}`,
    "fi",
    "grep -qxF '.avalon/' .git/info/exclude || printf '.avalon/\\n' >> .git/info/exclude",
  ].join("\n");
  const result = await provider.runCommand(sandbox.providerSandboxId, {
    taskName: `avalon-bootstrap-${sandbox.generation}`,
    command,
    cwd: "/workspace",
    timeoutMs: 180_000,
  });
  if (result.exitCode !== 0) {
    await provider.clearGitHubReadAccess(sandbox.providerSandboxId).catch(() => undefined);
    throw new TerminalToolError(
      "repository_bootstrap_failed",
      "The selected repository could not be cloned or checked out. Retry startup; if it persists, reconnect GitHub or reselect the repository.",
      { reason: "Retry startup; if it persists, reconnect GitHub or reselect the repository." },
    );
  }
  if (token || !alreadyBootstrapped) {
    await env.DB.prepare(
      `UPDATE workstream_terminal_repositories
          SET bootstrapped_sandbox_generation = ?, read_token_expires_at = COALESCE(?, read_token_expires_at), updated_at = ?
        WHERE workspace_id = ? AND workstream_id = ? AND state = 'selected'
          AND repository_full_name = ? AND base_sha = ?`,
    ).bind(
      sandbox.generation,
      token?.expiresAt ?? null,
      nowIso(),
      context.workspaceId,
      context.workstreamId,
      selection.repositoryFullName,
      selection.baseSha,
    ).run();
  }
  return {
    repositoryFullName: selection.repositoryFullName,
    baseRef: selection.baseRef,
    baseSha: selection.baseSha,
    headRef: selection.headRef,
    outcome: alreadyBootstrapped ? "refreshed" : "cloned",
  };
}

export async function admitTerminalPublicationGrant(
  env: Pick<Env, "DB">,
  input: {
    workspaceId: string;
    workstreamId: string;
    harnessRunId: string;
    triggerMessageId: string | null;
    executionPrincipal: ExecutionPrincipal;
  },
  now = new Date(),
): Promise<{ admitted: true; grantId: string } | { admitted: false; reason: string }> {
  if (!input.triggerMessageId || input.executionPrincipal.type !== "user") {
    return { admitted: false, reason: "participant_message_required" };
  }
  const selection = await loadSelection(env.DB, input.workspaceId, input.workstreamId);
  if (!selection) return { admitted: false, reason: "repository_not_configured" };
  const message = await env.DB.prepare(
    `SELECT message.text_content
       FROM messages message
       JOIN workstream_participants participant
         ON participant.workstream_id = message.workstream_id
        AND participant.user_id = message.author_user_id
        AND participant.removed_at IS NULL
      WHERE message.id = ? AND message.workspace_id = ? AND message.workstream_id = ?
        AND message.author_type = 'human' AND message.author_user_id = ?`,
  ).bind(
    input.triggerMessageId,
    input.workspaceId,
    input.workstreamId,
    input.executionPrincipal.userId,
  ).first<{ text_content: string }>();
  if (!message) return { admitted: false, reason: "participant_message_required" };
  const id = newId(now.getTime());
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 2 * 60 * 60_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO terminal_publication_grants
     (id, workspace_id, workstream_id, harness_run_id, source_message_id, principal_key,
      repository_full_name, base_ref, head_ref, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, harness_run_id, source_message_id, repository_full_name) DO NOTHING`,
  ).bind(
    id,
    input.workspaceId,
    input.workstreamId,
    input.harnessRunId,
    input.triggerMessageId,
    executionPrincipalKey(input.executionPrincipal),
    selection.repositoryFullName,
    selection.baseRef,
    selection.headRef,
    expiresAt,
    createdAt,
  ).run();
  const grant = await env.DB.prepare(
    `SELECT id FROM terminal_publication_grants
      WHERE workspace_id = ? AND harness_run_id = ? AND source_message_id = ? AND repository_full_name = ?`,
  ).bind(input.workspaceId, input.harnessRunId, input.triggerMessageId, selection.repositoryFullName).first<{ id: string }>();
  if (!grant) throw new Error("Unable to persist the Terminal publication grant");
  return { admitted: true, grantId: grant.id };
}

async function runInspection(
  provider: TerminalSandboxProvider,
  sandboxId: string,
  operation: string,
  command: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return provider.runCommand(sandboxId, {
    taskName: `avalon-publish-${operation}`,
    command,
    cwd: "/workspace",
    timeoutMs: 60_000,
  });
}

function publishedOutput(row: CompletedPublicationRow): TerminalPublishedBranchAndPrOutput {
  return {
    repository: row.repository_full_name,
    baseRef: row.base_ref,
    headRef: row.head_ref,
    commitSha: row.published_sha,
    publishedSha: row.published_sha,
    outcome: "unchanged" as const,
    pullRequest: {
      number: row.pull_request_number,
      url: row.pull_request_url,
      title: row.title,
      state: "open" as const,
    },
  };
}

export function createTerminalRepositoryPublisher(
  env: Pick<Env, "DB">,
  gateway: TerminalGitHubPublicationGateway,
): TerminalRepositoryPublisher {
  return {
    async publishBranchAndPr(context, input, sandbox, provider) {
      const selection = await loadSelection(env.DB, context.workspaceId, context.workstreamId);
      if (!selection) {
        throw new TerminalToolError(
          "repository_not_configured",
          "This work stream has no active GitHub repository. Choose one with terminal_checkout_repository, then retry publish_branch_and_pr.",
        );
      }
      await assertRepositoryRemoteAccess(env.DB, selection, "full_access");
      const invocation = await env.DB.prepare(
        `SELECT id FROM tool_invocations
          WHERE workspace_id = ? AND workstream_id = ? AND harness_run_id = ? AND tool_call_id = ?`,
      ).bind(context.workspaceId, context.workstreamId, context.harnessRunId, context.toolCallId).first<InvocationRow>();
      if (!invocation) throw new TerminalToolError("tool_receipt_missing", "Avalon could not find the durable publication receipt. Retry publication.", { reason: "Retry the same publication call so Avalon can create its durable receipt first." });
      const completed = await env.DB.prepare(
        `SELECT published_sha, pull_request_number, pull_request_url, head_ref,
                repository_full_name, base_ref, title
           FROM repository_publications
          WHERE workspace_id = ? AND tool_invocation_id = ? AND state = 'completed'`,
      ).bind(context.workspaceId, invocation.id).first<CompletedPublicationRow>();
      if (completed) return publishedOutput(completed);

      const grant = await env.DB.prepare(
        `SELECT id, principal_key, repository_full_name, base_ref, head_ref
           FROM terminal_publication_grants
          WHERE workspace_id = ? AND workstream_id = ? AND harness_run_id = ?
            AND repository_full_name = ?
          ORDER BY created_at DESC LIMIT 1`,
      ).bind(
        context.workspaceId,
        context.workstreamId,
        context.harnessRunId,
        selection.repositoryFullName,
      ).first<GrantRow>();
      if (
        !grant
        || grant.principal_key !== executionPrincipalKey(context.executionPrincipal)
        || grant.repository_full_name !== selection.repositoryFullName
        || grant.base_ref !== selection.baseRef
        || grant.head_ref !== selection.headRef
      ) {
        throw new TerminalToolError(
          "publication_not_authorized",
          "This run no longer has the current participant and repository authority needed to publish. Restore connector access or continue from an active participant run.",
          { reason: "Continue from an active participant run with full repository access." },
        );
      }

      const status = await runInspection(provider, sandbox.providerSandboxId, "status", "git status --porcelain=v1 --untracked-files=all");
      if (status.exitCode !== 0) throw new TerminalToolError("repository_unavailable", "The sandbox root is not a usable Git repository. Inspect `git status` and repair it before publishing.", { reason: "Run git status, repair the repository state, and retry publication." });
      if (status.stdout.trim()) {
        throw new TerminalToolError("working_tree_dirty", "The repository has uncommitted changes. Review them, commit the intended files on the Avalon branch, then retry publish_branch_and_pr.", { reason: "Commit or discard every intended working-tree change before retrying." });
      }
      const branch = await runInspection(provider, sandbox.providerSandboxId, "branch", "git branch --show-current");
      if (branch.exitCode !== 0 || branch.stdout.trim() !== selection.headRef) {
        throw new TerminalToolError("publication_conflict", `The repository must be on ${selection.headRef}. Check out that host-selected branch and retry.`, { reason: "Check out the fixed work-stream branch, then revalidate the committed changes." });
      }
      const head = await runInspection(provider, sandbox.providerSandboxId, "head", "git rev-parse HEAD");
      const headSha = head.stdout.trim();
      if (head.exitCode !== 0 || !/^[0-9a-f]{40}$/u.test(headSha)) {
        throw new TerminalToolError("publication_conflict", "Git did not return a committed HEAD. Commit the intended changes and retry publication.");
      }
      const ancestry = await runInspection(
        provider,
        sandbox.providerSandboxId,
        "ancestry",
        `git merge-base --is-ancestor ${selection.baseSha} ${headSha}`,
      );
      if (ancestry.exitCode !== 0) {
        throw new TerminalToolError("publication_conflict", `The branch no longer descends from the selected base ${selection.baseSha}. Rebase it onto ${selection.baseRef} and retry.`);
      }
      const changed = await runInspection(
        provider,
        sandbox.providerSandboxId,
        "paths",
        `git diff --name-only ${selection.baseSha}...${headSha}`,
      );
      const paths = changed.stdout.split("\n").map((path) => path.trim()).filter(Boolean);
      if (changed.exitCode !== 0) throw new TerminalToolError("publication_conflict", "Git could not enumerate the committed changes. Inspect the base ancestry and retry.", { reason: "Inspect the base ancestry and committed diff before retrying." });
      if (paths.length === 0) throw new TerminalToolError("nothing_to_publish", "The branch has no committed changes relative to the selected base. Commit a change before publishing.");
      if (paths.length > MAX_CHANGED_PATHS) throw new TerminalToolError("limit_exceeded", `The branch changes ${paths.length} paths; publication allows at most ${MAX_CHANGED_PATHS}. Split the change into a smaller pull request.`);
      if (paths.some((path) => path === ".github/workflows" || path.startsWith(".github/workflows/"))) {
        throw new TerminalToolError("publication_policy_denied", "Terminal cannot publish GitHub Actions workflow changes. Remove `.github/workflows/` changes and ask a coding workflow with elevated review to publish them.");
      }
      const bundlePath = `/workspace/.avalon/publications/${invocation.id}.bundle`;
      const bundle = await runInspection(
        provider,
        sandbox.providerSandboxId,
        "bundle",
        `mkdir -p /workspace/.avalon/publications && git bundle create ${shellQuote(bundlePath)} ${shellQuote(`refs/heads/${selection.headRef}`)} && stat -c %s -- ${shellQuote(bundlePath)}`,
      );
      if (bundle.exitCode !== 0) throw new TerminalToolError("publication_conflict", "Git could not create the bounded publication bundle. Verify the branch ref and retry.", { reason: "Verify the fixed branch ref and committed objects before retrying." });
      const bundleSize = Number(bundle.stdout.trim());
      if (!Number.isSafeInteger(bundleSize) || bundleSize <= 0 || bundleSize > MAX_BUNDLE_BYTES) {
        throw new TerminalToolError("limit_exceeded", `The Git bundle is ${bundle.stdout.trim() || "an unknown size"}; publication requires a nonempty bundle at most ${MAX_BUNDLE_BYTES} bytes. Reduce large committed files and retry.`);
      }
      const bundleBytes = await provider.readFile(sandbox.providerSandboxId, bundlePath);
      if (bundleBytes.byteLength === 0 || bundleBytes.byteLength > MAX_BUNDLE_BYTES) {
        throw new TerminalToolError("limit_exceeded", `The Git bundle is ${bundleBytes.byteLength} bytes; publication requires a nonempty bundle at most ${MAX_BUNDLE_BYTES}. Reduce large committed files and retry.`);
      }

      if (context.executionPrincipal.type !== "user") {
        throw new TerminalToolError("publication_not_authorized", "Publication requires a current human work-stream participant. Stop and ask a participant to request publication.");
      }
      const participant = await env.DB.prepare(
        `SELECT 1 AS present FROM workstream_participants
          WHERE workstream_id = ? AND user_id = ? AND removed_at IS NULL`,
      ).bind(context.workstreamId, context.executionPrincipal.userId).first<{ present: number }>();
      if (!participant) {
        throw new TerminalToolError("publication_not_authorized", "The participant who requested publication no longer belongs to this work stream. Stop and ask a current participant to request publication.");
      }
      const token = await gateway.mintWriteToken(selection, context.signal);
      try {
        await gateway.verifyRepositoryIdentity(selection, token.accessToken, context.signal);
        const expectedOldSha = await gateway.getRef(selection, selection.headRef, token.accessToken, context.signal);
        const timestamp = nowIso();
        const consumed = await env.DB.prepare(
          `UPDATE terminal_publication_grants
            SET consumed_by_invocation_id = COALESCE(consumed_by_invocation_id, ?),
                consumed_at = COALESCE(consumed_at, ?)
          WHERE workspace_id = ? AND id = ?
          RETURNING id`,
        ).bind(invocation.id, timestamp, context.workspaceId, grant.id).first<{ id: string }>();
        if (!consumed) throw new TerminalToolError("publication_not_authorized", "This run no longer has repository publication authority. Continue from an active participant run with full repository access.");
        const existingPublication = await env.DB.prepare(
          `SELECT id FROM repository_publications
          WHERE workspace_id = ? AND tool_invocation_id = ?`,
        ).bind(context.workspaceId, invocation.id).first<{ id: string }>();
        const publicationId = existingPublication?.id ?? newId();
        await env.DB.prepare(
          `INSERT INTO repository_publications
           (id, workspace_id, workstream_id, tool_invocation_id, grant_id,
            repository_full_name, base_ref, head_ref, expected_old_sha, requested_commit_sha,
            state, title, body, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'publishing', ?, ?, ?, ?)
           ON CONFLICT(workspace_id, tool_invocation_id)
           DO UPDATE SET grant_id = excluded.grant_id,
                         expected_old_sha = excluded.expected_old_sha,
                         requested_commit_sha = excluded.requested_commit_sha,
                         state = 'publishing', title = excluded.title, body = excluded.body,
                         failure_code = NULL, updated_at = excluded.updated_at`,
        ).bind(
          publicationId,
          context.workspaceId,
          context.workstreamId,
          invocation.id,
          grant.id,
          selection.repositoryFullName,
          selection.baseRef,
          selection.headRef,
          expectedOldSha,
          headSha,
          input.title,
          input.body,
          timestamp,
          timestamp,
        ).run();
        try {
          const published = await provider.publishGitBundle({
            operationId: publicationId,
            bundle: bundleBytes,
            repositoryFullName: selection.repositoryFullName,
            baseSha: selection.baseSha,
            headSha,
            headRef: selection.headRef,
            expectedOldSha,
            githubBasicCredential: btoa(`x-access-token:${token.accessToken}`),
          });
          let pullRequest = await gateway.findPullRequest(selection, token.accessToken, context.signal);
          let outcome: "created" | "updated" = "created";
          if (pullRequest) {
            if (pullRequest.state !== "open") {
              throw new TerminalToolError("publication_target_closed", "The convergent pull request is already closed or merged. Avalon will not reopen it or create a duplicate branch; select a fresh work stream for a new pull request.");
            }
            pullRequest = await gateway.updatePullRequest(selection, token.accessToken, pullRequest.number, input, context.signal);
            outcome = "updated";
          } else {
            pullRequest = await gateway.createPullRequest(selection, token.accessToken, input, context.signal);
          }
          if (pullRequest.state !== "open" || pullRequest.headSha !== published.publishedSha) {
            throw new TerminalToolError("publication_conflict", "GitHub did not confirm the expected open pull request head. Retry publication so Avalon can reconcile the exact branch and PR.", { reason: "Retry the same publication receipt so Avalon can reconcile the branch and pull request." });
          }
          const completedAt = nowIso();
          await env.DB.prepare(
            `UPDATE repository_publications
              SET state = 'completed', published_sha = ?, pull_request_number = ?,
                  pull_request_url = ?, pull_request_state = 'open', completed_at = ?, updated_at = ?
            WHERE workspace_id = ? AND tool_invocation_id = ?`,
          ).bind(
            published.publishedSha,
            pullRequest.number,
            pullRequest.url,
            completedAt,
            completedAt,
            context.workspaceId,
            invocation.id,
          ).run();
          return {
            repository: selection.repositoryFullName,
            baseRef: selection.baseRef,
            headRef: selection.headRef,
            commitSha: headSha,
            publishedSha: published.publishedSha,
            outcome,
            pullRequest: {
              number: pullRequest.number,
              url: pullRequest.url,
              title: pullRequest.title,
              state: "open" as const,
            },
          };
        } catch (error) {
          await env.DB.prepare(
            `UPDATE repository_publications SET state = 'ambiguous', failure_code = ?, updated_at = ?
            WHERE workspace_id = ? AND tool_invocation_id = ? AND state <> 'completed'`,
          ).bind(
            error instanceof TerminalToolError ? error.code : "provider_publication_failed",
            nowIso(),
            context.workspaceId,
            invocation.id,
          ).run();
          throw error;
        }
      } finally {
        // GitHub cannot scope an installation token to one branch. The exact
        // ref is enforced above, and the one-repository write token is revoked
        // as soon as the trusted publication attempt finishes.
        await gateway.revokeWriteToken(token.accessToken).catch(() => undefined);
      }
    },
  };
}

interface GitHubConnectionRow {
  provider_account_id: string | null;
}

function githubHeaders(token: string): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "Avalon-Terminal-Publisher",
  };
}

async function githubResponse(response: Response): Promise<Record<string, unknown>> {
  const value = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new TerminalToolError("github_unavailable", "GitHub rejected the publication request.", { reason: response.status >= 500 ? "Retry after GitHub recovers." : "Restore repository access before retrying." });
  }
  return value;
}

function prValue(value: Record<string, unknown>): TerminalPullRequest {
  const number = Number(value.number);
  const url = String(value.html_url ?? "");
  const state = value.merged_at ? "merged" : value.state === "closed" ? "closed" : "open";
  const head = value.head && typeof value.head === "object" ? value.head as Record<string, unknown> : {};
  const headSha = String(head.sha ?? "");
  const title = String(value.title ?? "");
  if (!Number.isInteger(number) || number <= 0 || !url.startsWith("https://github.com/") || !/^[0-9a-f]{40}$/u.test(headSha) || !title) {
    throw new TerminalToolError("github_unavailable", "GitHub returned an invalid pull request identity. Retry publication.", { reason: "Retry after GitHub returns a valid pull request identity." });
  }
  return { number, url, state, headSha, title };
}

async function verifyGitHubRepositoryIdentity(
  selection: TerminalRepositorySelection,
  accessToken: string,
  signal: AbortSignal,
): Promise<void> {
  const value = await githubResponse(await fetch(`https://api.github.com/repositories/${selection.repositoryId}`, {
    headers: githubHeaders(accessToken),
    signal,
  }));
  if (Number(value.id) !== selection.repositoryId || String(value.full_name ?? "") !== selection.repositoryFullName) {
    throw new TerminalToolError(
      "connection_revoked",
      "The selected GitHub repository identity changed or is no longer authorized. Stop and ask a participant to refresh the repository selection.",
    );
  }
}

export function createGitHubRestPublicationGateway(env: Env): TerminalGitHubPublicationGateway {
  const api = "https://api.github.com";
  async function installation(selection: TerminalRepositorySelection): Promise<string> {
    const row = await env.DB.prepare(
      `SELECT provider_account_id FROM connector_connections
        WHERE id = ? AND workspace_id = ? AND connector_type = 'github' AND status = 'healthy'`,
    ).bind(selection.connectionId, selection.workspaceId).first<GitHubConnectionRow>();
    if (!row?.provider_account_id || !/^\d+$/u.test(row.provider_account_id)) {
      throw new TerminalToolError("connection_revoked", "The selected GitHub App connection is unavailable. Reconnect it or select another repository.");
    }
    return row.provider_account_id;
  }
  return {
    verifyRepositoryIdentity: verifyGitHubRepositoryIdentity,
    async revokeWriteToken(accessToken) {
      const response = await fetch(`${api}/installation/token`, {
        method: "DELETE",
        headers: githubHeaders(accessToken),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok && response.status !== 404) {
        throw new Error(`GitHub write-token revocation failed (${response.status})`);
      }
    },
    async mintWriteToken(selection, signal) {
      const config = githubConnectorConfig(env);
      if (!config) throw new TerminalToolError("github_unavailable", "The regional Avalon GitHub App is not configured.");
      const installationId = await installation(selection);
      const jwt = await createGitHubAppJwt({ clientId: config.clientId, privateKey: config.privateKey });
      const repositoryName = selection.repositoryFullName.split("/")[1]!;
      const response = await fetch(`${api}/app/installations/${installationId}/access_tokens`, {
        method: "POST",
        headers: githubHeaders(jwt),
        body: JSON.stringify({
          repositories: [repositoryName],
          permissions: { contents: "write", pull_requests: "write", metadata: "read" },
        }),
        signal,
      });
      const value = await githubResponse(response);
      if (typeof value.token !== "string" || !value.token) throw new TerminalToolError("github_unavailable", "GitHub did not return a scoped installation token.");
      return { accessToken: value.token };
    },
    async getRef(selection, ref, accessToken, signal) {
      const encodedRef = ref.split("/").map(encodeURIComponent).join("/");
      const response = await fetch(`${api}/repos/${selection.repositoryFullName}/git/ref/heads/${encodedRef}`, {
        headers: githubHeaders(accessToken), signal,
      });
      if (response.status === 404) return null;
      const value = await githubResponse(response);
      const object = value.object && typeof value.object === "object" ? value.object as Record<string, unknown> : {};
      const sha = String(object.sha ?? "");
      if (!/^[0-9a-f]{40}$/u.test(sha)) throw new TerminalToolError("github_unavailable", "GitHub returned an invalid branch SHA.");
      return sha;
    },
    async findPullRequest(selection, accessToken, signal) {
      const [owner] = selection.repositoryFullName.split("/");
      const query = new URLSearchParams({ state: "all", head: `${owner}:${selection.headRef}`, base: selection.baseRef, per_page: "2" });
      const response = await fetch(`${api}/repos/${selection.repositoryFullName}/pulls?${query}`, { headers: githubHeaders(accessToken), signal });
      const value = await response.json().catch(() => []) as unknown;
      if (!response.ok) await githubResponse(new Response(JSON.stringify(value), { status: response.status, headers: response.headers }));
      if (!Array.isArray(value) || value.length === 0) return null;
      return prValue(value[0] as Record<string, unknown>);
    },
    async createPullRequest(selection, accessToken, input, signal) {
      const response = await fetch(`${api}/repos/${selection.repositoryFullName}/pulls`, {
        method: "POST", headers: githubHeaders(accessToken),
        body: JSON.stringify({ title: input.title, body: input.body, head: selection.headRef, base: selection.baseRef }), signal,
      });
      return prValue(await githubResponse(response));
    },
    async updatePullRequest(selection, accessToken, pullRequestNumber, input, signal) {
      const response = await fetch(`${api}/repos/${selection.repositoryFullName}/pulls/${pullRequestNumber}`, {
        method: "PATCH", headers: githubHeaders(accessToken),
        body: JSON.stringify({ title: input.title, body: input.body }), signal,
      });
      return prValue(await githubResponse(response));
    },
  };
}

export function createGitHubRestReadGateway(env: Env): TerminalGitHubReadGateway {
  const api = "https://api.github.com";
  return {
    verifyRepositoryIdentity: verifyGitHubRepositoryIdentity,
    async mintRepositoryToken(selection, access, signal) {
      const config = githubConnectorConfig(env);
      if (!config) throw new TerminalToolError("github_unavailable", "The regional Avalon GitHub App is not configured.");
      const row = await env.DB.prepare(
        `SELECT provider_account_id FROM connector_connections
          WHERE id = ? AND workspace_id = ? AND connector_type = 'github' AND status = 'healthy'`,
      ).bind(selection.connectionId, selection.workspaceId).first<GitHubConnectionRow>();
      if (!row?.provider_account_id || !/^\d+$/u.test(row.provider_account_id)) {
        throw new TerminalToolError("connection_revoked", "The selected GitHub App connection is unavailable. Reconnect it or select another repository.");
      }
      const jwt = await createGitHubAppJwt({ clientId: config.clientId, privateKey: config.privateKey });
      const repositoryName = selection.repositoryFullName.split("/")[1]!;
      const response = await fetch(`${api}/app/installations/${row.provider_account_id}/access_tokens`, {
        method: "POST",
        headers: githubHeaders(jwt),
        body: JSON.stringify({
          repositories: [repositoryName],
          permissions: {
            contents: access === "full_access" ? "write" : "read",
            metadata: "read",
            pull_requests: access === "full_access" ? "write" : "read",
            actions: "read",
            checks: "read",
          },
        }),
        signal,
      });
      const value = await githubResponse(response);
      if (typeof value.token !== "string" || !value.token || typeof value.expires_at !== "string") {
        throw new TerminalToolError("github_unavailable", "GitHub did not return a scoped read token and expiry.");
      }
      return { accessToken: value.token, expiresAt: value.expires_at };
    },
    async resolveBaseRef(selection, accessToken, signal) {
      const encodedRef = selection.baseRef.split("/").map(encodeURIComponent).join("/");
      const value = await githubResponse(await fetch(
        `${api}/repos/${selection.repositoryFullName}/git/ref/heads/${encodedRef}`,
        { headers: githubHeaders(accessToken), signal },
      ));
      const object = value.object && typeof value.object === "object" ? value.object as Record<string, unknown> : {};
      const sha = String(object.sha ?? "");
      if (!/^[0-9a-f]{40}$/u.test(sha)) throw new TerminalToolError("github_unavailable", "GitHub returned an invalid base branch SHA.");
      return sha;
    },
  };
}
