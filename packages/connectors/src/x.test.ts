import { describe, expect, it } from "vitest";
import { createXConnector, XCapabilities } from "./x";
import type { FetchLike } from "./provider-utils";
import type { ConnectorConnectionContext } from "./types";

describe("X connector", () => {
  it("reads user, reply, and List timelines with documented query parameters", async () => {
    const requested: URL[] = [];
    const fetcher: FetchLike = async (input, init) => {
      const url = requestUrl(input);
      requested.push(url);
      expect(new Headers(init?.headers).get("x-api-key")).toBe("secret-key");
      return jsonResponse({ tweets: [{ id: "100" }], has_next_page: false, next_cursor: "" });
    };
    const adapter = xAdapter(fetcher);

    await execute(adapter, "get_user_timeline", {
      userId: "101",
      includeReplies: true,
      includeParentTweet: false,
      cursor: "user-next",
    });
    await execute(adapter, "get_tweet_replies_v2", {
      tweetId: "102",
      cursor: "reply-next",
      queryType: "Latest",
    });
    await execute(adapter, "list_timeline", { listId: "103", cursor: "list-next" });

    expect(requested.map((url) => url.pathname)).toEqual([
      "/twitter/user/tweet_timeline",
      "/twitter/tweet/replies/v2",
      "/twitter/list/tweets_timeline",
    ]);
    expect(Object.fromEntries(requested[0]!.searchParams)).toEqual({
      userId: "101",
      includeReplies: "true",
      includeParentTweet: "false",
      cursor: "user-next",
    });
    expect(Object.fromEntries(requested[1]!.searchParams)).toEqual({
      tweetId: "102",
      cursor: "reply-next",
      queryType: "Latest",
    });
    expect(Object.fromEntries(requested[2]!.searchParams)).toEqual({ listId: "103", cursor: "list-next" });
  });

  it("adds the original post when thread context omits it", async () => {
    const requested: URL[] = [];
    const fetcher: FetchLike = async (input) => {
      const url = requestUrl(input);
      requested.push(url);
      if (url.pathname === "/twitter/tweet/thread_context") {
        return jsonResponse({
          replies: [{ id: "202", conversationId: "200", isReply: true }],
          has_next_page: false,
          next_cursor: "",
        });
      }
      expect(url.pathname).toBe("/twitter/tweets");
      expect(url.searchParams.get("tweet_ids")).toBe("200");
      return jsonResponse({
        status: "success",
        tweets: [{ id: "200", conversationId: "200", isReply: false, text: "Original" }],
      });
    };

    const result = await execute(xAdapter(fetcher), "get_tweet_thread_context", { tweetId: "202" });
    expect(result.output).toMatchObject({
      original_tweet: { id: "200", text: "Original" },
      replies: [{ id: "200" }, { id: "202" }],
    });
    expect(requested).toHaveLength(2);
  });

  it("does not perform an extra lookup when context contains the original post", async () => {
    let calls = 0;
    const fetcher: FetchLike = async () => {
      calls += 1;
      return jsonResponse({
        replies: [
          { id: "300", conversationId: "300", isReply: false },
          { id: "301", conversationId: "300", isReply: true },
        ],
        has_next_page: false,
      });
    };
    const result = await execute(xAdapter(fetcher), "get_tweet_thread_context", { tweetId: "301" });
    expect(result.output).toMatchObject({ original_tweet: { id: "300" } });
    expect(calls).toBe(1);
  });

  it("discovers the original ID from the requested post when thread context is empty", async () => {
    const requested: URL[] = [];
    const fetcher: FetchLike = async (input) => {
      const url = requestUrl(input);
      requested.push(url);
      if (url.pathname === "/twitter/tweet/thread_context") return jsonResponse({ replies: [] });
      if (url.searchParams.get("tweet_ids") === "402") {
        return jsonResponse({ tweets: [{ id: "402", conversationId: "400", isReply: true }] });
      }
      return jsonResponse({ tweets: [{ id: "400", conversationId: "400", isReply: false }] });
    };
    const result = await execute(xAdapter(fetcher), "get_tweet_thread_context", { tweetId: "402" });
    expect(result.output).toMatchObject({ original_tweet: { id: "400" }, replies: [{ id: "400" }] });
    expect(requested.map((url) => url.searchParams.get("tweet_ids"))).toEqual([null, "402", "400"]);
  });

  it("rejects provider-level errors returned with a successful HTTP status", async () => {
    const adapter = xAdapter(async () => jsonResponse({ status: "error", message: "Quota exhausted" }));
    await expect(execute(adapter, "list_timeline", { listId: "500" })).rejects.toThrow("Quota exhausted");
  });

  it("enforces principal and granted-capability boundaries", async () => {
    const adapter = xAdapter(async () => jsonResponse({ tweets: [] }));
    await expect(adapter.executeTool("get_user_timeline", { userId: "600" }, {
      connection: xConnection([]),
      principal: { type: "user", userId: "avalon-user" },
      signal: AbortSignal.timeout(1_000),
    })).rejects.toThrow(/has not granted/u);
    await expect(adapter.executeTool("get_user_timeline", { userId: "600" }, {
      connection: xConnection([XCapabilities.read]),
      principal: { type: "user", userId: "another-user" },
      signal: AbortSignal.timeout(1_000),
    })).rejects.toThrow(/another principal/u);
  });
});

function xAdapter(fetcher: FetchLike) {
  return createXConnector({ apiKey: "secret-key", fetch: fetcher });
}

async function execute(
  adapter: ReturnType<typeof xAdapter>,
  name: string,
  args: unknown,
) {
  return adapter.executeTool(name, args, {
    connection: xConnection([XCapabilities.read]),
    principal: { type: "user", userId: "avalon-user" },
    signal: AbortSignal.timeout(1_000),
  });
}

function xConnection(grantedScopes: string[]): ConnectorConnectionContext {
  return {
    id: "x-connection",
    workspaceId: "avalon-workspace",
    scope: "personal",
    ownerUserId: "avalon-user",
    grantedScopes,
    credentials: {},
    cursor: {},
    config: {},
  };
}

function requestUrl(input: string | URL | Request): URL {
  return new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
