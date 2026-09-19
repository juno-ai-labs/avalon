import { asUserId, asWorkspaceId } from "@rally/contracts";
import { NormalizedActivitySchema } from "@rally/contracts";
import { describe, expect, it } from "vitest";
import { neverAborts } from "./test-signals";
import {
  canGitHubPersonalConnectionAccessRepository,
  createGitHubAppJwt,
  createGitHubConnector,
  discoverGitHubConnectionRepositories,
  discoverGitHubWebhookResources,
  githubRepositoryAccessPolicy,
  githubRepositoryAuthorization,
  GitHubCapabilities,
  GitHubWebhookResourceLimits,
  mintGitHubInstallationToken,
  normalizeGitHubWebhook,
  verifyGitHubWebhook,
  verifyGitHubWebhookSignature,
  type GitHubConnectorConfig,
} from "./github";
import type { FetchLike } from "./provider-utils";
import {
  type AuthorizedConnectorConnection,
  authorizedConnection,
} from "./types";

const FIXED_NOW = 1_788_000_000_000;

describe("GitHub connector", () => {
  it("defaults existing connections to all repositories and resolves immutable overrides", () => {
    expect(githubRepositoryAccessPolicy({})).toEqual({
      version: 1,
      revision: 0,
      mode: "all_repositories",
      defaultAccess: "full_access",
      repositories: [],
    });
    const config = {
      githubRepositoryAccess: {
        version: 1,
        revision: 3,
        mode: "all_repositories",
        defaultAccess: "read_only",
        repositories: [{
          repositoryId: "41",
          repositoryFullName: "acme/widget",
          access: "full_access",
        }],
      },
    };
    expect(githubRepositoryAuthorization(config, "ACME/widget", 41)).toEqual({
      access: "full_access",
      expectedRepositoryId: "41",
    });
    expect(githubRepositoryAuthorization(config, "acme/widget", 99)).toBeNull();
    expect(githubRepositoryAuthorization(config, "acme/other", 42)).toEqual({
      access: "read_only",
      expectedRepositoryId: null,
    });
    expect(githubRepositoryAuthorization(config, "acme/renamed-widget", 41)).toEqual({
      access: "full_access",
      expectedRepositoryId: "41",
    });
  });

  it("fails closed for a present malformed repository policy while preserving its revision", () => {
    expect(githubRepositoryAccessPolicy({
      githubRepositoryAccess: {
        version: 2,
        revision: 7,
        mode: "all_repositories",
        defaultAccess: "full_access",
        repositories: [],
      },
    })).toEqual({
      version: 1,
      revision: 7,
      mode: "selected_repositories",
      defaultAccess: "read_only",
      repositories: [],
    });
    expect(githubRepositoryAuthorization({
      githubRepositoryAccess: { revision: 7, mode: "all_repositories" },
    }, "acme/widget", 41)).toBeNull();
  });

  it("denies repositories outside a selected-repository policy", () => {
    const config = {
      githubRepositoryAccess: {
        version: 1,
        revision: 1,
        mode: "selected_repositories",
        defaultAccess: "read_only",
        repositories: [{
          repositoryId: "41",
          repositoryFullName: "acme/widget",
          access: "read_only",
        }],
      },
    };
    expect(githubRepositoryAuthorization(config, "acme/widget", "41")).toEqual({
      access: "read_only",
      expectedRepositoryId: "41",
    });
    expect(githubRepositoryAuthorization(config, "acme/widget", "99")).toBeNull();
    expect(githubRepositoryAuthorization(config, "acme/other", "42")).toBeNull();
  });

  it("filters repository discovery and refuses writes under connector repository policy", async () => {
    const repositories = [
      { id: 41, name: "widget", full_name: "acme/widget" },
      { id: 42, name: "private", full_name: "acme/private" },
    ];
    const adapter = githubAdapter(async (input) => {
      const url = requestUrl(input);
      if (url.pathname === "/user/installations/42/repositories") {
        return jsonResponse({ total_count: repositories.length, repositories });
      }
      if (url.pathname === "/repos/acme/widget") return jsonResponse(repositories[0]);
      if (url.pathname === "/repos/acme/private") return jsonResponse(repositories[1]);
      if (url.pathname === "/graphql") return jsonResponse({ data: {} });
      throw new Error(`Unexpected GitHub URL: ${url}`);
    });
    const connection = personalConnection([
      GitHubCapabilities.metadataRead,
      GitHubCapabilities.issuesWrite,
    ]);
    connection.config.githubRepositoryAccess = {
      version: 1,
      revision: 2,
      mode: "selected_repositories",
      defaultAccess: "read_only",
      repositories: [{
        repositoryId: "41",
        repositoryFullName: "acme/widget",
        access: "read_only",
      }],
    };
    const context = {
      connection,
      principal: { type: "user" as const, userId: asUserId("d6d77053-92bc-4af6-8332-8bea8c4c6904") },
      signal: neverAborts(),
    };

    await expect(adapter.executeTool("repositories.list", {}, context)).resolves.toMatchObject({
      output: {
        totalCount: 1,
        repositories: [{ full_name: "acme/widget", access: "read_only" }],
      },
    });
    await expect(adapter.executeTool("issues.create", {
      owner: "acme",
      repo: "widget",
      title: "Blocked write",
    }, context)).rejects.toMatchObject({
      code: "unauthorized",
      message: expect.stringContaining("read-only"),
    });
    await expect(adapter.executeTool("repository.get", {
      owner: "acme",
      repo: "private",
    }, context)).rejects.toMatchObject({
      code: "unauthorized",
      message: expect.stringContaining("outside this GitHub connection's repository access policy"),
    });
  });

  it("uses immutable repository identity when a configured repository is renamed", async () => {
    const adapter = githubAdapter(async (input) => {
      const url = requestUrl(input);
      if (url.pathname === "/repos/acme/renamed-widget") {
        return jsonResponse({ id: 41, full_name: "acme/renamed-widget" });
      }
      if (url.pathname === "/repos/acme/renamed-widget/issues") {
        return jsonResponse({ number: 1, title: "Created" }, 201);
      }
      throw new Error(`Unexpected GitHub URL: ${url}`);
    });
    const connection = personalConnection([
      GitHubCapabilities.metadataRead,
      GitHubCapabilities.issuesWrite,
    ]);
    connection.config.githubRepositoryAccess = {
      version: 1,
      revision: 2,
      mode: "all_repositories",
      defaultAccess: "full_access",
      repositories: [{
        repositoryId: "41",
        repositoryFullName: "acme/widget",
        access: "read_only",
      }],
    };

    await expect(adapter.executeTool("issues.create", {
      owner: "acme",
      repo: "renamed-widget",
      title: "Must stay read-only",
    }, {
      connection,
      principal: { type: "user" as const, userId: asUserId("d6d77053-92bc-4af6-8332-8bea8c4c6904") },
      signal: neverAborts(),
    })).rejects.toMatchObject({
      code: "unauthorized",
      message: expect.stringContaining("read-only"),
    });
  });

  it("publishes bounded tools and begins with installation before user authorization", async () => {
    const adapter = githubAdapter(async () => jsonResponse({}));
    expect(adapter.manifest).toMatchObject({
      type: "github",
      supportedScopes: ["personal", "workspace"],
      oauthRequired: true,
      supportsWebhooks: true,
      supportsPolling: false,
    });
    expect(new Set(adapter.manifest.tools.map((tool) => tool.name)).size).toBe(adapter.manifest.tools.length);
    expect(adapter.manifest.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "repositories.search", capability: GitHubCapabilities.metadataRead, mode: "read" }),
      expect.objectContaining({ name: "contents.list", capability: GitHubCapabilities.contentsRead, mode: "read" }),
      expect.objectContaining({ name: "contents.get", capability: GitHubCapabilities.contentsRead, mode: "read" }),
      expect.objectContaining({ name: "issues.create", capability: GitHubCapabilities.issuesWrite, mode: "write" }),
      expect.objectContaining({ name: "pull_requests.create_review", capability: GitHubCapabilities.pullRequestsWrite }),
    ]));
    expect(adapter.agentPlugin.systemMessage).toContain("search the authorized repositories and choose the best match");
    expect(adapter.agentPlugin.systemMessage).toContain("read_only permits reads and local Terminal edits or commits");
    expect(adapter.agentPlugin.systemMessage).toContain("at least one code file was successfully returned");
    expect(adapter.agentPlugin.systemMessage).toContain("_contents_get");
    const contentsList = adapter.manifest.tools.find((candidate) => candidate.name === "contents.list");
    expect(contentsList?.inputSchema).toMatchObject({
      properties: {
        offset: { type: "integer" },
        limit: { type: "integer" },
      },
    });
    expect(adapter.validateToolInput?.("issues.update", {
      owner: "juno-ai-labs",
      repo: "avalon",
      issueNumber: 149,
    })).toBeInstanceOf(Error);
    expect(adapter.validateToolInput?.("issues.update", {
      owner: "juno-ai-labs",
      repo: "avalon",
      issueNumber: 149,
      title: "Updated title",
    })).toBeNull();

    const install = await adapter.beginAuthorization!({
      state: "s".repeat(32),
      codeChallenge: "c".repeat(43),
      connectionScope: "workspace",
    });
    expect(new URL(install.url).pathname).toBe("/apps/avalon/installations/new");
    expect(install.state).toEqual({ connectionScope: "workspace" });

    const authorize = await adapter.beginAuthorization!({
      state: "s".repeat(32),
      codeChallenge: "c".repeat(43),
      scopes: ["read:user"],
      installationId: "42",
      connectionScope: "personal",
    });
    const authorizeUrl = new URL(authorize.url);
    expect(authorizeUrl.pathname).toBe("/login/oauth/authorize");
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.state).toEqual({ installationId: "42", connectionScope: "personal" });
  });

  it("creates and cryptographically verifies an RS256 app JWT, then mints an installation token", async () => {
    const keys = await rsaKeyMaterial();
    const jwt = await createGitHubAppJwt({ clientId: "Iv1.client-id", privateKey: keys.privateKeyPem, now: FIXED_NOW });
    const [encodedHeader, encodedClaims, encodedSignature] = jwt.split(".");
    expect(JSON.parse(decodeBase64Url(encodedHeader!))).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(decodeBase64Url(encodedClaims!))).toMatchObject({
      iss: "Iv1.client-id",
      iat: FIXED_NOW / 1_000 - 60,
      exp: FIXED_NOW / 1_000 + 540,
    });
    await expect(crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      keys.publicKey,
      decodeBase64UrlBytes(encodedSignature!).buffer as ArrayBuffer,
      new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`),
    )).resolves.toBe(true);

    let bearer = "";
    const fetcher: FetchLike = async (input, init) => {
      const url = requestUrl(input);
      expect(url.pathname).toBe("/app/installations/42/access_tokens");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("user-agent")).toBe("Rally-GitHub-Connector");
      bearer = new Headers(init?.headers).get("authorization") ?? "";
      return jsonResponse({
        token: "installation-access",
        expires_at: "2026-09-01T00:00:00.000Z",
        permissions: { contents: "read", issues: "write" },
      });
    };
    await expect(mintGitHubInstallationToken(githubConfig(fetcher, keys.privateKeyPem), 42)).resolves.toMatchObject({
      accessToken: "installation-access",
      tokenKind: "installation",
      permissions: { contents: "read", issues: "write" },
    });
    expect(bearer.split(".")).toHaveLength(3);
    expect(bearer.startsWith("Bearer ")).toBe(true);
  });

  it("correlates a personal user token to the selected installation", async () => {
    const keys = await rsaKeyMaterial();
    const fetcher: FetchLike = async (input, init) => {
      const url = requestUrl(input);
      if (url.pathname === "/login/oauth/access_token") {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("code_verifier")).toBe("v".repeat(43));
        return jsonResponse({
          access_token: "user-access",
          refresh_token: "user-refresh",
          expires_in: 3600,
          refresh_token_expires_in: 7200,
        });
      }
      if (url.pathname === "/user/installations") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer user-access");
        expect(url.searchParams.get("per_page")).toBe("100");
        expect(url.searchParams.get("page")).toBe("1");
        return jsonResponse({
          total_count: 1,
          installations: [{ id: 42, account: { login: "acme" }, repository_selection: "selected" }],
        });
      }
      if (url.pathname === "/app/installations/42") {
        expect(new Headers(init?.headers).get("authorization")?.split(".")).toHaveLength(3);
        return jsonResponse({ id: 42, account: { login: "acme" }, repository_selection: "selected" });
      }
      if (url.pathname === "/user") return jsonResponse({ id: 7, login: "ada", name: "Ada" });
      throw new Error(`Unexpected GitHub URL: ${url}`);
    };
    const adapter = createGitHubConnector(githubConfig(fetcher, keys.privateKeyPem));
    await expect(adapter.handleAuthorizationCallback!({
      code: "oauth-code",
      codeVerifier: "v".repeat(43),
      installationId: "42",
      connectionScope: "personal",
    })).resolves.toMatchObject({
      accessToken: "user-access",
      refreshToken: "user-refresh",
      tokenKind: "user",
      installationId: "42",
      githubUserId: "7",
      providerAccountId: "42",
      providerAccountName: "acme",
    });
  });

  it("rejects a user token that cannot access the selected installation", async () => {
    const keys = await rsaKeyMaterial();
    const fetcher: FetchLike = async (input) => {
      const url = requestUrl(input);
      if (url.pathname === "/login/oauth/access_token") {
        return jsonResponse({ access_token: "user-access" });
      }
      if (url.pathname === "/user/installations") {
        return jsonResponse({
          total_count: 1,
          installations: [{ id: 7, account: { login: "other" } }],
        });
      }
      throw new Error(`Unexpected GitHub URL: ${url}`);
    };
    const adapter = createGitHubConnector(githubConfig(fetcher, keys.privateKeyPem));

    await expect(adapter.handleAuthorizationCallback!({
      code: "oauth-code",
      codeVerifier: "v".repeat(43),
      installationId: "42",
      connectionScope: "workspace",
    })).rejects.toMatchObject({
      code: "unauthorized",
      message: "The authorizing GitHub user cannot access this installation",
    });
  });

  it("enforces execution principal and capability grants, and bounds file and patch text", async () => {
    const longText = "x".repeat(45_000);
    const longPatch = "+line\n".repeat(3_000);
    const fetcher: FetchLike = async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/contents/README.md")) {
        return jsonResponse({
          type: "file", name: "README.md", path: "README.md", sha: "abc", size: longText.length,
          encoding: "base64", content: toBase64(longText), html_url: "https://github.test/acme/widget/blob/main/README.md",
        });
      }
      if (url.pathname.endsWith("/pulls/5/files")) {
        return jsonResponse([{ filename: "src/index.ts", status: "modified", patch: longPatch }]);
      }
      throw new Error(`Unexpected GitHub URL: ${url}`);
    };
    const adapter = githubAdapter(fetcher);
    const connection = personalConnection([GitHubCapabilities.contentsRead, GitHubCapabilities.pullRequestsRead]);
    const context = {
      connection,
      principal: { type: "user" as const, userId: asUserId("d6d77053-92bc-4af6-8332-8bea8c4c6904") },
      signal: neverAborts(),
    };
    const content = await adapter.executeTool("contents.get", { owner: "acme", repo: "widget", path: "README.md" }, context);
    expect(content.output).toMatchObject({ content: "x".repeat(40_000), truncated: true, totalChars: 45_000 });
    const files = await adapter.executeTool("pull_requests.list_files", { owner: "acme", repo: "widget", pullNumber: 5 }, context);
    const patch = (files.output as { files: { patch: string }[] }).files[0]?.patch;
    // The marker is spent from the budget, not added to it: a bound that
    // reports 12,000 and delivers more is not a bound.
    expect(patch).toHaveLength(12_000);
    expect(patch).toMatch(/\[truncated: \d+ characters exceeds the 12000-character limit\]$/u);

    await expect(adapter.executeTool("issues.get", { owner: "acme", repo: "widget", issueNumber: 1 }, context))
      .rejects.toMatchObject({ code: "unsupported_capability" });
    await expect(adapter.executeTool("contents.get", { owner: "acme", repo: "widget", path: "README.md" }, {
      ...context,
      principal: { type: "user", userId: asUserId("3d58ce20-fe80-4793-80b2-21905baa60b3") },
    })).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("lists and searches authorized repositories with complete paging metadata and stable priority", async () => {
    const repositories = [
      {
        id: 1,
        name: "quiet",
        full_name: "acme/quiet",
        pushed_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-02T00:00:00.000Z",
      },
      {
        id: 2,
        name: "web-api",
        full_name: "acme/web-api",
        pushed_at: "2026-08-12T12:00:00.000Z",
      },
      {
        id: 3,
        name: "admin-api",
        full_name: "acme/admin-api",
        updated_at: "2026-08-10T12:00:00.000Z",
      },
      {
        id: 4,
        name: "archive",
        full_name: "acme/archive",
        pushed_at: "2025-01-01T00:00:00.000Z",
      },
    ];
    const fetcher: FetchLike = async (input, init) => {
      const url = requestUrl(input);
      if (url.pathname === "/graphql") {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toMatchObject({ variables: { login: "acme" } });
        return jsonResponse({
          data: {
            repositoryOwner: {
              pinnedItems: { nodes: [{ nameWithOwner: "acme/quiet" }] },
            },
          },
        });
      }
      expect(url.pathname).toBe("/user/installations/42/repositories");
      expect(url.searchParams.get("per_page")).toBe("100");
      expect(url.searchParams.get("page")).toBe("1");
      return jsonResponse({ total_count: repositories.length, repositories });
    };
    const adapter = githubAdapter(fetcher);
    const connection = personalConnection([GitHubCapabilities.metadataRead]);
    connection.config.account = { login: "acme", type: "Organization" };
    const context = {
      connection,
      principal: { type: "user" as const, userId: asUserId("d6d77053-92bc-4af6-8332-8bea8c4c6904") },
      signal: neverAborts(),
    };

    const listed = await adapter.executeTool("repositories.list", { page: 1, perPage: 2 }, context);
    expect(listed.output).toMatchObject({
      totalCount: 4,
      page: 1,
      perPage: 2,
      hasMore: true,
      truncated: false,
      sort: "pinned_then_recent_activity",
      pinnedSortAvailable: true,
      repositories: [
        { full_name: "acme/quiet", pinned: true },
        { full_name: "acme/web-api", pinned: false },
      ],
    });

    const searched = await adapter.executeTool("repositories.search", { query: "API", page: 1, perPage: 10 }, context);
    expect(searched.output).toMatchObject({
      query: "API",
      accessibleTotalCount: 4,
      totalCount: 2,
      totalCountIsExact: true,
      page: 1,
      perPage: 10,
      hasMore: false,
      repositories: [
        { full_name: "acme/web-api" },
        { full_name: "acme/admin-api" },
      ],
    });
  });

  it("does not advertise an unreachable repository page after the scan limit", async () => {
    const fetcher: FetchLike = async (input) => {
      const url = requestUrl(input);
      expect(url.pathname).toBe("/user/installations/42/repositories");
      const page = Number(url.searchParams.get("page"));
      return jsonResponse({
        total_count: 1_001,
        repositories: Array.from({ length: 100 }, (_, index) => ({
          id: (page - 1) * 100 + index + 1,
          name: `repo-${(page - 1) * 100 + index + 1}`,
          full_name: `acme/repo-${(page - 1) * 100 + index + 1}`,
        })),
      });
    };
    const adapter = githubAdapter(fetcher);
    const context = {
      connection: personalConnection([GitHubCapabilities.metadataRead]),
      principal: { type: "user" as const, userId: asUserId("d6d77053-92bc-4af6-8332-8bea8c4c6904") },
      signal: neverAborts(),
    };

    const beyondScan = await adapter.executeTool("repositories.list", {
      page: 11,
      perPage: 100,
    }, context);
    expect(beyondScan.output).toMatchObject({
      repositories: [],
      totalCount: 1_001,
      totalCountIsExact: true,
      page: 11,
      perPage: 100,
      hasMore: false,
      truncated: true,
    });
  });

  it("lists bounded directories and recursive trees before reading code", async () => {
    const fetcher: FetchLike = async (input) => {
      const url = requestUrl(input);
      if (url.pathname === "/repos/acme/widget/contents/src") {
        return jsonResponse([
          { type: "file", name: "a.ts", path: "src/a.ts", sha: "a", size: 10 },
          { type: "file", name: "b.ts", path: "src/b.ts", sha: "b", size: 20 },
          { type: "dir", name: "nested", path: "src/nested", sha: "c", size: 0 },
        ]);
      }
      if (url.pathname === "/repos/acme/widget") {
        return jsonResponse({ default_branch: "main" });
      }
      if (url.pathname === "/repos/acme/widget/git/trees/main") {
        expect(url.searchParams.has("recursive")).toBe(false);
        return jsonResponse({
          sha: "root-sha",
          tree: [{ type: "tree", path: "src", sha: "src-sha" }],
        });
      }
      if (url.pathname === "/repos/acme/widget/git/trees/src-sha") {
        expect(url.searchParams.get("recursive")).toBe("1");
        return jsonResponse({
          sha: "tree-sha",
          truncated: false,
          tree: [
            { type: "blob", path: "a.ts", sha: "a", size: 10 },
            { type: "blob", path: "nested/c.ts", sha: "c", size: 30 },
          ],
        });
      }
      throw new Error(`Unexpected GitHub URL: ${url}`);
    };
    const adapter = githubAdapter(fetcher);
    const context = {
      connection: personalConnection([GitHubCapabilities.contentsRead]),
      principal: { type: "user" as const, userId: asUserId("d6d77053-92bc-4af6-8332-8bea8c4c6904") },
      signal: neverAborts(),
    };

    const directory = await adapter.executeTool("contents.list", {
      owner: "acme", repo: "widget", path: "/src/", offset: 1, limit: 1,
    }, context);
    expect(directory.output).toMatchObject({
      mode: "directory",
      path: "src",
      totalCount: 3,
      offset: 1,
      limit: 1,
      hasMore: true,
      entries: [{ path: "src/b.ts" }],
    });

    const tree = await adapter.executeTool("contents.list", {
      owner: "acme", repo: "widget", path: "src", recursive: true, offset: 0, limit: 2,
    }, context);
    expect(tree.output).toMatchObject({
      mode: "tree",
      path: "src",
      ref: "main",
      sha: "tree-sha",
      totalCount: 3,
      totalCountIsExact: true,
      hasMore: true,
      truncated: false,
      entries: [{ path: "src" }, { path: "src/a.ts" }],
    });
  });

  it("separates provider truncation from locally pageable directory and tree entries", async () => {
    const directoryEntries = Array.from({ length: 1_000 }, (_, index) => ({
      type: "file",
      name: `file-${index}.ts`,
      path: `src/file-${index}.ts`,
      sha: `sha-${index}`,
      size: index,
    }));
    const fetcher: FetchLike = async (input) => {
      const url = requestUrl(input);
      if (url.pathname === "/repos/acme/widget/contents/src") {
        return jsonResponse(directoryEntries);
      }
      if (url.pathname === "/repos/acme/widget/git/trees/main") {
        expect(url.searchParams.get("recursive")).toBe("1");
        return jsonResponse({
          sha: "tree-sha",
          truncated: true,
          tree: [{ type: "blob", path: "visible.ts", sha: "visible", size: 10 }],
        });
      }
      throw new Error(`Unexpected GitHub URL: ${url}`);
    };
    const adapter = githubAdapter(fetcher);
    const context = {
      connection: personalConnection([GitHubCapabilities.contentsRead]),
      principal: { type: "user" as const, userId: asUserId("d6d77053-92bc-4af6-8332-8bea8c4c6904") },
      signal: neverAborts(),
    };

    const directory = await adapter.executeTool("contents.list", {
      owner: "acme", repo: "widget", path: "src", offset: 999, limit: 1,
    }, context);
    expect(directory.output).toMatchObject({
      totalCount: 1_000,
      totalCountIsExact: false,
      offset: 999,
      hasMore: false,
      truncated: true,
      entries: [{ path: "src/file-999.ts" }],
    });

    const tree = await adapter.executeTool("contents.list", {
      owner: "acme", repo: "widget", ref: "main", recursive: true, offset: 1, limit: 1,
    }, context);
    expect(tree.output).toMatchObject({
      totalCount: 1,
      totalCountIsExact: false,
      offset: 1,
      hasMore: false,
      truncated: true,
      entries: [],
    });
  });

  it("rotates a personal token and retries exactly once after a 401", async () => {
    const authorizations: string[] = [];
    let refreshes = 0;
    const fetcher: FetchLike = async (input, init) => {
      const url = requestUrl(input);
      if (url.pathname === "/login/oauth/access_token") {
        refreshes += 1;
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("old-refresh");
        return jsonResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
      }
      if (url.pathname === "/user/installations/42/repositories") {
        const authorization = new Headers(init?.headers).get("authorization") ?? "";
        authorizations.push(authorization);
        if (authorization === "Bearer old-access") return jsonResponse({ message: "Bad credentials" }, 401);
        return jsonResponse({ repositories: [{ id: 1, full_name: "acme/widget" }] });
      }
      throw new Error(`Unexpected GitHub URL: ${url}`);
    };
    const adapter = githubAdapter(fetcher);
    const connection = personalConnection([GitHubCapabilities.metadataRead]);
    const result = await adapter.executeTool("repositories.list", {}, {
      connection,
      principal: { type: "user", userId: asUserId("d6d77053-92bc-4af6-8332-8bea8c4c6904") },
      signal: neverAborts(),
    });
    expect(result.output).toMatchObject({ repositories: [{ full_name: "acme/widget" }] });
    expect(refreshes).toBe(1);
    expect(authorizations).toEqual(["Bearer old-access", "Bearer new-access"]);
    expect(connection.credentials).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh" });
  });

  it("verifies exact webhook bytes and normalizes installation-scoped events", async () => {
    await expect(verifyGitHubWebhookSignature(
      "It's a Secret to Everybody",
      "Hello, World!",
      "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
    )).resolves.toBeUndefined();

    const secret = "github-webhook-secret";
    const rawBody = JSON.stringify({
      action: "opened",
      installation: { id: 42 },
      repository: { id: 1, full_name: "acme/widget", html_url: "https://github.com/acme/widget" },
      sender: { id: 7, login: "ada" },
      issue: {
        id: 99,
        node_id: "I_99",
        number: 12,
        title: "Ship connectors",
        body: "Wire GitHub activity into Avalon",
        updated_at: "2026-08-01T12:00:00.000Z",
        html_url: "https://github.com/acme/widget/issues/12",
      },
    });
    const delivery = await verifyGitHubWebhook({
      secret,
      rawBody,
      signatureHeader: `sha256=${await hmacHex(secret, rawBody)}`,
      eventHeader: "issues",
      deliveryHeader: "11111111-1111-4111-8111-111111111111",
      receivedAt: "2026-08-01T12:00:01.000Z",
    });
    const connection = workspaceConnection([]);
    const activity = normalizeGitHubWebhook(connection, delivery, "r2://payload/github");
    expect(activity).toMatchObject({
      provider: "github",
      eventType: "github.issue.opened",
      resourceType: "github_issue",
      providerResourceId: "acme/widget#12",
      dedupeKey: "github:11111111-1111-4111-8111-111111111111",
      payloadRef: "r2://payload/github",
    });
    expect(() => NormalizedActivitySchema.parse({ id: "00000000-0000-4000-8000-000000000003", ...activity })).not.toThrow();

    const wrongConnection = workspaceConnection([]);
    wrongConnection.credentials.installationId = "43";
    expect(() => normalizeGitHubWebhook(wrongConnection, delivery)).toThrow(/installation/i);
    await expect(verifyGitHubWebhook({
      secret,
      rawBody,
      signatureHeader: `sha256=${"0".repeat(64)}`,
      eventHeader: "issues",
      deliveryHeader: "11111111-1111-4111-8111-111111111111",
    })).rejects.toMatchObject({ code: "invalid_signature" });
    await expect(verifyGitHubWebhookSignature(secret, rawBody, await hmacHex(secret, rawBody)))
      .rejects.toMatchObject({ code: "invalid_signature" });

    expect(normalizeGitHubWebhook(connection, { ...delivery, event: "installation" })).toBeNull();
  });

  it("treats issue comments on pull requests as pull-request activity and resources", () => {
    const delivery = {
      event: "issue_comment",
      action: "created",
      deliveryId: "github-pr-comment-1",
      installationId: "42",
      payload: {
        installation: { id: 42 },
        repository: {
          id: 1,
          name: "widget",
          full_name: "acme/widget",
          html_url: "https://github.com/acme/widget",
          owner: { login: "acme" },
        },
        sender: { id: 7, login: "ada" },
        issue: {
          id: 5,
          number: 12,
          title: "Ship it",
          html_url: "https://github.com/acme/widget/pull/12",
          pull_request: { url: "https://api.github.com/repos/acme/widget/pulls/12" },
        },
        comment: {
          id: 88,
          body: "Looks good",
          html_url: "https://github.com/acme/widget/pull/12#issuecomment-88",
        },
      },
      rawContentHash: "a".repeat(64),
      receivedAt: "2026-08-01T12:00:01.000Z",
    };
    const activity = normalizeGitHubWebhook(workspaceConnection([]), delivery);
    expect(activity).toMatchObject({
      eventType: "github.pull_request_comment.created",
      resourceType: "github_pull_request",
      providerResourceId: "acme/widget#12",
    });
    const discovery = discoverGitHubWebhookResources(delivery);
    expect(discovery.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ resourceType: "github_repository", providerResourceId: "acme/widget" }),
      expect.objectContaining({ resourceType: "github_pull_request", providerResourceId: "acme/widget#12" }),
      expect.objectContaining({ resourceType: "github_pull_request_comment", providerResourceId: "acme/widget#12/comments/88" }),
    ]));
  });

  it("normalizes merged pull requests as a distinct filterable activity", () => {
    const basePayload = {
      installation: { id: 42 },
      repository: {
        id: 1,
        name: "widget",
        full_name: "acme/widget",
        html_url: "https://github.com/acme/widget",
        owner: { login: "acme" },
      },
      sender: { id: 7, login: "grace" },
      number: 12,
    };
    const pullRequest = {
      id: 55,
      number: 12,
      title: "Ship activity triggers",
      html_url: "https://github.com/acme/widget/pull/12",
      updated_at: "2026-08-01T12:00:00.000Z",
      merged_at: "2026-08-01T11:59:00.000Z",
      merged: true,
      base: { ref: "main" },
      head: { ref: "activity-triggers" },
      user: { login: "ada" },
      merged_by: { login: "grace" },
    };
    const merged = normalizeGitHubWebhook(workspaceConnection([]), {
      event: "pull_request",
      action: "closed",
      deliveryId: "github-pr-merged-1",
      installationId: "42",
      payload: { ...basePayload, pull_request: pullRequest },
      rawContentHash: "c".repeat(64),
      receivedAt: "2026-08-01T12:00:01.000Z",
    });
    expect(merged).toMatchObject({
      eventType: "github.pull_request.merged",
      occurredAt: "2026-08-01T11:59:00.000Z",
      metadata: {
        repository: "acme/widget",
        pullRequestNumber: 12,
        baseRef: "main",
        headRef: "activity-triggers",
        authorLogin: "ada",
        mergerLogin: "grace",
        merged: true,
        mergedAt: "2026-08-01T11:59:00.000Z",
      },
    });
    const closed = normalizeGitHubWebhook(workspaceConnection([]), {
      event: "pull_request",
      action: "closed",
      deliveryId: "github-pr-closed-1",
      installationId: "42",
      payload: { ...basePayload, pull_request: { ...pullRequest, merged: false, merged_at: null, merged_by: null } },
      rawContentHash: "d".repeat(64),
      receivedAt: "2026-08-01T12:00:01.000Z",
    });
    expect(closed?.eventType).toBe("github.pull_request.closed");

    const laterLabel = normalizeGitHubWebhook(workspaceConnection([]), {
      event: "pull_request",
      action: "labeled",
      deliveryId: "github-pr-labeled-after-merge-1",
      installationId: "42",
      payload: {
        ...basePayload,
        pull_request: { ...pullRequest, updated_at: "2026-08-02T09:30:00.000Z" },
      },
      rawContentHash: "e".repeat(64),
      receivedAt: "2026-08-02T09:30:01.000Z",
    });
    expect(laterLabel).toMatchObject({
      eventType: "github.pull_request.labeled",
      occurredAt: "2026-08-02T09:30:00.000Z",
    });

    const adapter = githubAdapter(async () => jsonResponse({}));
    expect(adapter.manifest.activityTriggers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "github.pull_request.merged",
        filterFields: expect.arrayContaining([
          expect.objectContaining({ key: "repository", valueType: "string" }),
          expect.objectContaining({ key: "baseRef", valueType: "string" }),
        ]),
      }),
      expect.objectContaining({
        eventType: "github.issue.opened",
        filterFields: expect.arrayContaining([
          expect.objectContaining({ key: "repository", valueType: "string" }),
        ]),
      }),
    ]));
  });

  it("bounds push resource discovery independently from compact activity entity keys", () => {
    const commits = Array.from({ length: GitHubWebhookResourceLimits.pushCommits + 1 }, (_, index) => {
      const sha = (index + 1).toString(16).padStart(40, "0");
      return {
        id: sha,
        message: `Commit ${index}`,
        added: [`src/${index}-a.ts`, `src/${index}-b.ts`, `src/${index}-c.ts`],
        modified: [],
        removed: [],
      };
    });
    const delivery = {
      event: "push",
      action: null,
      deliveryId: "github-push-bounded-1",
      installationId: "42",
      payload: {
        installation: { id: 42 },
        ref: "refs/heads/main",
        after: commits[0]!.id,
        head_commit: commits[0],
        commits,
        repository: {
          id: 1,
          name: "widget",
          full_name: "acme/widget",
          html_url: "https://github.com/acme/widget",
          owner: { login: "acme" },
        },
        sender: { id: 7, login: "ada" },
      },
      rawContentHash: "b".repeat(64),
      receivedAt: "2026-08-01T12:00:01.000Z",
    };
    const discovery = discoverGitHubWebhookResources(delivery);
    expect(discovery.truncated).toBe(true);
    expect(discovery.resources.filter((resource) => resource.resourceType === "github_commit"))
      .toHaveLength(GitHubWebhookResourceLimits.pushCommits);
    expect(discovery.resources.filter((resource) => resource.resourceType === "github_file"))
      .toHaveLength(GitHubWebhookResourceLimits.pushFiles);
    expect(normalizeGitHubWebhook(workspaceConnection([]), delivery)?.entityKeys).toHaveLength(128);
  });

  it("normalizes releases as one hydratable resource for every documented action", () => {
    const adapter = githubAdapter(async () => jsonResponse({}));
    const actions = ["created", "deleted", "edited", "prereleased", "published", "released", "unpublished"];
    expect(adapter.manifest.resourceTypes).toContain("github_release");
    expect(adapter.manifest.activityTriggers.map((trigger) => trigger.eventType)).toEqual(expect.arrayContaining(
      actions.map((action) => `github.release.${action}`),
    ));
    for (const action of actions) {
      const delivery = githubRelationshipDelivery("release", action, {
        release: {
          id: 901,
          node_id: "RE_901",
          name: "Avalon 1.0",
          tag_name: "v1.0.0",
          body: "First public release",
          target_commitish: "main",
          draft: false,
          prerelease: action === "prereleased",
          published_at: "2026-08-01T12:00:00.000Z",
          html_url: "https://github.com/acme/widget/releases/tag/v1.0.0",
        },
      });
      expect(normalizeGitHubWebhook(workspaceConnection([]), delivery)).toMatchObject({
        eventType: `github.release.${action}`,
        resourceType: "github_release",
        providerResourceId: "acme/widget/releases/901",
        occurredAt: "2026-08-01T12:00:00.000Z",
      });
      expect(discoverGitHubWebhookResources(delivery).resources).toEqual(expect.arrayContaining([
        expect.objectContaining({ resourceType: "github_repository", providerResourceId: "acme/widget" }),
        expect.objectContaining({
          resourceType: "github_release",
          providerResourceId: "acme/widget/releases/901",
          metadata: expect.objectContaining({ releaseId: 901, tagName: "v1.0.0" }),
        }),
      ]));
    }
  });

  it("discovers both sides of issue dependency events, including cross-repository issues", () => {
    const actions = ["blocked_by_added", "blocked_by_removed", "blocking_added", "blocking_removed"];
    for (const action of actions) {
      const delivery = githubRelationshipDelivery("issue_dependencies", action, {
        blocked_issue_id: 101,
        blocked_issue: {
          id: 101,
          number: 12,
          title: "Ship Avalon",
          repository_url: "https://api.github.com/repos/acme/widget",
          html_url: "https://github.com/acme/widget/issues/12",
        },
        blocking_issue_id: 202,
        blocking_issue: {
          id: 202,
          number: 7,
          title: "Complete security review",
          repository_url: "https://api.github.com/repos/acme/security",
          html_url: "https://github.com/acme/security/issues/7",
        },
        blocking_issue_repo: githubRepository("acme/security", 2),
      });
      expect(normalizeGitHubWebhook(workspaceConnection([]), delivery)).toMatchObject({
        eventType: `github.issue_dependencies.${action}`,
        resourceType: "github_issue",
        providerResourceId: "acme/widget#12",
      });
      const discovery = discoverGitHubWebhookResources(delivery);
      expect(discovery.truncated).toBe(false);
      expect(discovery.resources).toEqual(expect.arrayContaining([
        expect.objectContaining({ resourceType: "github_repository", providerResourceId: "acme/widget" }),
        expect.objectContaining({ resourceType: "github_repository", providerResourceId: "acme/security" }),
        expect.objectContaining({ resourceType: "github_issue", providerResourceId: "acme/widget#12" }),
        expect.objectContaining({ resourceType: "github_issue", providerResourceId: "acme/security#7" }),
      ]));
      expect(discovery.resources).toHaveLength(4);
    }
  });

  it("discovers parent and child issues for every sub-issue relationship action", () => {
    const actions = ["parent_issue_added", "parent_issue_removed", "sub_issue_added", "sub_issue_removed"];
    for (const action of actions) {
      const delivery = githubRelationshipDelivery("sub_issues", action, {
        parent_issue_id: 301,
        parent_issue: {
          id: 301,
          number: 30,
          title: "Launch Avalon",
          repository_url: "https://api.github.com/repos/acme/roadmap",
          html_url: "https://github.com/acme/roadmap/issues/30",
        },
        parent_issue_repo: githubRepository("acme/roadmap", 3),
        sub_issue_id: 101,
        sub_issue: {
          id: 101,
          number: 12,
          title: "Ship connector",
          repository_url: "https://api.github.com/repos/acme/widget",
          html_url: "https://github.com/acme/widget/issues/12",
        },
      });
      expect(normalizeGitHubWebhook(workspaceConnection([]), delivery)).toMatchObject({
        eventType: `github.sub_issues.${action}`,
        resourceType: "github_issue",
        providerResourceId: "acme/widget#12",
      });
      const discovery = discoverGitHubWebhookResources(delivery);
      expect(discovery.truncated).toBe(false);
      expect(discovery.resources).toEqual(expect.arrayContaining([
        expect.objectContaining({ resourceType: "github_repository", providerResourceId: "acme/roadmap" }),
        expect.objectContaining({ resourceType: "github_issue", providerResourceId: "acme/roadmap#30" }),
        expect.objectContaining({ resourceType: "github_issue", providerResourceId: "acme/widget#12" }),
      ]));
      expect(discovery.resources).toHaveLength(4);
    }
  });

  it("bootstraps only repositories selected for the App installation", async () => {
    const paths: string[] = [];
    const fetcher: FetchLike = async (input) => {
      const url = requestUrl(input);
      paths.push(`${url.pathname}${url.search}`);
      return jsonResponse({
        total_count: 2,
        repositories: [
          { id: 1, name: "one", full_name: "acme/one", html_url: "https://github.com/acme/one", owner: { login: "acme" } },
          { id: 2, name: "two", full_name: "acme/two", html_url: "https://github.com/acme/two", owner: { login: "acme" } },
        ],
      });
    };
    const config = githubConfig(fetcher);
    await expect(discoverGitHubConnectionRepositories(config, workspaceConnection([])))
      .resolves.toMatchObject({
        truncated: false,
        resources: [
          expect.objectContaining({ providerResourceId: "acme/one", metadata: expect.objectContaining({ selected: true }) }),
          expect.objectContaining({ providerResourceId: "acme/two", metadata: expect.objectContaining({ selected: true }) }),
        ],
      });
    await discoverGitHubConnectionRepositories(config, personalConnection([]));
    expect(paths[0]).toBe("/installation/repositories?per_page=100&page=1");
    expect(paths[1]).toBe("/user/installations/42/repositories?per_page=100&page=1");
    expect(paths.some((path) => path.startsWith("/user/repos"))).toBe(false);
  });

  it("hydrates resources, reports personal health, and revokes without broadening access", async () => {
    const calls: Array<{ path: string; method: string; authorization: string | null }> = [];
    const fetcher: FetchLike = async (input, init) => {
      const url = requestUrl(input);
      calls.push({
        path: url.pathname,
        method: init?.method ?? "GET",
        authorization: new Headers(init?.headers).get("authorization"),
      });
      if (url.pathname === "/repos/acme/widget") return jsonResponse({ id: 1, full_name: "acme/widget", private: true });
      if (url.pathname === "/repos/acme/widget/releases/901") return jsonResponse({ id: 901, tag_name: "v1.0.0" });
      if (url.pathname.startsWith("/repos/acme/widget/issues/comments/")) return jsonResponse({ id: 31, kind: "issue-comment" });
      if (url.pathname.startsWith("/repos/acme/widget/pulls/5/reviews/")) return jsonResponse({ id: 32, kind: "review" });
      if (url.pathname.startsWith("/repos/acme/widget/pulls/comments/")) return jsonResponse({ id: 33, kind: "review-comment" });
      if (url.pathname.startsWith("/repos/acme/widget/check-runs/")) return jsonResponse({ id: 34, kind: "check-run" });
      if (url.pathname === "/user") return jsonResponse({ id: 7, login: "ada" });
      if (url.pathname === "/applications/github-client/token") return emptyResponse(204);
      throw new Error(`Unexpected GitHub URL: ${url}`);
    };
    const adapter = githubAdapter(fetcher);
    const connection = personalConnection([
      GitHubCapabilities.metadataRead,
      GitHubCapabilities.pullRequestsRead,
      GitHubCapabilities.checksRead,
    ]);
    await expect(canGitHubPersonalConnectionAccessRepository(githubConfig(fetcher), connection, "acme/widget"))
      .resolves.toBe(true);
    await expect(adapter.hydrateResource!(connection, {
      resource_type: "github_repository",
      provider_resource_id: "acme/widget",
    }, neverAborts())).resolves.toMatchObject({ full_name: "acme/widget", private: true });
    await expect(adapter.hydrateResource!(connection, {
      resource_type: "github_release",
      provider_resource_id: "acme/widget/releases/901",
      metadata: { owner: "acme", repo: "widget", releaseId: 901 },
    }, neverAborts())).resolves.toMatchObject({ id: 901, tag_name: "v1.0.0" });
    await expect(adapter.hydrateResource!(connection, {
      resource_type: "github_pull_request_comment",
      provider_resource_id: "acme/widget#5/comments/31",
      metadata: { owner: "acme", repo: "widget", pullNumber: 5, commentId: "31" },
    }, neverAborts())).resolves.toMatchObject({ kind: "issue-comment" });
    await expect(adapter.hydrateResource!(connection, {
      resource_type: "github_pull_request_review",
      provider_resource_id: "acme/widget#5/reviews/32",
      metadata: { owner: "acme", repo: "widget", pullNumber: 5, reviewId: "32" },
    }, neverAborts())).resolves.toMatchObject({ kind: "review" });
    await expect(adapter.hydrateResource!(connection, {
      resource_type: "github_pull_request_review_comment",
      provider_resource_id: "acme/widget#5/review-comments/33",
      metadata: { owner: "acme", repo: "widget", pullNumber: 5, commentId: "33" },
    }, neverAborts())).resolves.toMatchObject({ kind: "review-comment" });
    await expect(adapter.hydrateResource!(connection, {
      resource_type: "github_check_run",
      provider_resource_id: "acme/widget/check-runs/34",
      metadata: { owner: "acme", repo: "widget", checkRunId: "34" },
    }, neverAborts())).resolves.toMatchObject({ kind: "check-run" });
    await expect(adapter.healthCheck(connection)).resolves.toEqual({ ok: true, message: "GitHub user authorization is healthy" });
    await adapter.revoke!(connection, neverAborts());
    expect(calls.at(-1)).toMatchObject({ path: "/applications/github-client/token", method: "DELETE" });
    expect(calls.at(-1)?.authorization?.startsWith("Basic ")).toBe(true);
  });

  it("lists pull requests without inventing a filter, and pages without dropping one", async () => {
    // The failure this covers reached production as a correct-looking answer: a
    // repository with twenty-five open pull requests reported as having none,
    // because the call carried a `head` GitHub matched nothing against and
    // answered with HTTP 200 and `[]`. Three things are asserted, because each
    // one alone still loses part of the answer — the filters are sent only when
    // the caller asked for them, the page says which ones were applied so an
    // empty one can be read for what it is, and paging returns every item.
    const pullRequests = Array.from({ length: 31 }, (_, index) => ({
      number: index + 1,
      title: `PR ${index + 1}`,
      state: "open",
      head: { ref: `feature-${index + 1}` },
      base: { ref: "main" },
    }));
    const seen: URL[] = [];
    // Paginated the way GitHub paginates: `page` is indexed in units of the
    // `per_page` actually sent. A stub that ignores those is what let an
    // off-by-one in the request slip through the first version of this test.
    const fetcher: FetchLike = async (input) => {
      const url = requestUrl(input);
      seen.push(url);
      if (url.pathname !== "/repos/acme/widget/pulls") return jsonResponse({ message: "Not Found" }, 404);
      if (url.searchParams.get("head")) return jsonResponse([]);
      const perPage = Number(url.searchParams.get("per_page") ?? 30);
      const page = Number(url.searchParams.get("page") ?? 1);
      return jsonResponse(pullRequests.slice((page - 1) * perPage, page * perPage));
    };
    const adapter = githubAdapter(fetcher);
    const context = {
      connection: personalConnection([GitHubCapabilities.pullRequestsRead]),
      principal: { type: "user" as const, userId: asUserId("d6d77053-92bc-4af6-8332-8bea8c4c6904") },
      signal: neverAborts(),
    };

    const listed = await adapter.executeTool("pull_requests.list", { owner: "acme", repo: "widget" }, context);

    // The defaults the executor supplies are its own business: a caller that
    // named no filter must produce a request that carries none, or the tool
    // cannot be used to answer "what is open on this repository".
    expect(seen[0]?.searchParams.get("head")).toBeNull();
    expect(seen[0]?.searchParams.get("base")).toBeNull();
    // The page asked for is the page shown. Asking for more than `perPage` to
    // peek at `hasMore` moves GitHub's own page boundaries, because `page`
    // counts in units of the `per_page` sent, and the peeked-at item is then
    // skipped rather than returned by the next page.
    expect(seen[0]?.searchParams.get("per_page")).toBe("30");
    expect(listed.output).toMatchObject({
      count: 30,
      page: 1,
      perPage: 30,
      hasMore: true,
      appliedFilters: { state: "open" },
    });
    expect(listed.summary).toBe("Listed 30 pull requests in acme/widget");

    const second = await adapter.executeTool("pull_requests.list", { owner: "acme", repo: "widget", page: 2 }, context);

    // The item on the boundary. A caller following `hasMore` has to receive it.
    expect((second.output as { pullRequests: { number: number }[] }).pullRequests.map((pull) => pull.number))
      .toEqual([31]);
    expect(second.output).toMatchObject({ count: 1, page: 2, hasMore: false });

    const filtered = await adapter.executeTool(
      "pull_requests.list",
      { owner: "acme", repo: "widget", head: "acme:feature-1" },
      context,
    );

    expect(seen[2]?.searchParams.get("head")).toBe("acme:feature-1");
    // The whole point of the envelope: an empty page that names the filter that
    // emptied it cannot be read as "this repository has no pull requests".
    expect(filtered.output).toMatchObject({
      pullRequests: [],
      count: 0,
      hasMore: false,
      appliedFilters: { state: "open", head: "acme:feature-1" },
    });
  });

  it("returns the declared pull-request row rather than the object GitHub sent", async () => {
    // The payload that made this necessary. A measured substream spent 5.1 MB
    // of 5.2 MB of model-facing bytes on five GitHub list calls, 735 KB of it
    // on thirty pull requests, because every row carried `head.repo` and
    // `base.repo` — two complete repository records — plus `_links` and the
    // thirty-odd URL templates below. No count-based bound in the adapter was
    // anywhere near its limit: `perPage` was 30 of 100, no string approached
    // 40,000 characters, no array 100 entries. The row was wide, not long.
    const repository = {
      id: 41,
      full_name: "acme/widget",
      forks_url: "https://api.github.com/repos/acme/widget/forks",
      branches_url: "https://api.github.com/repos/acme/widget/branches{/branch}",
      archive_url: "https://api.github.com/repos/acme/widget/{archive_format}{/ref}",
      owner: { login: "acme", id: 7, avatar_url: "https://avatars.github.com/u/7" },
    };
    const served = [{
      number: 670,
      title: "Bound the GitHub list rows",
      state: "open",
      draft: false,
      created_at: "2026-09-10T09:00:00Z",
      updated_at: "2026-09-12T11:30:00Z",
      closed_at: null,
      merged_at: null,
      user: { login: "octocat", id: 1, avatar_url: "https://avatars.github.com/u/1" },
      head: { ref: "feature", sha: "9fceb02", repo: repository, user: { login: "octocat" } },
      base: { ref: "main", sha: "abc1234", repo: repository },
      labels: [{ id: 2, name: "bug", color: "d73a4a", description: "Something is broken" }],
      assignees: [{ login: "octocat", id: 1, type: "User" }],
      requested_reviewers: [{ login: "hubot", id: 3, type: "User" }],
      html_url: "https://github.com/acme/widget/pull/670",
      body: "The body belongs to pull_requests.get.",
      _links: { self: { href: "https://api.github.com/repos/acme/widget/pulls/670" } },
      diff_url: "https://github.com/acme/widget/pull/670.diff",
      comments_url: "https://api.github.com/repos/acme/widget/issues/670/comments",
      milestone: null,
    }];
    const fetcher: FetchLike = async (input) => {
      expect(requestUrl(input).pathname).toBe("/repos/acme/widget/pulls");
      return jsonResponse(served);
    };
    const listed = await githubAdapter(fetcher).executeTool("pull_requests.list", {
      owner: "acme",
      repo: "widget",
    }, {
      connection: personalConnection([GitHubCapabilities.pullRequestsRead]),
      principal: { type: "user" as const, userId: asUserId("d6d77053-92bc-4af6-8332-8bea8c4c6904") },
      signal: neverAborts(),
    });

    // Exact rather than partial, in both directions at once: nothing GitHub
    // sent survives that was not declared, and nothing declared was dropped on
    // the way. A `toMatchObject` here would pass on a row that still carried
    // both repositories.
    expect((listed.output as { pullRequests: unknown[] }).pullRequests).toEqual([{
      number: 670,
      title: "Bound the GitHub list rows",
      state: "open",
      draft: false,
      created_at: "2026-09-10T09:00:00Z",
      updated_at: "2026-09-12T11:30:00Z",
      // Present and null, because "not merged" is the answer to the question a
      // reader of this list is asking, and an absent key is not that answer.
      closed_at: null,
      merged_at: null,
      user: { login: "octocat" },
      head: { ref: "feature", sha: "9fceb02" },
      base: { ref: "main" },
      labels: [{ name: "bug" }],
      assignees: [{ login: "octocat" }],
      requested_reviewers: [{ login: "hubot" }],
      html_url: "https://github.com/acme/widget/pull/670",
    }]);
  });

  it("keeps the identifiers the next call needs and drops the bulk beside them", async () => {
    // A projection that loses an id does not save bytes, it breaks the tool
    // that was documented to take it: `actions.get_workflow_run` tells the
    // model `runId` is "copied from the `id` field of an
    // actions_list_workflow_runs result".
    const repository = { id: 41, full_name: "acme/widget", archive_url: "https://api.github.com/x{/ref}" };
    const fetcher: FetchLike = async (input) => {
      const url = requestUrl(input);
      if (url.pathname === "/repos/acme/widget/actions/runs") {
        return jsonResponse({
          total_count: 1,
          workflow_runs: [{
            id: 9_912_345,
            name: "CI",
            display_title: "Bound the GitHub list rows",
            run_number: 412,
            run_attempt: 2,
            event: "pull_request",
            status: "completed",
            conclusion: "failure",
            head_branch: "feature",
            head_sha: "9fceb02",
            created_at: "2026-09-12T11:00:00Z",
            updated_at: "2026-09-12T11:20:00Z",
            run_started_at: "2026-09-12T11:01:00Z",
            html_url: "https://github.com/acme/widget/actions/runs/9912345",
            pull_requests: [{ number: 670, head: { ref: "feature", repo: repository } }],
            repository,
            head_repository: repository,
            head_commit: { id: "9fceb02", message: "Bound the rows", author: { name: "Octocat" } },
            logs_url: "https://api.github.com/repos/acme/widget/actions/runs/9912345/logs",
          }],
        });
      }
      if (url.pathname === "/repos/acme/widget/commits") {
        return jsonResponse([{
          sha: "9fceb02",
          commit: {
            message: "Bound the rows",
            author: { name: "Octocat", email: "octocat@example.test", date: "2026-09-12T10:00:00Z" },
            committer: { name: "GitHub", email: "noreply@github.com", date: "2026-09-12T10:00:00Z" },
            verification: {
              verified: true,
              reason: "valid",
              signature: "-----BEGIN PGP SIGNATURE-----\nnot small\n-----END PGP SIGNATURE-----",
              payload: "tree 1f2e3d\nparent 4c5b6a\nauthor Octocat <octocat@example.test>\n",
            },
          },
          author: { login: "octocat", id: 1, avatar_url: "https://avatars.github.com/u/1" },
          html_url: "https://github.com/acme/widget/commit/9fceb02",
          comments_url: "https://api.github.com/repos/acme/widget/commits/9fceb02/comments",
          parents: [{ sha: "4c5b6a", url: "https://api.github.com/repos/acme/widget/commits/4c5b6a" }],
        }]);
      }
      return jsonResponse({ message: "Not Found" }, 404);
    };
    const adapter = githubAdapter(fetcher);
    const context = {
      connection: personalConnection([GitHubCapabilities.actionsRead, GitHubCapabilities.contentsRead]),
      principal: { type: "user" as const, userId: asUserId("d6d77053-92bc-4af6-8332-8bea8c4c6904") },
      signal: neverAborts(),
    };

    const runs = await adapter.executeTool("actions.list_workflow_runs", { owner: "acme", repo: "widget" }, context);
    expect((runs.output as { workflowRuns: unknown[] }).workflowRuns).toEqual([{
      id: 9_912_345,
      name: "CI",
      display_title: "Bound the GitHub list rows",
      run_number: 412,
      run_attempt: 2,
      event: "pull_request",
      status: "completed",
      conclusion: "failure",
      head_branch: "feature",
      head_sha: "9fceb02",
      created_at: "2026-09-12T11:00:00Z",
      updated_at: "2026-09-12T11:20:00Z",
      run_started_at: "2026-09-12T11:01:00Z",
      pull_requests: [{ number: 670 }],
      html_url: "https://github.com/acme/widget/actions/runs/9912345",
    }]);

    const commits = await adapter.executeTool("commits.list", { owner: "acme", repo: "widget" }, context);
    // The signature and the payload beside it are most of a commit row on any
    // repository that signs, and the verdict is the only part of either that a
    // reader can act on.
    expect((commits.output as { commits: unknown[] }).commits).toEqual([{
      sha: "9fceb02",
      commit: {
        message: "Bound the rows",
        author: { name: "Octocat", date: "2026-09-12T10:00:00Z" },
        verification: { verified: true },
      },
      author: { login: "octocat" },
      html_url: "https://github.com/acme/widget/commit/9fceb02",
    }]);
  });

  it("keeps a failed check's diagnostics, which nothing else in this plugin can read", async () => {
    // The widest field on the check row is also the only one that says why a
    // check failed. This plugin has no check-run get, no annotations tool and no
    // job-log tool, and `details_url` is the reporting app's own page rather than
    // anything this connector can fetch — so dropping `output.text` would leave a
    // run able to report a failure and unable to explain it.
    const fetcher: FetchLike = async (input) => {
      expect(requestUrl(input).pathname).toBe("/repos/acme/widget/commits/main/check-runs");
      return jsonResponse({
        total_count: 1,
        check_runs: [{
          id: 77,
          name: "verify / lint",
          status: "completed",
          conclusion: "failure",
          started_at: "2026-09-12T11:00:00Z",
          completed_at: "2026-09-12T11:04:00Z",
          output: {
            title: "1 error",
            summary: "eslint found 1 error",
            text: "x".repeat(45_000),
            annotations_count: 1,
            annotations_url: "https://api.github.com/repos/acme/widget/check-runs/77/annotations",
          },
          app: { id: 15_368, slug: "github-actions", name: "GitHub Actions" },
          details_url: "https://github.com/acme/widget/actions/runs/1/job/2",
          html_url: "https://github.com/acme/widget/runs/77",
          check_suite: { id: 99 },
          pull_requests: [{ number: 670, base: { repo: { id: 41 } } }],
        }],
      });
    };
    const listed = await githubAdapter(fetcher).executeTool("checks.list_for_ref", {
      owner: "acme",
      repo: "widget",
      ref: "main",
    }, {
      connection: personalConnection([GitHubCapabilities.checksRead]),
      principal: { type: "user" as const, userId: asUserId("d6d77053-92bc-4af6-8332-8bea8c4c6904") },
      signal: neverAborts(),
    });

    const [check] = (listed.output as { checkRuns: { output: { text: string } }[] }).checkRuns;
    expect(check?.output.text).toHaveLength(40_000);
    expect(check?.output.text).toMatch(/\[truncated: 45000 characters exceeds the 40000-character limit\]$/u);
    expect(check).toMatchObject({
      id: 77,
      conclusion: "failure",
      output: { title: "1 error", summary: "eslint found 1 error" },
      app: { slug: "github-actions" },
      details_url: "https://github.com/acme/widget/actions/runs/1/job/2",
    });
    // The embedded repository beside it still goes.
    expect(check).not.toHaveProperty("pull_requests");
    expect(check).not.toHaveProperty("check_suite");
  });

  it("pages issues by what GitHub served rather than by what survives the pull-request filter", async () => {
    // `issues.list` drops the pull requests GitHub's issues endpoint returns, so
    // the page it shows is shorter than the page it was served. Paging on the
    // shown length ends the list early on exactly the repository where it costs
    // most: one whose issue numbers are mostly pull requests.
    // Exactly one full page of thirty, of which twenty-four are pull requests:
    // GitHub has more to serve, and the six that survive the filter must not be
    // mistaken for the end of the list.
    const served = [
      ...Array.from({ length: 24 }, (_, index) => ({ number: index + 1, title: `PR ${index + 1}`, pull_request: { url: "u" } })),
      ...Array.from({ length: 6 }, (_, index) => ({ number: 100 + index, title: `Issue ${index + 1}` })),
    ];
    const fetcher: FetchLike = async (input) => {
      const url = requestUrl(input);
      expect(url.pathname).toBe("/repos/acme/widget/issues");
      const perPage = Number(url.searchParams.get("per_page") ?? 30);
      return jsonResponse(served.slice(0, perPage));
    };
    const adapter = githubAdapter(fetcher);
    const listed = await adapter.executeTool("issues.list", { owner: "acme", repo: "widget" }, {
      connection: personalConnection([GitHubCapabilities.issuesRead]),
      principal: { type: "user" as const, userId: asUserId("d6d77053-92bc-4af6-8332-8bea8c4c6904") },
      signal: neverAborts(),
    });

    expect(listed.output).toMatchObject({ count: 6, hasMore: true });
    expect((listed.output as { issues: { number: number }[] }).issues.map((issue) => issue.number))
      .toEqual([100, 101, 102, 103, 104, 105]);
  });

  it("does not read a missing check-run total as the end of the list", async () => {
    // `actions.list_workflow_runs` and `checks.list_for_ref` take `hasMore` from
    // GitHub's `total_count`, which is exact when it arrives. Standing the
    // page's own length in for a missing one is the trap: `page * perPage <
    // totalCount` is then false for an exactly-full first page, so the one
    // shape that certainly has more to read is the one that reports the end.
    const checkRuns = Array.from({ length: 30 }, (_, index) => ({ id: index + 1, name: "build", status: "completed" }));
    const adapter = githubAdapter(async () => jsonResponse({ check_runs: checkRuns }));
    const listed = await adapter.executeTool("checks.list_for_ref", { owner: "acme", repo: "widget", ref: "main" }, {
      connection: personalConnection([GitHubCapabilities.checksRead]),
      principal: { type: "user" as const, userId: asUserId("d6d77053-92bc-4af6-8332-8bea8c4c6904") },
      signal: neverAborts(),
    });

    expect(listed.output).toMatchObject({ count: 30, hasMore: true });
    // Omitted rather than invented: a caller cannot tell a stand-in from a real
    // total, and this one would be wrong.
    expect(listed.output).not.toHaveProperty("totalCount");

    const counted = githubAdapter(async () => jsonResponse({ total_count: 30, check_runs: checkRuns }));
    const exact = await counted.executeTool("checks.list_for_ref", { owner: "acme", repo: "widget", ref: "main" }, {
      connection: personalConnection([GitHubCapabilities.checksRead]),
      principal: { type: "user" as const, userId: asUserId("d6d77053-92bc-4af6-8332-8bea8c4c6904") },
      signal: neverAborts(),
    });

    // With a real total the answer is exact, and thirty of thirty is the end.
    expect(exact.output).toMatchObject({ count: 30, totalCount: 30, hasMore: false });
  });

  it("describes every pull-request parameter and asks for none it would have defaulted", () => {
    // The wire schema is the whole of what a model has to go on, so it is
    // asserted as a contract rather than left to a reviewer to notice. `head`
    // is named directly: its format is the one thing that turned a wrong guess
    // into an empty list instead of an error.
    const definition = createGitHubConnector(githubConfig(async () => jsonResponse({})))
      .agentPlugin.tools.find((tool) => tool.name === "pull_requests.list");
    const schema = definition?.inputSchema as {
      required: string[];
      properties: Record<string, { description?: string }>;
    };

    expect(schema.required).toEqual(["owner", "repo"]);
    expect(Object.entries(schema.properties).filter(([, value]) => !value.description?.trim()))
      .toEqual([]);
    expect(schema.properties.head?.description).toContain("owner:branch");
    expect(schema.properties.head?.description).toContain("empty list rather than an error");

    // The same ambiguity one level up, on the tool rather than a parameter: an
    // empty check list reads as "nothing has reported on this commit", and that
    // is only true when nothing narrowed the query.
    const checks = createGitHubConnector(githubConfig(async () => jsonResponse({})))
      .agentPlugin.tools.find((tool) => tool.name === "checks.list_for_ref");
    expect(checks?.description).toContain("no narrowing entries in appliedFilters");
  });
});

function githubRelationshipDelivery(
  event: string,
  action: string,
  payload: Record<string, unknown>,
) {
  return {
    event,
    action,
    deliveryId: `github-${event}-${action}`,
    installationId: "42",
    payload: {
      installation: { id: 42 },
      repository: githubRepository("acme/widget", 1),
      sender: { id: 7, login: "ada" },
      ...payload,
    },
    rawContentHash: "c".repeat(64),
    receivedAt: "2026-08-01T12:00:01.000Z",
  };
}

function githubRepository(fullName: string, id: number) {
  const [owner, name] = fullName.split("/");
  return {
    id,
    name,
    full_name: fullName,
    html_url: `https://github.com/${fullName}`,
    owner: { login: owner },
  };
}

function githubAdapter(fetcher: FetchLike) {
  return createGitHubConnector(githubConfig(fetcher));
}

function githubConfig(fetcher: FetchLike, privateKey = dummyPrivateKey()): GitHubConnectorConfig {
  return {
    appId: "12345",
    clientId: "github-client",
    clientSecret: "github-secret",
    privateKey,
    redirectUri: "https://api.avalon.test/connections/github/callback",
    webhookSecret: "github-webhook-secret",
    appSlug: "avalon",
    apiBaseUrl: "https://api.github.test",
    webBaseUrl: "https://github.test",
    fetch: fetcher,
    now: () => FIXED_NOW,
  };
}

function personalConnection(grantedScopes: string[]): AuthorizedConnectorConnection {
  return authorizedConnection({
    id: "connection-github-personal",
    workspaceId: asWorkspaceId("668953d2-25f2-44fd-8d72-1e8cf024a277"),
    scope: "personal",
    ownerUserId: "d6d77053-92bc-4af6-8332-8bea8c4c6904",
    grantedScopes,
    credentials: {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: "2099-01-01T00:00:00.000Z",
      installationId: "42",
      tokenKind: "user",
    },
    cursor: {},
    config: { region: "global" },
  });
}

function workspaceConnection(grantedScopes: string[]): AuthorizedConnectorConnection {
  return authorizedConnection({
    id: "00000000-0000-4000-8000-000000000002",
    workspaceId: asWorkspaceId("00000000-0000-4000-8000-000000000001"),
    scope: "workspace",
    ownerUserId: null,
    grantedScopes,
    credentials: {
      accessToken: "installation-access",
      expiresAt: "2099-01-01T00:00:00.000Z",
      installationId: "42",
      tokenKind: "installation",
    },
    cursor: {},
    config: { region: "global" },
  });
}

function requestUrl(input: string | URL | Request): URL {
  return new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function emptyResponse(status = 204): Response {
  return new Response(null, { status });
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function rsaKeyMaterial(): Promise<{ privateKeyPem: string; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const encoded = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const body = toBase64Bytes(encoded).match(/.{1,64}/gu)?.join("\n") ?? "";
  const header = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
  const footer = ["-----END", "PRIVATE KEY-----"].join(" ");
  return {
    privateKeyPem: `${header}\n${body}\n${footer}`,
    publicKey: pair.publicKey,
  };
}

function dummyPrivateKey(): string {
  const header = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
  const footer = ["-----END", "PRIVATE KEY-----"].join(" ");
  return `${header}\nAA==\n${footer}`;
}

function toBase64(value: string): string {
  return toBase64Bytes(new TextEncoder().encode(value));
}

function toBase64Bytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64Url(value: string): string {
  return new TextDecoder().decode(decodeBase64UrlBytes(value));
}

function decodeBase64UrlBytes(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
