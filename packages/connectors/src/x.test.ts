import { asUserId, asWorkspaceId } from "@rally/contracts";
import { describe, expect, it } from "vitest";
import { neverAborts } from "./test-signals";
import { createXConnector, XCapabilities } from "./x";
import type { FetchLike } from "./provider-utils";
import {
  type AuthorizedConnectorConnection,
  authorizedConnection,
  connectorCapabilitySupportsScope,
} from "./types";

describe("X connector", () => {
  it("supports workspace connections only", () => {
    const adapter = xAdapter(async () => jsonResponse({}));
    expect(adapter.manifest.supportedScopes).toEqual(["workspace"]);
    expect(connectorCapabilitySupportsScope(adapter, XCapabilities.read, "workspace")).toBe(true);
    expect(connectorCapabilitySupportsScope(adapter, XCapabilities.read, "personal")).toBe(false);
  });

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

  it("resolves an X handle before reading its numeric-ID timeline", async () => {
    const requested: URL[] = [];
    const fetcher: FetchLike = async (input) => {
      const url = requestUrl(input);
      requested.push(url);
      if (url.pathname === "/twitter/user/info") {
        expect(url.searchParams.get("userName")).toBe("nasa");
        return jsonResponse({ status: "success", data: { id: "104", userName: "nasa" } });
      }
      expect(url.pathname).toBe("/twitter/user/tweet_timeline");
      expect(url.searchParams.get("userId")).toBe("104");
      return jsonResponse({ tweets: [{ id: "105" }], has_next_page: false });
    };
    const result = await execute(xAdapter(fetcher), "get_user_timeline", { userName: "@nasa" });
    expect(result.summary).toBe("Read the X timeline for @nasa");
    expect(requested.map((url) => url.pathname)).toEqual([
      "/twitter/user/info",
      "/twitter/user/tweet_timeline",
    ]);
  });

  it("bounds provider values before returning them to the model", async () => {
    let nested: Record<string, unknown> = { value: "leaf" };
    for (let depth = 0; depth < 10; depth += 1) nested = { child: nested };
    const result = await execute(xAdapter(async () => jsonResponse({
      tweets: [{
        id: "106",
        text: "x".repeat(25_000),
        media: Array.from({ length: 60 }, (_, index) => ({ id: index })),
        nested,
      }],
    })), "list_timeline", { listId: "107" });
    const tweet = (result.output as { tweets: Array<Record<string, unknown>> }).tweets[0]!;
    expect(tweet.text).toBe("x".repeat(20_000));
    expect(tweet.media).toHaveLength(50);
    expect(JSON.stringify(tweet.nested)).toContain("[truncated]");
  });

  it("reports a last page as no cursor rather than as a blank one", async () => {
    // X spells "no more pages" as `next_cursor: ""`. Handed that verbatim, a
    // model told to keep paging while a cursor comes back re-reads page one
    // forever, because the request side reads the blank as no cursor.
    const fetcher: FetchLike = async (input) => {
      const url = requestUrl(input);
      if (url.pathname === "/twitter/tweet/thread_context") {
        return jsonResponse({ replies: [{ id: "302", conversationId: "300", isReply: true }], next_cursor: "" });
      }
      return jsonResponse({ tweets: [{ id: "300", conversationId: "300", isReply: false }], next_cursor: "" });
    };
    const adapter = xAdapter(fetcher);

    for (const [name, args] of [
      ["get_user_timeline", { userId: "301" }],
      ["get_tweet_replies_v2", { tweetId: "302" }],
      ["list_timeline", { listId: "303" }],
      ["get_tweet_thread_context", { tweetId: "302" }],
    ] as const) {
      const result = await execute(adapter, name, args);
      expect(result.output).toMatchObject({ next_cursor: null });
    }
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

  it("prioritizes a conversation root over an earlier non-reply post", async () => {
    let calls = 0;
    const fetcher: FetchLike = async () => {
      calls += 1;
      return jsonResponse({
        replies: [
          { id: "399", conversationId: "398", isReply: false },
          { id: "400", conversationId: "400", isReply: false },
        ],
      });
    };
    const result = await execute(xAdapter(fetcher), "get_tweet_thread_context", { tweetId: "401" });
    expect(result.output).toMatchObject({ original_tweet: { id: "400" } });
    expect(calls).toBe(1);
  });

  it("does not repeat original-post enrichment on cursor pages", async () => {
    let calls = 0;
    const fetcher: FetchLike = async (input) => {
      calls += 1;
      const url = requestUrl(input);
      expect(url.pathname).toBe("/twitter/tweet/thread_context");
      expect(url.searchParams.get("cursor")).toBe("next-thread-page");
      return jsonResponse({ replies: [{ id: "403", conversationId: "400", isReply: true }] });
    };
    const result = await execute(xAdapter(fetcher), "get_tweet_thread_context", {
      tweetId: "403",
      cursor: "next-thread-page",
    });
    expect(result.output).not.toHaveProperty("original_tweet");
    expect(calls).toBe(1);
  });

  it("treats the provider's empty cursor as the first thread page", async () => {
    const requested: URL[] = [];
    const fetcher: FetchLike = async (input) => {
      const url = requestUrl(input);
      requested.push(url);
      if (url.pathname === "/twitter/tweet/thread_context") {
        return jsonResponse({ replies: [{ id: "405", conversationId: "404", isReply: true }] });
      }
      return jsonResponse({ tweets: [{ id: "404", conversationId: "404", isReply: false }] });
    };
    const result = await execute(xAdapter(fetcher), "get_tweet_thread_context", {
      tweetId: "405",
      cursor: "",
    });
    expect(result.output).toMatchObject({ original_tweet: { id: "404" } });
    expect(requested).toHaveLength(2);
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

  it("validates configured access during health checks", async () => {
    const requested: URL[] = [];
    const healthy = xAdapter(async (input) => {
      const url = requestUrl(input);
      requested.push(url);
      return jsonResponse({ recharge_credits: 123 });
    });
    await expect(healthy.healthCheck()).resolves.toEqual({ ok: true, message: "TwitterAPI.io access is healthy" });
    expect(requested[0]?.pathname).toBe("/oapi/my/info");

    const rejected = xAdapter(async () => jsonResponse({ message: "Invalid API key" }, 401));
    await expect(rejected.healthCheck()).resolves.toEqual({ ok: false, message: "Invalid API key" });

    // A balance is not a health signal. TwitterAPI.io bills against more than
    // one, documents only one, and is the authority on whether any given call
    // can be paid for — so an account reporting zero recharge credits while
    // holding spendable bonus credits stays usable, and a call that genuinely
    // cannot be funded fails as a call.
    const zeroRecharge = xAdapter(async () => jsonResponse({ recharge_credits: 0 }));
    await expect(zeroRecharge.healthCheck()).resolves.toEqual({ ok: true, message: "TwitterAPI.io access is healthy" });

    const noBalanceReported = xAdapter(async () => jsonResponse({}));
    await expect(noBalanceReported.healthCheck()).resolves.toEqual({ ok: true, message: "TwitterAPI.io access is healthy" });

    const throttled = xAdapter(async () => jsonResponse({ message: "Slow down" }, 429, { "retry-after": "5" }));
    await expect(throttled.healthCheck()).rejects.toMatchObject({
      code: "provider_error",
      details: expect.objectContaining({ status: 429, retryAfterMs: 5_000 }),
    });
  });

  it("enforces principal and granted-capability boundaries", async () => {
    const adapter = xAdapter(async () => jsonResponse({ tweets: [] }));
    await expect(adapter.executeTool("get_user_timeline", { userId: "600" }, {
      connection: xConnection([]),
      principal: { type: "workspace", workspaceId: asWorkspaceId("025a3f3d-6749-495a-8425-7640a0dbf27a") },
      signal: neverAborts(),
    })).rejects.toThrow(/has not granted/u);
    await expect(adapter.executeTool("get_user_timeline", { userId: "600" }, {
      connection: xConnection([XCapabilities.read]),
      principal: { type: "workspace", workspaceId: asWorkspaceId("fbb0ea04-43a2-41f1-81a3-e8b1f2f30cc6") },
      signal: neverAborts(),
    })).rejects.toThrow(/not available/u);

    await expect(adapter.executeTool("get_user_timeline", { userId: "600" }, {
      connection: xConnection([XCapabilities.read]),
      principal: { type: "workspace", workspaceId: asWorkspaceId("025a3f3d-6749-495a-8425-7640a0dbf27a") },
      signal: neverAborts(),
    })).resolves.toMatchObject({ summary: "Read the X timeline for user 600" });
    await expect(adapter.executeTool("unknown_tool", {}, {
      connection: xConnection([XCapabilities.read]),
      principal: { type: "workspace", workspaceId: asWorkspaceId("025a3f3d-6749-495a-8425-7640a0dbf27a") },
      signal: neverAborts(),
    })).rejects.toThrow(/has not granted unknown_tool/u);

    await expect(adapter.executeTool("get_user_timeline", { userId: "600" }, {
      connection: personalXConnection([XCapabilities.read]),
      principal: { type: "user", userId: asUserId("08b7a776-1e8e-4e35-8ecf-cf41dc2b1232") },
      signal: neverAborts(),
    })).rejects.toThrow(/must belong to a workspace/u);
  });

  it("rejects unsafe API origins", () => {
    expect(() => createXConnector({ apiKey: "secret-key", apiBaseUrl: "http://api.example.test" })).toThrow(/HTTPS origin/u);
    expect(() => createXConnector({ apiKey: "secret-key", apiBaseUrl: "https://api.example.test/nested" })).toThrow(/HTTPS origin/u);
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
    principal: { type: "workspace", workspaceId: asWorkspaceId("025a3f3d-6749-495a-8425-7640a0dbf27a") },
    signal: neverAborts(),
  });
}

function xConnection(
  grantedScopes: string[],
): AuthorizedConnectorConnection {
  return authorizedConnection({
    id: "x-connection",
    workspaceId: asWorkspaceId("025a3f3d-6749-495a-8425-7640a0dbf27a"),
    scope: "workspace",
    ownerUserId: null,
    grantedScopes,
    credentials: {},
    cursor: {},
    config: {},
  });
}

function personalXConnection(grantedScopes: string[]): AuthorizedConnectorConnection {
  return authorizedConnection({
    ...xConnection(grantedScopes),
    scope: "personal",
    ownerUserId: "08b7a776-1e8e-4e35-8ecf-cf41dc2b1232",
  });
}

function requestUrl(input: string | URL | Request): URL {
  return new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
}

function jsonResponse(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) },
  });
}
