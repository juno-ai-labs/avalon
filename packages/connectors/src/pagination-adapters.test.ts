import { describe, expect, it } from "vitest";
import { asWorkspaceId } from "@rally/contracts";
import { createGoogleConnector } from "./index";
import { createSlackConnector } from "./slack";
import { createLinearConnector } from "./linear";
import { createNotionConnector } from "./notion";
import { createGranolaConnector } from "./granola";
import { createXConnector } from "./x";
import { authorizedConnection, type ConnectorAdapter } from "./types";

const workspaceId = asWorkspaceId("11111111-1111-4111-8111-111111111111");
const opaque = "provider+/=opaque";
const requests: string[] = [];
const jsonFetcher = (payload: unknown): typeof fetch => async (url, init) => {
  requests.push(`${String(url)} ${String(init?.body ?? "")}`);
  return Response.json(payload);
};
const config = { clientId: "client", clientSecret: "secret", redirectUri: "https://example.test/callback" };
const page = { nodes: [], pageInfo: { hasNextPage: true, endCursor: opaque } };
const adapters: ConnectorAdapter[] = [
  createGoogleConnector({ ...config, fetch: jsonFetcher({ messages: [], files: [], items: [], nextPageToken: opaque }) }),
  createSlackConnector({ ...config, signingSecret: "secret", fetch: jsonFetcher({ ok: true, messages: [], members: [], has_more: true,
    response_metadata: { next_cursor: opaque }, results: { messages: [], next_cursor: opaque } }) }),
  createLinearConnector({ ...config, fetch: jsonFetcher({ data: { issues: page, teams: page, projects: page, workflowStates: page } }) }),
  createNotionConnector({ ...config, fetch: jsonFetcher({ results: [], next_cursor: opaque, has_more: true }) }),
  createGranolaConnector({ ...config, fetch: jsonFetcher({ notes: [], folders: [], cursor: opaque, hasMore: true }) }),
  createXConnector({ apiKey: "test", fetch: jsonFetcher({ tweets: [], next_cursor: opaque }) }),
];
const argumentsByName: Record<string, Record<string, unknown>> = {
  "gmail.search": { query: "needle" }, "drive.search": { query: "needle" },
  "calendar.list_events": { calendarId: "primary", timeMin: "2026-09-01T00:00:00Z", timeMax: "2026-10-01T00:00:00Z" },
  search: { query: "needle" }, search_messages: { query: "needle" },
  read_channel: { channel_id: "C123" }, read_thread: { channel_id: "C123", thread_ts: "1234567890.123456" },
  list_channel_members: { channel_id: "C123" }, search_issues: { query: "needle" }, list_workflow_states: { teamId: "team-1" },
  query_data_source: { dataSourceId: "22222222-2222-4222-8222-222222222222" },
  list_comments: { blockId: "22222222-2222-4222-8222-222222222222" },
  get_user_timeline: { userId: "123" }, get_tweet_thread_context: { tweetId: "123" },
  get_tweet_replies_v2: { tweetId: "123" }, list_timeline: { listId: "123" },
};

describe("authored connector pagination contracts", () => {
  // Enumerate declarations, not a second list of paginated tools: a new marker
  // without an executor continuation must fail this sweep.
  for (const adapter of adapters) {
    // Text snapshots have no provider cursor; google-file-text.test.ts exercises their pages.
    for (const definition of adapter.manifest.tools.filter((tool) => tool.pagination && tool.pagination.cursorParameter !== "textPage")) {
      it(`${adapter.manifest.type}.${definition.name} preserves and sends a real continuation`, async () => {
        requests.length = 0;
        const connection = authorizedConnection({ id: "connection", workspaceId, scope: "workspace", ownerUserId: null,
          grantedScopes: adapter.manifest.tools.map((tool) => tool.capability),
          credentials: { accessToken: "access", botAccessToken: "bot", apiKey: "grn_test", expiresAt: "2099-01-01T00:00:00Z" },
          config: {}, cursor: {} });
        const context = { connection, principal: { type: "workspace" as const, workspaceId }, signal: new AbortController().signal,
          invocationAuthorization: { slackActionToken: "action" } };
        const result = await adapter.executeTool(definition.name, argumentsByName[definition.name] ?? {}, context);
        const continuation = result.pagination?.continuations[0];
        expect(continuation).toMatchObject({ operation: definition.name, slot: "nextPageId",
          input: { [definition.pagination!.cursorParameter]: opaque } });
        expect(JSON.stringify(result.output)).not.toContain(opaque);
        requests.length = 0;
        await adapter.executeTool(definition.name, continuation!.input, context);
        expect(requests.some((request) => decodeURIComponent(request).includes(opaque))).toBe(true);
      });
    }
  }
});
