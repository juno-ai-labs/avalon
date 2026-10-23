import type { HarnessToolContext } from "@rally/agent-harness";
import { createTerminalPortFactory, type TerminalPortFactory } from "./object-port";
import {
  createGitHubAppJwt,
  githubRepositoryAuthorization,
  type GitHubRepositoryAccessLevel,
} from "@rally/connectors";
import type { ExecutionPrincipal, SidekickExecutionDelegation } from "@rally/contracts";
import { newId } from "@rally/db";

import type { Env } from "../../env";
import { githubConnectorConfig } from "../../lib/connector-registry";
import { createMessageObjectPort } from "../../runtime/message-port";
import { executionPrincipalKey } from "../workstream-resource-visibility";
import { terminalGitCaSetupCommands, type TerminalSandboxProvider } from "./provider-contract";
import type { AcquiredTerminalSandbox } from "./coordinator";
import type { TerminalRepositoryPublisher } from "./runtime";
import type { TerminalInstructionFiles } from "./instructions";
import { requireTerminalEffectIntent, TerminalToolError, type TerminalPublishedBranchAndPrOutput } from "./tools";
import { createIdentityObjectPort } from "../../runtime/identity-port";

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
  mintWriteToken(
    selection: TerminalRepositorySelection,
    signal: AbortSignal,
  ): Promise<{ accessToken: string; expiresAt: string }>;
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

interface CompletedPublicationRow {
  published_sha: string;
  pull_request_number: number;
  pull_request_url: string;
  head_ref: string;
  repository_full_name: string;
  base_ref: string;
  title: string;
}

async function loadSelection(
  env: Env,
  workspaceId: string,
  workstreamId: string,
  terminalPortFactory: TerminalPortFactory,
): Promise<TerminalRepositorySelection | null> {
  const row = await terminalPortFactory(workspaceId, workstreamId)
    .selectedRepository();
  return row
    ? {
        workspaceId,
        workstreamId,
        connectionId: row.connectionId,
        repositoryId: row.repositoryId,
        repositoryFullName: row.repositoryFullName,
        baseRef: row.baseRef,
        baseSha: row.baseSha,
        headRef: row.headRef,
        remoteAccess: row.remoteAccess,
        bootstrappedSandboxGeneration: row.bootstrappedSandboxGeneration,
        // The object stores epoch milliseconds; this contract is ISO-8601.
        readTokenExpiresAt: row.readTokenExpiresAt
          ? new Date(row.readTokenExpiresAt).toISOString()
          : null,
      }
    : null;
}

async function assertRepositoryRemoteAccess(
  database: D1Database,
  selection: TerminalRepositorySelection,
  required: "read_only" | "full_access",
  delegation?: SidekickExecutionDelegation,
): Promise<GitHubRepositoryAccessLevel> {
  const row = await database.prepare(
    `SELECT scope, owner_user_id, COALESCE(config_json, '{}') AS config_json
       FROM connector_connections
      WHERE id = ? AND workspace_id = ? AND connector_type = 'github' AND status <> 'disabled'`,
  ).bind(selection.connectionId, selection.workspaceId).first<{ scope: string; owner_user_id: string | null; config_json: string }>();
  if (delegation && (!row || (row.scope === "personal"
    && !delegation.delegates.some((delegate) => delegate.userId === row.owner_user_id)))) {
    throw new TerminalToolError("repository_delegate_unavailable", "The selected GitHub connection needs an eligible delegate before remote repository work.");
  }
  if (!row) {
    throw new TerminalToolError(
      "repository_access_revoked",
      `${selection.repositoryFullName} is no longer authorized by an active GitHub connection. Choose another authorized repository with checkout_repository or reconnect GitHub.`,
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
      `${selection.repositoryFullName} is no longer authorized by GitHub connector settings. Choose another authorized repository with checkout_repository or ask a connector administrator to restore access.`,
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
  env: Env,
  context: HarnessToolContext,
  sandbox: AcquiredTerminalSandbox,
  provider: TerminalSandboxProvider,
  gateway: TerminalGitHubReadGateway,
  terminalPortFactory: TerminalPortFactory = createTerminalPortFactory(env),
  /**
   * The checkout's own instruction files. The clone is the moment a checkout
   * exists, so the root `AGENTS.md` is probed by this same command, for a
   * fresh clone and a restored one alike; the probe is isolated from this
   * script's `set -e` and only the clone's exit code decides the outcome.
   */
  instructions?: TerminalInstructionFiles,
  delegation?: SidekickExecutionDelegation,
): Promise<{
  repositoryFullName: string;
  baseRef: string;
  baseSha: string;
  headRef: string;
  outcome: "cloned" | "refreshed";
}> {
  const selection = await loadSelection(
    env,
    context.workspaceId,
    context.workstreamId,
    terminalPortFactory,
  );
  if (!selection) {
    throw new TerminalToolError("repository_not_configured", "This work stream has no active GitHub repository. Choose an authorized owner/name with checkout_repository, then retry the repository operation.");
  }
  const remoteAccess = await assertRepositoryRemoteAccess(env.DB, selection, "read_only", delegation);
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
  const instructionProbe = instructions
    ? await instructions.fragment({ touched: [] })
    : null;
  const sessionExports = [
    `export GH_REPO=${selection.repositoryFullName}`,
    `export AVALON_GIT_BRANCH=${selection.headRef}`,
    `export AVALON_GIT_BASE_BRANCH=${selection.baseRef}`,
    `export AVALON_REMOTE_ACCESS=${remoteAccess}`,
  ].map(shellQuote).join(" ");
  const command = [
    "set -euo pipefail",
    "mkdir -p /workspace/.rally",
    `printf '%s\\n' ${sessionExports} > /workspace/.rally/session.env`,
    "chmod 600 /workspace/.rally/session.env",
    ...terminalGitCaSetupCommands({
      required: false,
      sessionEnvPath: "/workspace/.rally/session.env",
    }),
    "if [ ! -d /workspace/.git ]; then",
    "  rm -rf -- /workspace/repository.tmp",
    `  git -c ${shellQuote(canonicalHeader)}="Authorization: Basic $GITHUB_READ_BASIC" clone --no-checkout ${shellQuote(repositoryUrl)} /workspace/repository.tmp`,
    "  cp -a /workspace/repository.tmp/.git /workspace/.git",
    "  rm -rf /workspace/repository.tmp",
    "fi",
    `git config ${shellQuote(canonicalHeader)} "Authorization: Basic $GITHUB_READ_BASIC"`,
    "git config user.name 'Rally Agent'",
    "git config user.email 'rally-agent@users.noreply.github.com'",
    "git config push.default current",
    ...(alreadyBootstrapped ? [] : [
      "git fetch --prune origin '+refs/heads/*:refs/remotes/origin/*'",
      `test "$(git rev-parse ${shellQuote(`origin/${selection.baseRef}`)})" = ${shellQuote(selection.baseSha)}`,
    ]),
    ...(alreadyBootstrapped ? [
      `if ! git checkout ${shellQuote(selection.headRef)}; then`,
      `  printf '%s\n' ${shellQuote(`Rally could not restore ${selection.headRef}; inspect git status and finish or abort the active Git operation before pushing.`)} >&2`,
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
    "grep -qxF '.rally/' .git/info/exclude || printf '.rally/\\n' >> .git/info/exclude",
    ...(instructionProbe ? [instructionProbe.text] : []),
  ].join("\n");
  const result = await provider.runUtilityCommand(sandbox.providerSandboxId, {
    operation: "repository.bootstrap",
    command,
    cwd: "/workspace",
    timeoutMs: 180_000,
  });
  if (result.exitCode === 0 && instructions && instructionProbe) {
    // Best-effort by contract: a failure here is reported through the
    // instruction files' own observer and the root is rediscovered by the
    // first touch, which begins every chain at the root.
    await instructions.record({ stdout: result.stdout, marker: instructionProbe.marker, sourceGeneration: sandbox.generation });
  }
  if (result.exitCode !== 0) {
    await provider.clearGitHubReadAccess(sandbox.providerSandboxId).catch(() => undefined);
    throw new TerminalToolError(
      "repository_bootstrap_failed",
      "The selected repository could not be cloned or checked out. Retry startup; if it persists, reconnect GitHub or reselect the repository.",
      { reason: "Retry startup; if it persists, reconnect GitHub or reselect the repository." },
    );
  }
  if (token || !alreadyBootstrapped) {
    await terminalPortFactory(context.workspaceId, context.workstreamId)
      .recordRepositoryBootstrap({
        generation: sandbox.generation,
        readTokenExpiresAt: token?.expiresAt ? Date.parse(token.expiresAt) : null,
        repositoryFullName: selection.repositoryFullName,
        baseSha: selection.baseSha,
        now: Date.now(),
      });
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
  env: Env,
  input: {
    workspaceId: string;
    workstreamId: string;
    harnessRunId: string;
    triggerMessageId: string | null;
    executionPrincipal: ExecutionPrincipal;
  },
  now = new Date(),
  terminalPortFactory: TerminalPortFactory = createTerminalPortFactory(env),
): Promise<{ admitted: true; grantId: string } | { admitted: false; reason: string }> {
  if (!input.triggerMessageId || input.executionPrincipal.type !== "user") {
    return { admitted: false, reason: "participant_message_required" };
  }
  const selection = await loadSelection(
    env,
    input.workspaceId,
    input.workstreamId,
    terminalPortFactory,
  );
  if (!selection) return { admitted: false, reason: "repository_not_configured" };
  const message = await createMessageObjectPort(env, input.workspaceId, input.workstreamId)
    .messageFromParticipant({
      messageId: input.triggerMessageId,
      authorUserId: input.executionPrincipal.userId,
    });
  if (!message) return { admitted: false, reason: "participant_message_required" };
  const terminal = terminalPortFactory(input.workspaceId, input.workstreamId);
  await terminal.admitPublicationGrant({
    grantId: newId(now.getTime()),
    runId: input.harnessRunId,
    sourcePartId: input.triggerMessageId,
    principalKey: executionPrincipalKey(input.executionPrincipal),
    repositoryFullName: selection.repositoryFullName,
    baseRef: selection.baseRef,
    headRef: selection.headRef,
    expiresAt: now.getTime() + 2 * 60 * 60_000,
    now: now.getTime(),
  });
  // Read back rather than trusting the insert: the unique constraint makes a
  // replayed admission a no-op, and the first grant's id is the one that counts.
  const grant = await terminal.latestPublicationGrant({
    runId: input.harnessRunId,
    repositoryFullName: selection.repositoryFullName,
  });
  if (!grant) throw new Error("Unable to persist the Terminal publication grant");
  return { admitted: true, grantId: grant.grantId };
}

async function runInspection(
  provider: TerminalSandboxProvider,
  sandboxId: string,
  operation: "status" | "branch" | "head" | "ancestry" | "paths",
  command: string,
  timeoutMs = 60_000,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return provider.runUtilityCommand(sandboxId, {
    operation: `repository.publish.${operation}`,
    command,
    cwd: "/workspace",
    timeoutMs,
  });
}

async function runPublishStep(
  provider: TerminalSandboxProvider,
  sandboxId: string,
  command: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return provider.runUtilityCommand(sandboxId, {
    operation: "repository.publish.push",
    command,
    cwd: "/workspace",
    timeoutMs: 180_000,
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
  env: Env,
  gateway: TerminalGitHubPublicationGateway,
  terminalPortFactory: TerminalPortFactory = createTerminalPortFactory(env),
  delegation?: SidekickExecutionDelegation,
): TerminalRepositoryPublisher {
  return {
    async publishBranchAndPr(context, input, sandbox, provider) {
      const selection = await loadSelection(
        env,
        context.workspaceId,
        context.workstreamId,
        terminalPortFactory,
      );
      if (!selection) {
        throw new TerminalToolError(
          "repository_not_configured",
          "This work stream has no active GitHub repository. Choose one with checkout_repository, then retry publish_branch_and_pr.",
        );
      }
      await assertRepositoryRemoteAccess(env.DB, selection, "full_access", delegation);
      const effectIntentId = requireTerminalEffectIntent(context, "repositoryPublication");
      const terminal = terminalPortFactory(context.workspaceId, context.workstreamId);
      const completed = await terminal.completedPublication(effectIntentId);
      // A row in `completed` always carries these three; the columns are
      // nullable because the row exists from `publishing` onward. Replaying a
      // receipt that somehow lacks them would report a publish that cannot be
      // pointed at, so it fails loudly instead.
      if (completed) {
        if (
          completed.publishedSha === null
          || completed.pullRequestNumber === null
          || completed.pullRequestUrl === null
        ) throw new Error("terminal_publication_receipt_incomplete");
        return publishedOutput({
          published_sha: completed.publishedSha,
          pull_request_number: completed.pullRequestNumber,
          pull_request_url: completed.pullRequestUrl,
          head_ref: completed.headRef,
          repository_full_name: completed.repositoryFullName,
          base_ref: completed.baseRef,
          title: completed.title,
        });
      }

      const grant = await terminal.latestPublicationGrant({
        runId: context.harnessRunId,
        repositoryFullName: selection.repositoryFullName,
      });
      if (
        !grant
        || grant.principalKey !== executionPrincipalKey(context.executionPrincipal)
        || grant.repositoryFullName !== selection.repositoryFullName
        || grant.baseRef !== selection.baseRef
        || grant.headRef !== selection.headRef
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
        throw new TerminalToolError("working_tree_dirty", "The repository has uncommitted changes. Review them, commit the intended files on the Rally branch, then retry publish_branch_and_pr.", { reason: "Commit or discard every intended working-tree change before retrying." });
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
      if (context.executionPrincipal.type !== "user") {
        throw new TerminalToolError("publication_not_authorized", "Publication requires a current human work-stream participant. Stop and ask a participant to request publication.");
      }
      const requesterUserId = context.executionPrincipal.userId;
      const participant = (await createIdentityObjectPort(
        env,
        context.workspaceId,
        context.workstreamId,
      ).participants()).some((row) => row.user_id === requesterUserId);
      if (!participant) {
        throw new TerminalToolError("publication_not_authorized", "The participant who requested publication no longer belongs to this work stream. Stop and ask a current participant to request publication.");
      }
      const token = await gateway.mintWriteToken(selection, context.signal);
      await gateway.verifyRepositoryIdentity(selection, token.accessToken, context.signal);
      // Publication is the one point in a run that must guarantee the mounted
      // Git credential remains valid for the complete remote mutation. Reuse
      // the freshly minted publication token instead of rechecking or rotating
      // the sandbox credential before every ordinary Terminal operation.
      await provider.configureGitHubReadAccess(sandbox.providerSandboxId, {
        gitBasicCredential: btoa(`x-access-token:${token.accessToken}`),
        ghToken: token.accessToken,
      });
      await terminal.recordRepositoryBootstrap({
        generation: sandbox.generation,
        readTokenExpiresAt: Date.parse(token.expiresAt),
        repositoryFullName: selection.repositoryFullName,
        baseSha: selection.baseSha,
        now: Date.now(),
      });
      const expectedOldSha = await gateway.getRef(selection, selection.headRef, token.accessToken, context.signal);
        const consumed = await terminal.consumePublicationGrant({
          grantId: grant.grantId,
          effectIntentId,
          now: Date.now(),
        });
        if (!consumed) throw new TerminalToolError("publication_not_authorized", "This run no longer has repository publication authority. Continue from an active participant run with full repository access.");
        const publicationId = newId();
        await terminal.beginPublication({
          publicationId,
          effectIntentId,
          grantId: grant.grantId,
          repositoryFullName: selection.repositoryFullName,
          baseRef: selection.baseRef,
          headRef: selection.headRef,
          expectedOldSha,
          requestedCommitSha: headSha,
          title: input.title,
          body: input.body,
          now: Date.now(),
        });
        try {
          // A missing ref and an empty successful ls-remote result are both the
          // empty string, so first publication passes the same SHA fence.
          const expectedOld = expectedOldSha ?? "";
          const repositoryUrl = `https://github.com/${selection.repositoryFullName}.git`;
          // A per-publication alias outranks any model-authored broad URL
          // rewrite without putting the credential in the command. The fixed
          // config also prevents Git from adding tags to the exact refspec.
          const repositoryUrlAlias = `rally-publish-${publicationId}://repository`;
          const insteadOf = `url.${repositoryUrl}.insteadOf=${repositoryUrlAlias}`;
          const pushInsteadOf = `url.${repositoryUrl}.pushInsteadOf=${repositoryUrlAlias}`;
          const push = await runPublishStep(provider, sandbox.providerSandboxId, [
            "set -euo pipefail",
            "publish_stage=remote_verify",
            "trap 'rally_status=$?; if [ \"$rally_status\" -ne 0 ]; then printf \"RALLY_PUBLISH_FAILED_STAGE=%s\\n\" \"$publish_stage\"; fi; exit \"$rally_status\"' EXIT",
            `remote_sha=$(git -c ${shellQuote(insteadOf)} ls-remote ${shellQuote(repositoryUrlAlias)} ${shellQuote(`refs/heads/${selection.headRef}`)} | cut -f1)`,
            `test "$remote_sha" = ${shellQuote(expectedOld)}`,
            "publish_stage=remote_push",
            `git -c ${shellQuote(insteadOf)} -c ${shellQuote(pushInsteadOf)} -c core.hooksPath=/dev/null -c push.followTags=false push ${shellQuote(repositoryUrlAlias)} ${shellQuote(`${headSha}:refs/heads/${selection.headRef}`)}`,
            "publish_stage=post_push_verify",
            `test "$(git -c ${shellQuote(insteadOf)} ls-remote ${shellQuote(repositoryUrlAlias)} ${shellQuote(`refs/heads/${selection.headRef}`)} | cut -f1)" = ${shellQuote(headSha)}`,
            "trap - EXIT",
            "printf 'published\\n'",
          ].join("\n"));
          if (push.exitCode !== 0) {
            const output = `${push.stdout}\n${push.stderr}`;
            const stage = /^RALLY_PUBLISH_FAILED_STAGE=([a-z_]+)$/mu.exec(output)?.[1] ?? "unknown_stage";
            throw new TerminalToolError(
              "provider_publication_failed",
              `Trusted Git publication failed at ${stage} with exit code ${push.exitCode}`,
              { stage, exitCode: push.exitCode },
            );
          }
          let pullRequest = await gateway.findPullRequest(selection, token.accessToken, context.signal);
          let outcome: "created" | "updated" = "created";
          if (pullRequest) {
            if (pullRequest.state !== "open") {
              throw new TerminalToolError("publication_target_closed", "The convergent pull request is already closed or merged. Rally will not reopen it or create a duplicate branch; select a fresh work stream for a new pull request.");
            }
            pullRequest = await gateway.updatePullRequest(selection, token.accessToken, pullRequest.number, input, context.signal);
            outcome = "updated";
          } else {
            pullRequest = await gateway.createPullRequest(selection, token.accessToken, input, context.signal);
          }
          if (pullRequest.state !== "open" || pullRequest.headSha !== headSha) {
            throw new TerminalToolError("publication_conflict", "GitHub did not confirm the expected open pull request head. Retry publication so Rally can reconcile the exact branch and PR.", { reason: "Retry the same publication receipt so Rally can reconcile the branch and pull request." });
          }
          await terminal.completePublication({
            effectIntentId,
            publishedSha: headSha,
            pullRequestNumber: pullRequest.number,
            pullRequestUrl: pullRequest.url,
            now: Date.now(),
          });
          return {
            repository: selection.repositoryFullName,
            baseRef: selection.baseRef,
            headRef: selection.headRef,
            commitSha: headSha,
            publishedSha: headSha,
            outcome,
            pullRequest: {
              number: pullRequest.number,
              url: pullRequest.url,
              title: pullRequest.title,
              state: "open" as const,
            },
          };
        } catch (error) {
          await terminal.markPublicationAmbiguous({
            effectIntentId,
            failureCode: error instanceof TerminalToolError
              ? error.code
              : "provider_publication_failed",
            now: Date.now(),
          });
          throw error;
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
    "user-agent": "Rally-Terminal-Publisher",
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
    async mintWriteToken(selection, signal) {
      const config = githubConnectorConfig(env);
      if (!config) throw new TerminalToolError("github_unavailable", "The regional Rally GitHub App is not configured.");
      const installationId = await installation(selection);
      const jwt = await createGitHubAppJwt({ clientId: config.clientId, privateKey: config.privateKey });
      const repositoryName = selection.repositoryFullName.split("/")[1]!;
      const response = await fetch(`${api}/app/installations/${installationId}/access_tokens`, {
        method: "POST",
        headers: githubHeaders(jwt),
        body: JSON.stringify({
          repositories: [repositoryName],
          permissions: {
            contents: "write",
            pull_requests: "write",
            metadata: "read",
            actions: "read",
            checks: "read",
          },
        }),
        signal,
      });
      const value = await githubResponse(response);
      if (typeof value.token !== "string" || !value.token || typeof value.expires_at !== "string") {
        throw new TerminalToolError("github_unavailable", "GitHub did not return a scoped installation token and expiry.");
      }
      return { accessToken: value.token, expiresAt: value.expires_at };
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
      if (!config) throw new TerminalToolError("github_unavailable", "The regional Rally GitHub App is not configured.");
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
