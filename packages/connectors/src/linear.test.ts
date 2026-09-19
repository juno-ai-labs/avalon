import { asUserId, asWorkspaceId } from "@rally/contracts";
import { NormalizedActivitySchema } from "@rally/contracts";
import { describe, expect, it } from "vitest";
import { neverAborts } from "./test-signals";
import {
  canPersonalLinearConnectionAccessWebhook,
  createLinearConnector,
  LinearAgentOAuthScopes,
  LinearCapabilities,
  normalizeLinearWebhook,
  type LinearConnectorConfig,
  type VerifiedLinearWebhook,
  verifyLinearWebhook,
} from "./linear";
import { linearAgentActivationAcknowledgement } from "./linear-agent";
import type { FetchLike } from "./provider-utils";
import {
  type AuthorizedConnectorConnection,
  authorizedConnection,
  connectorCapabilitySupportsScope,
} from "./types";

const AVALON_WORKSPACE_ID = asWorkspaceId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const AVALON_CONNECTION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("Linear connector", () => {
  it("uses app-actor PKCE OAuth and returns the installed organization identity", async () => {
    const fetcher: FetchLike = async (input, init) => {
      const url = requestUrl(input);
      if (url.pathname === "/oauth/token") {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("code_verifier")).toBe("v".repeat(43));
        return jsonResponse({
          access_token: "linear-access",
          refresh_token: "linear-refresh",
          expires_in: 3600,
          scope: "read,issues:create",
          token_type: "Bearer",
        });
      }
      if (url.pathname === "/graphql") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer linear-access");
        return jsonResponse({
          data: {
            viewer: {
              id: "app-user-1",
              name: "Avalon",
              app: true,
              organization: { id: "linear-org-1", name: "Acme", urlKey: "acme" },
            },
          },
        });
      }
      throw new Error(`Unexpected Linear URL: ${url}`);
    };
    const adapter = linearAdapter(fetcher);
    const authorization = await adapter.beginAuthorization!({
      state: "s".repeat(32),
      codeChallenge: "c".repeat(43),
      scopes: ["issues:create", ...LinearAgentOAuthScopes],
      connectionScope: "workspace",
    });
    const url = new URL(authorization.url);
    expect(url.searchParams.get("actor")).toBe("app");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")?.split(",")).toEqual([
      "read",
      "issues:create",
      ...LinearAgentOAuthScopes,
    ]);
    expect(adapter.manifest).toMatchObject({
      supportedScopes: ["personal", "workspace"],
      surfaces: ["resource", "native_agent"],
      capabilities: [{
        id: LinearCapabilities.agent,
        kind: "native_agent",
        description: "Delegate and mention Rally in Linear, then continue the work through native agent sessions.",
      }],
      nativeAgent: {
        capability: LinearCapabilities.agent,
        invocationModes: ["delegation", "mention", "follow_up"],
        activityKinds: ["thought", "action", "elicitation", "response", "error"],
        supportsCancellation: true,
        supportsExternalLinks: true,
        supportsPlans: true,
        supportsProactiveSessions: true,
        maturity: "preview",
        runtimeStatus: "protocol_only",
        sessionOwnership: "single_connection_per_provider_account",
        webhookResponseDeadlineMs: 5_000,
        sessionAcknowledgementDeadlineMs: 10_000,
      },
    });
    expect(connectorCapabilitySupportsScope(adapter, LinearCapabilities.read, "personal")).toBe(true);
    expect(connectorCapabilitySupportsScope(adapter, LinearCapabilities.agent, "personal")).toBe(false);
    expect(connectorCapabilitySupportsScope(adapter, LinearCapabilities.agent, "workspace")).toBe(true);
    expect(adapter.nativeAgent?.capability).toBe(LinearCapabilities.agent);
    expect(adapter.nativeAgent?.activationAcknowledgement).toBe(linearAgentActivationAcknowledgement);
    const resourceOnlyAuthorization = await adapter.beginAuthorization!({
      state: "r".repeat(32),
      codeChallenge: "d".repeat(43),
      scopes: ["issues:create"],
      connectionScope: "workspace",
    });
    expect(new URL(resourceOnlyAuthorization.url).searchParams.get("scope")?.split(",")).toEqual([
      "read",
      "issues:create",
    ]);

    await expect(adapter.handleAuthorizationCallback!({
      code: "authorization-code",
      codeVerifier: "v".repeat(43),
      connectionScope: "workspace",
      authorizationState: authorization.state,
    })).resolves.toMatchObject({
      accessToken: "linear-access",
      refreshToken: "linear-refresh",
      oauthActor: "app",
      appUserId: "app-user-1",
      organizationId: "linear-org-1",
      providerAccountId: "linear-org-1",
      providerAccountName: "Acme",
    });
  });

  it("uses a user actor for personal OAuth and records the authorized human separately", async () => {
    const fetcher: FetchLike = async (input) => {
      const url = requestUrl(input);
      if (url.pathname === "/oauth/token") return jsonResponse({
        access_token: "personal-access",
        refresh_token: "personal-refresh",
        expires_in: 3600,
        scope: "read,write",
      });
      if (url.pathname === "/graphql") return jsonResponse({
        data: {
          viewer: {
            id: "linear-user-1",
            name: "Ada Lovelace",
            email: "ada@example.com",
            app: false,
            organization: { id: "linear-org-1", name: "Acme", urlKey: "acme" },
          },
        },
      });
      throw new Error(`Unexpected Linear URL: ${url}`);
    };
    const adapter = linearAdapter(fetcher);
    const authorization = await adapter.beginAuthorization!({
      state: "p".repeat(32),
      codeChallenge: "c".repeat(43),
      scopes: ["write"],
      connectionScope: "personal",
    });
    const authorizationUrl = new URL(authorization.url);
    expect(authorizationUrl.searchParams.get("actor")).toBe("user");
    expect(authorization.state).toEqual({ connectionScope: "personal" });
    const credentials = await adapter.handleAuthorizationCallback!({
      code: "personal-code",
      codeVerifier: "v".repeat(43),
      connectionScope: "personal",
      authorizationState: authorization.state,
    });
    expect(credentials).toMatchObject({
      oauthActor: "user",
      authorizedUserId: "linear-user-1",
      authorizedUserName: "Ada Lovelace",
      authorizedUserEmail: "ada@example.com",
      organizationId: "linear-org-1",
      providerAccountId: "linear-org-1",
      providerAccountName: "Ada Lovelace · Acme",
    });
    expect(credentials).not.toHaveProperty("appUserId");
  });

  it("requires trusted connection scope and keeps native-agent OAuth workspace-only", async () => {
    const adapter = linearAdapter(async () => { throw new Error("OAuth validation should not fetch"); });
    await expect(adapter.beginAuthorization!({
      state: "s".repeat(32),
      codeChallenge: "c".repeat(43),
      scopes: ["read"],
    })).rejects.toThrow(/connectionScope/i);
    await expect(adapter.beginAuthorization!({
      state: "s".repeat(32),
      codeChallenge: "c".repeat(43),
      scopes: ["read", ...LinearAgentOAuthScopes],
      connectionScope: "personal",
    })).rejects.toThrow(/workspace-scoped/i);
    await expect(adapter.handleAuthorizationCallback!({
      code: "authorization-code",
      codeVerifier: "v".repeat(43),
      authorizationState: { connectionScope: "workspace" },
    })).rejects.toThrow(/connectionScope/i);
  });

  it("preserves personal actor and user identity when rotating OAuth credentials", async () => {
    const adapter = linearAdapter(async (input) => {
      expect(requestUrl(input).pathname).toBe("/oauth/token");
      return jsonResponse({
        access_token: "rotated-personal-access",
        refresh_token: "rotated-personal-refresh",
        expires_in: 3600,
        scope: "read",
      });
    });
    const connection = personalLinearConnection([LinearCapabilities.read]);
    await expect(adapter.refreshCredentials!(connection, neverAborts())).resolves.toMatchObject({
      accessToken: "rotated-personal-access",
      refreshToken: "rotated-personal-refresh",
      oauthActor: "user",
      authorizedUserId: "linear-user-1",
      organizationId: "linear-org-1",
    });
  });

  it("rotates credentials and retries one API request after a 401", async () => {
    const authorizations: string[] = [];
    let refreshes = 0;
    const fetcher: FetchLike = async (input, init) => {
      const url = requestUrl(input);
      if (url.pathname === "/oauth/token") {
        refreshes += 1;
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("refresh_token")).toBe("old-refresh");
        return jsonResponse({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
          scope: "read",
        });
      }
      if (url.pathname === "/graphql") {
        const authorization = new Headers(init?.headers).get("authorization") ?? "";
        authorizations.push(authorization);
        if (authorization === "Bearer old-access") return jsonResponse({ message: "expired" }, 401);
        return jsonResponse({ data: { teams: { nodes: [{ id: "team-1", name: "Core" }], pageInfo: { hasNextPage: false } } } });
      }
      throw new Error(`Unexpected Linear URL: ${url}`);
    };
    const adapter = linearAdapter(fetcher);
    const connection = linearConnection([LinearCapabilities.read]);
    const result = await adapter.executeTool("list_teams", {}, {
      connection,
      principal: { type: "workspace", workspaceId: AVALON_WORKSPACE_ID },
      signal: neverAborts(),
    });
    expect(result.output).toMatchObject({ nodes: [{ id: "team-1", name: "Core" }] });
    expect(refreshes).toBe(1);
    expect(authorizations).toEqual(["Bearer old-access", "Bearer new-access"]);
    expect(connection.credentials).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh" });
  });

  it("allows only the owning Avalon user to execute tools through a personal Linear connection", async () => {
    let graphqlCalls = 0;
    const adapter = linearAdapter(async () => {
      graphqlCalls += 1;
      return jsonResponse({
        data: { teams: { nodes: [{ id: "team-1", name: "Core" }], pageInfo: { hasNextPage: false } } },
      });
    });
    const connection = personalLinearConnection([LinearCapabilities.read]);
    await expect(adapter.executeTool("list_teams", {}, {
      connection,
      principal: { type: "user", userId: asUserId("7088fd6d-1db0-4f5a-86ca-3978d96e0d47") },
      signal: neverAborts(),
    })).resolves.toMatchObject({ summary: "Listed Linear teams" });
    expect(graphqlCalls).toBe(1);

    await expect(adapter.executeTool("list_teams", {}, {
      connection,
      principal: { type: "user", userId: asUserId("c823c5e4-dcc7-4a16-8856-3db84d0efb17") },
      signal: neverAborts(),
    })).rejects.toThrow(/another principal/i);
    await expect(adapter.executeTool("list_teams", {}, {
      connection,
      principal: { type: "workspace", workspaceId: AVALON_WORKSPACE_ID },
      signal: neverAborts(),
    })).rejects.toThrow(/another principal/i);
    expect(graphqlCalls).toBe(1);
  });

  it("allows personal resource hydration and health checks while rejecting native-agent execution", async () => {
    const adapter = linearAdapter(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { query: string };
      if (request.query.includes("RallyReadDocument")) return jsonResponse({
        data: { document: { id: "document-1", title: "Personal plan" } },
      });
      if (request.query.includes("RallyLinearHealth")) return jsonResponse({ data: { viewer: { id: "linear-user-1" } } });
      throw new Error(`Unexpected query: ${request.query}`);
    });
    const connection = personalLinearConnection([LinearCapabilities.read, LinearCapabilities.agent]);
    await expect(adapter.hydrateResource!(connection, {
      resource_type: "linear_document",
      provider_resource_id: "document-1",
    }, neverAborts())).resolves.toMatchObject({ id: "document-1", title: "Personal plan" });
    await expect(adapter.healthCheck(connection)).resolves.toEqual({
      ok: true,
      message: "Linear authorization is healthy",
    });
    await expect(adapter.nativeAgent!.execute({}, {
      connection,
      signal: neverAborts(),
    })).rejects.toThrow(/workspace scope/i);
  });

  it("hydrates provider resources into bounded agent context", async () => {
    const fetcher: FetchLike = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { query: string };
      expect(request.query).toContain("RallyReadDocument");
      return jsonResponse({
        data: {
          document: { id: "document-1", title: "Design", content: "x".repeat(50_000) },
        },
      });
    };
    const adapter = linearAdapter(fetcher);
    const hydrated = await adapter.hydrateResource!(linearConnection([]), {
      resource_type: "linear_document",
      provider_resource_id: "document-1",
    }, neverAborts());
    expect(hydrated).toMatchObject({ id: "document-1", title: "Design" });
    expect((hydrated as { content: string }).content).toHaveLength(40_000);
  });

  it("hydrates project updates as their own resource type", async () => {
    const fetcher: FetchLike = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      expect(request.query).toContain("RallyReadProjectUpdate");
      expect(request.variables).toEqual({ id: "update-1" });
      return jsonResponse({
        data: {
          projectUpdate: {
            id: "update-1",
            body: "On track",
            project: { id: "project-1", name: "Launch" },
          },
        },
      });
    };
    const adapter = linearAdapter(fetcher);
    await expect(adapter.hydrateResource!(linearConnection([]), {
      resource_type: "linear_project_update",
      provider_resource_id: "update-1",
    }, neverAborts())).resolves.toMatchObject({
      id: "update-1",
      body: "On track",
      project: { id: "project-1" },
    });
  });

  /**
   * The descriptions for `read_issue`, `update_issue`, and `create_comment` say
   * Linear takes either the UUID or the team-prefixed key (`ENG-142`) as an
   * issue id, because both executors hand the argument straight to Linear's
   * `String!` id. This pins the half that is ours: the connector forwards the
   * key byte-for-byte rather than validating, normalizing, or rejecting it.
   * What Linear does with it is Linear's contract, and is not assertable here.
   */
  it("forwards a team-prefixed issue key to Linear unchanged", async () => {
    const sent: Record<string, unknown>[] = [];
    const fetcher: FetchLike = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      sent.push(request.variables);
      if (request.query.includes("RallyReadIssue")) {
        return jsonResponse({ data: { issue: { id: "issue-1", identifier: "ENG-142", comments: { nodes: [] } } } });
      }
      return jsonResponse({
        data: { issueUpdate: { success: true, issue: { id: "issue-1", identifier: "ENG-142", title: "Ship" } } },
      });
    };
    const adapter = linearAdapter(fetcher);
    const context = {
      connection: linearConnection([LinearCapabilities.read, LinearCapabilities.write]),
      principal: { type: "workspace", workspaceId: AVALON_WORKSPACE_ID } as const,
      signal: neverAborts(),
    };

    await adapter.executeTool("read_issue", { issueId: "ENG-142" }, context);
    await adapter.executeTool("update_issue", { issueId: "ENG-142", title: "Ship" }, context);

    expect(sent).toEqual([
      { id: "ENG-142" },
      { id: "ENG-142", input: { title: "Ship" } },
    ]);
  });

  it("uses Linear's canonical stateId field when updating workflow state", async () => {
    let variables: Record<string, unknown> | null = null;
    const fetcher: FetchLike = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      expect(request.query).toContain("RallyUpdateIssue");
      variables = request.variables;
      return jsonResponse({
        data: {
          issueUpdate: {
            success: true,
            issue: { id: "issue-1", identifier: "AVA-1", title: "Ship" },
          },
        },
      });
    };
    const adapter = linearAdapter(fetcher);
    await adapter.executeTool("update_issue", {
      issueId: "issue-1",
      stateId: "state-started",
    }, {
      connection: linearConnection([LinearCapabilities.write]),
      principal: { type: "workspace", workspaceId: AVALON_WORKSPACE_ID },
      signal: neverAborts(),
    });
    expect(variables).toEqual({ id: "issue-1", input: { stateId: "state-started" } });
    const updateSchema = adapter.manifest.tools.find((tool) => tool.name === "update_issue")?.inputSchema;
    expect(updateSchema).toMatchObject({
      properties: { stateId: expect.any(Object) },
    });
    expect((updateSchema as { properties: Record<string, unknown> }).properties).not.toHaveProperty("statusId");
  });

  it("refuses an argument it does not declare instead of dropping it", async () => {
    // The canonical trap: `create_issue` used to take a subset of what
    // `update_issue` takes, and a non-strict parse dropped the rest silently.
    // A model that had learned `dueDate` on update sent it to create, the field
    // vanished, and the tool reported the issue created — wrong, with nothing
    // in the run able to notice.
    // The provider call succeeds, so the only thing that can reject here is the
    // argument parse. A fetcher that threw would let this pass whether or not
    // the schema is strict, which is how a drop stays invisible.
    let reached = false;
    const adapter = linearAdapter(async () => {
      reached = true;
      return jsonResponse({
        data: { issueCreate: { success: true, issue: { id: "issue-1", identifier: "AVA-1", title: "Ship" } } },
      });
    });
    const context = {
      connection: linearConnection([LinearCapabilities.issueCreate]),
      principal: { type: "workspace" as const, workspaceId: AVALON_WORKSPACE_ID },
      signal: neverAborts(),
    };

    await expect(adapter.executeTool("create_issue", {
      teamId: "team-1",
      title: "Ship",
      notARealField: "dropped",
    }, context)).rejects.toThrow(/unrecognized|unexpected|not.*allowed/iu);
    expect(reached, "the write must not happen when an argument was refused").toBe(false);

    // Every write on this connector, not just the one above.
    for (const [tool, args] of [
      ["update_issue", { issueId: "issue-1", title: "Ship", notARealField: "dropped" }],
      ["create_comment", { issueId: "issue-1", body: "hello", notARealField: "dropped" }],
    ] as const) {
      await expect(
        adapter.executeTool(tool, args, {
          ...context,
          connection: linearConnection([LinearCapabilities.write, LinearCapabilities.commentCreate]),
        }),
        `${tool} accepted an undeclared argument`,
      ).rejects.toThrow(/unrecognized|unexpected|not.*allowed/iu);
    }
    expect(reached).toBe(false);
  });

  it("takes the same issue fields on create that it takes on update", async () => {
    let variables: Record<string, unknown> | null = null;
    const adapter = linearAdapter(async (_input, init) => {
      variables = (JSON.parse(String(init?.body)) as { variables: Record<string, unknown> }).variables;
      return jsonResponse({
        data: { issueCreate: { success: true, issue: { id: "issue-9", identifier: "AVA-9", title: "Ship" } } },
      });
    });

    await adapter.executeTool("create_issue", {
      teamId: "team-1",
      title: "Ship",
      stateId: "state-started",
      dueDate: "2026-09-01",
    }, {
      connection: linearConnection([LinearCapabilities.issueCreate]),
      principal: { type: "workspace", workspaceId: AVALON_WORKSPACE_ID },
      signal: neverAborts(),
    });

    expect(variables).toEqual({
      input: { teamId: "team-1", title: "Ship", stateId: "state-started", dueDate: "2026-09-01" },
    });
    const create = adapter.manifest.tools.find((tool) => tool.name === "create_issue")!.inputSchema as {
      properties: Record<string, unknown>;
    };
    const update = adapter.manifest.tools.find((tool) => tool.name === "update_issue")!.inputSchema as {
      properties: Record<string, unknown>;
    };
    // Every field an update can set, a create can set. The reverse does not
    // hold — `teamId` is a create-only choice — so this is one-directional.
    expect(Object.keys(update.properties).filter((key) => key !== "issueId")
      .filter((key) => !Object.hasOwn(create.properties, key))).toEqual([]);
  });

  it("searches issue descriptions, not just titles", async () => {
    let query = "";
    let variables: Record<string, unknown> | null = null;
    const adapter = linearAdapter(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      query = request.query;
      variables = request.variables;
      return jsonResponse({ data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } });
    });

    await adapter.executeTool("search_issues", { query: "flaky rebase" }, {
      connection: linearConnection([LinearCapabilities.read]),
      principal: { type: "workspace", workspaceId: AVALON_WORKSPACE_ID },
      signal: neverAborts(),
    });

    // Titles alone made "the issue about the flaky rebase test" unfindable
    // whenever the title was "Fix CI", and the empty result reads as the work
    // not being tracked at all.
    expect(query).toContain("title: { containsIgnoreCase: $query }");
    expect(query).toContain("description: { containsIgnoreCase: $query }");
    expect(query).toContain("or:");
    expect(variables).toMatchObject({ query: "flaky rebase" });
  });

  it("can discover the workflow states an update takes, without reading an unrelated issue", async () => {
    let variables: Record<string, unknown> | null = null;
    const adapter = linearAdapter(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      expect(request.query).toContain("RallyListWorkflowStates");
      variables = request.variables;
      return jsonResponse({
        data: {
          workflowStates: {
            nodes: [{ id: "state-started", name: "In Progress", type: "started", position: 1 }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    });

    const result = await adapter.executeTool("list_workflow_states", { teamId: "team-1" }, {
      connection: linearConnection([LinearCapabilities.read]),
      principal: { type: "workspace", workspaceId: AVALON_WORKSPACE_ID },
      signal: neverAborts(),
    });

    expect(variables).toMatchObject({ filter: { team: { id: { eq: "team-1" } } } });
    expect(result.output).toMatchObject({ nodes: [{ id: "state-started", name: "In Progress" }] });
  });

  it("names what the connection can do when it refuses a tool it cannot", async () => {
    const adapter = linearAdapter(async () => {
      throw new Error("A refused tool must never reach Linear");
    });

    // A bare "not granted" is the one fact the model already knew. What it can
    // act on is the list of capabilities the connection does hold.
    await expect(adapter.executeTool("create_issue", { teamId: "team-1", title: "Ship" }, {
      connection: linearConnection([LinearCapabilities.read]),
      principal: { type: "workspace", workspaceId: AVALON_WORKSPACE_ID },
      signal: neverAborts(),
    })).rejects.toMatchObject({
      code: "unsupported_capability",
      message: expect.stringContaining(LinearCapabilities.read),
      details: { reason: "capability_not_granted", available: [LinearCapabilities.read] },
    });
  });

  it("proves personal webhook visibility against the signed resource or parent and fails closed", async () => {
    const queries: string[] = [];
    const fetcher: FetchLike = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, string>;
      };
      queries.push(request.query);
      if (request.query.includes("resource: comment") && request.variables.id === "comment-1") {
        return jsonResponse({
          data: { resource: null },
          errors: [{ message: "Comment was removed", extensions: { code: "ENTITY_NOT_FOUND" } }],
        }, 400);
      }
      if (request.query.includes("resource: issue") && request.variables.id === "issue-1") {
        return jsonResponse({ data: { resource: { id: "issue-1" } } });
      }
      return jsonResponse({ data: { resource: null } });
    };
    const connection = personalLinearConnection([LinearCapabilities.read]);
    const verified = verifiedLinearEvent("Comment", {
      id: "comment-1",
      issueId: "issue-1",
    });
    await expect(canPersonalLinearConnectionAccessWebhook({
      config: linearConfig(fetcher),
      connection,
      verified,
      signal: neverAborts(),
    })).resolves.toBe(true);
    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain("resource: comment");
    expect(queries[1]).toContain("resource: issue");

    const queryCount = queries.length;
    await expect(canPersonalLinearConnectionAccessWebhook({
      config: linearConfig(fetcher),
      connection,
      verified: verifiedLinearEvent("AgentSessionEvent", { id: "session-1" }),
    })).resolves.toBe(false);
    await expect(canPersonalLinearConnectionAccessWebhook({
      config: linearConfig(fetcher),
      connection,
      verified: { ...verifiedLinearEvent("Issue", { id: "issue-1" }), organizationId: "another-org" },
    })).resolves.toBe(false);
    await expect(canPersonalLinearConnectionAccessWebhook({
      config: linearConfig(fetcher),
      connection,
      verified: verifiedLinearEvent("Customer", { id: "customer-1" }),
    })).resolves.toBe(false);
    expect(queries).toHaveLength(queryCount);

    await expect(canPersonalLinearConnectionAccessWebhook({
      config: linearConfig(fetcher),
      connection,
      verified: verifiedLinearEvent("Issue", { id: "issue-2" }),
    })).resolves.toBe(false);
    expect(queries).toHaveLength(queryCount + 1);
  });

  it("propagates personal webhook authorization failures for reconnect handling", async () => {
    const connection = personalLinearConnection([LinearCapabilities.read]);
    delete connection.credentials.accessToken;
    await expect(canPersonalLinearConnectionAccessWebhook({
      config: linearConfig(async () => {
        throw new Error("Access probing should fail before a provider request");
      }),
      connection,
      verified: verifiedLinearEvent("Issue", { id: "issue-1" }),
    })).rejects.toMatchObject({
      code: "unauthorized",
      details: { reconnectRequired: true },
    });
  });

  it("propagates transient personal access-probe failures so the webhook can retry", async () => {
    await expect(canPersonalLinearConnectionAccessWebhook({
      config: linearConfig(async () => jsonResponse({
        data: null,
        errors: [{ message: "Linear is temporarily unavailable", extensions: { code: "INTERNAL_ERROR" } }],
      })),
      connection: personalLinearConnection([LinearCapabilities.read]),
      verified: verifiedLinearEvent("Issue", { id: "issue-1" }),
    })).rejects.toMatchObject({ code: "provider_error" });
  });

  it("normalizes pre-filtered personal resource events but rejects native-agent events", () => {
    const connection = personalLinearConnection([LinearCapabilities.read]);
    expect(normalizeLinearWebhook(
      connection,
      verifiedLinearEvent("Issue", { id: "issue-1", identifier: "AVA-1" }),
    )).toMatchObject({
      connectionScope: "personal",
      connectionOwnerUserId: "7088fd6d-1db0-4f5a-86ca-3978d96e0d47",
      eventType: "linear.issue.remove",
    });
    expect(() => normalizeLinearWebhook(
      connection,
      verifiedLinearEvent("AgentSessionEvent", { id: "session-1" }),
    )).toThrow(/workspace-only/i);
  });

  it("verifies the exact raw webhook and normalizes only the installed organization", async () => {
    const now = 1_788_000_000_000;
    const secret = "linear-webhook-secret";
    const rawBody = JSON.stringify({
      type: "Issue",
      action: "create",
      organizationId: "linear-org-1",
      webhookId: "webhook-1",
      webhookTimestamp: now,
      createdAt: new Date(now).toISOString(),
      actor: { id: "person-1", name: "Ada" },
      data: {
        id: "issue-1",
        identifier: "AVA-42",
        title: "Ship connectors",
        description: "Connect Linear to Avalon",
        url: "https://linear.app/acme/issue/AVA-42",
      },
    });
    const verified = await verifyLinearWebhook({
      secret,
      rawBody,
      signatureHeader: await hmacHex(secret, rawBody),
      deliveryHeader: "11111111-1111-4111-8111-111111111111",
      eventHeader: "Issue",
      timestampHeader: String(now),
      now,
    });
    const activity = normalizeLinearWebhook(linearConnection([]), verified, "r2://payload/linear");
    expect(activity).toMatchObject({
      provider: "linear",
      providerEventId: "11111111-1111-4111-8111-111111111111",
      eventType: "linear.issue.create",
      resourceType: "linear_issue",
      providerResourceId: "issue-1",
      payloadRef: "r2://payload/linear",
      dedupeKey: "linear:11111111-1111-4111-8111-111111111111",
    });
    expect(() => NormalizedActivitySchema.parse({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", ...activity })).not.toThrow();

    const wrongOrganization = linearConnection([]);
    wrongOrganization.credentials.organizationId = "linear-org-2";
    expect(() => normalizeLinearWebhook(wrongOrganization, verified)).toThrow(/organization/i);
    await expect(verifyLinearWebhook({
      secret,
      rawBody,
      signatureHeader: "0".repeat(64),
      deliveryHeader: "11111111-1111-4111-8111-111111111111",
      now,
    })).rejects.toThrow(/signature/i);
  });

  it("uses each Linear-Delivery as the idempotency key", () => {
    const event = {
      type: "Issue",
      action: "update",
      organizationId: "linear-org-1",
      webhookId: "webhook-1",
      webhookTimestamp: 1_788_000_000_000,
      data: { id: "issue-1", identifier: "AVA-42" },
    };
    const first = normalizeLinearWebhook(linearConnection([]), {
      deliveryId: "11111111-1111-4111-8111-111111111111",
      eventName: "Issue",
      organizationId: "linear-org-1",
      webhookId: "webhook-1",
      webhookTimestamp: 1_788_000_000_000,
      bodyHash: "hash-1",
      event,
    });
    const second = normalizeLinearWebhook(linearConnection([]), {
      deliveryId: "22222222-2222-4222-8222-222222222222",
      eventName: "Issue",
      organizationId: "linear-org-1",
      webhookId: "webhook-1",
      webhookTimestamp: 1_788_000_000_000,
      bodyHash: "hash-2",
      event,
    });
    expect(first.dedupeKey).toBe("linear:11111111-1111-4111-8111-111111111111");
    expect(second.dedupeKey).toBe("linear:22222222-2222-4222-8222-222222222222");
  });

  it("canonicalizes special actions and exposes top-level permission relationships", () => {
    const activity = normalizeLinearWebhook(linearConnection([]), {
      deliveryId: "33333333-3333-4333-8333-333333333333",
      eventName: "PermissionChange",
      organizationId: "linear-org-1",
      webhookId: "webhook-1",
      webhookTimestamp: 1_788_000_000_000,
      bodyHash: "a".repeat(64),
      event: {
        type: "PermissionChange",
        action: "teamAccessChanged",
        organizationId: "linear-org-1",
        webhookId: "webhook-1",
        webhookTimestamp: 1_788_000_000_000,
        appUserId: "app-user-1",
        addedTeamIds: ["team-1"],
        removedTeamIds: ["team-2"],
      },
    });
    expect(activity.eventType).toBe("linear.permission_change.team_access_changed");
    expect(activity.entityKeys).toEqual(expect.arrayContaining(["app-user-1", "team-1", "team-2"]));
  });

  it("models project updates independently and links them to the parent project", () => {
    const activity = normalizeLinearWebhook(linearConnection([]), {
      deliveryId: "44444444-4444-4444-8444-444444444444",
      eventName: "ProjectUpdate",
      organizationId: "linear-org-1",
      webhookId: "webhook-1",
      webhookTimestamp: 1_788_000_000_000,
      bodyHash: "hash",
      event: {
        type: "ProjectUpdate",
        action: "create",
        organizationId: "linear-org-1",
        webhookId: "webhook-1",
        webhookTimestamp: 1_788_000_000_000,
        data: {
          id: "update-1",
          body: "On track",
          projectId: "project-1",
          project: { id: "project-1", name: "Launch" },
        },
      },
    });
    expect(activity).toMatchObject({
      eventType: "linear.project_update.create",
      resourceType: "linear_project_update",
      providerResourceId: "update-1",
    });
    expect(activity.entityKeys).toContain("project-1");
  });

  it("preserves native-agent session context as a first-class inbound activity", () => {
    const activity = normalizeLinearWebhook(linearConnection([LinearCapabilities.agent]), {
      deliveryId: "55555555-5555-4555-8555-555555555555",
      eventName: "AgentSessionEvent",
      organizationId: "linear-org-1",
      webhookId: "webhook-1",
      webhookTimestamp: 1_788_000_000_000,
      bodyHash: "a".repeat(64),
      event: {
        type: "AgentSessionEvent",
        action: "created",
        appUserId: "app-user-1",
        oauthClientId: "linear-client",
        organizationId: "linear-org-1",
        webhookId: "webhook-1",
        webhookTimestamp: 1_788_000_000_000,
        createdAt: "2026-08-29T18:40:00.000Z",
        promptContext: "Investigate the failing deployment and report back.",
        agentSession: {
          id: "session-1",
          appUserId: "app-user-1",
          organizationId: "linear-org-1",
          status: "pending",
          type: "delegated",
          createdAt: "2026-08-29T18:40:00.000Z",
          updatedAt: "2026-08-29T18:40:00.000Z",
          issueId: "issue-1",
          issue: {
            id: "issue-1",
            identifier: "AVA-42",
            teamId: "team-1",
            title: "Fix deployment",
            url: "https://linear.app/acme/issue/AVA-42",
            team: { id: "team-1" },
          },
          creatorId: "user-1",
          creator: {
            id: "user-1",
            name: "Ada",
            email: "ada@example.com",
            url: "https://linear.app/acme/profiles/ada",
          },
        },
      },
    }, "r2://payload/linear-agent");
    expect(activity).toMatchObject({
      eventType: "linear.agent_session_event.created",
      resourceType: null,
      providerResourceId: "session-1",
      title: "Linear agent created: AVA-42: Fix deployment",
      summary: "Investigate the failing deployment and report back.",
      payloadRef: "r2://payload/linear-agent",
      metadata: {
        surface: "native_agent",
        agentSessionId: "session-1",
        stopRequested: false,
      },
    });
    expect(activity.entityKeys).toEqual(expect.arrayContaining([
      "linear-org-1", "app-user-1", "session-1", "issue-1", "AVA-42",
    ]));
    expect(() => NormalizedActivitySchema.parse({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      ...activity,
    })).not.toThrow();
  });
});

function linearAdapter(fetcher: FetchLike) {
  return createLinearConnector(linearConfig(fetcher));
}

function linearConfig(fetcher: FetchLike): LinearConnectorConfig {
  return {
    clientId: "linear-client",
    clientSecret: "linear-secret",
    redirectUri: "https://api.avalon.test/connections/linear/callback",
    fetch: fetcher,
    now: () => 1_788_000_000_000,
  };
}

function linearConnection(grantedScopes: string[]): AuthorizedConnectorConnection {
  return authorizedConnection({
    id: AVALON_CONNECTION_ID,
    workspaceId: AVALON_WORKSPACE_ID,
    scope: "workspace",
    ownerUserId: null,
    grantedScopes,
    credentials: {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: "2099-01-01T00:00:00.000Z",
      organizationId: "linear-org-1",
    },
    cursor: {},
    config: { region: "global" },
  });
}

function personalLinearConnection(grantedScopes: string[]): AuthorizedConnectorConnection {
  return authorizedConnection({
    ...linearConnection(grantedScopes),
    scope: "personal",
    ownerUserId: "7088fd6d-1db0-4f5a-86ca-3978d96e0d47",
    credentials: {
      ...linearConnection(grantedScopes).credentials,
      oauthActor: "user",
      authorizedUserId: "linear-user-1",
    },
  });
}

function verifiedLinearEvent(
  eventName: string,
  data: Record<string, unknown>,
): VerifiedLinearWebhook {
  return {
    deliveryId: "99999999-9999-4999-8999-999999999999",
    eventName,
    organizationId: "linear-org-1",
    webhookId: "webhook-1",
    webhookTimestamp: 1_788_000_000_000,
    bodyHash: "a".repeat(64),
    event: {
      type: eventName,
      action: "remove",
      organizationId: "linear-org-1",
      webhookId: "webhook-1",
      webhookTimestamp: 1_788_000_000_000,
      data,
    },
  };
}

function requestUrl(input: string | URL | Request): URL {
  return new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
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
