/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from "vitest";
import { sweepInventory } from "../src/inventory";

const CREDENTIALS = { accountId: "account-1", apiToken: "token-1" };

interface StubbedResponse {
  status?: number;
  body: unknown;
}

/** A fetch double that answers by URL and records what was asked for. */
function stubFetch(routes: (url: URL) => StubbedResponse): {
  fetcher: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    calls.push(url.pathname + url.search);
    const answer = routes(url);
    return new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

function namespaceListing(): unknown {
  return {
    success: true,
    result: [
      {
        id: "ns-1",
        name: "avalon-api-global-SubstreamAgent",
        script: "avalon-api-global",
        class: "SubstreamAgent",
        use_sqlite: true,
      },
    ],
  };
}

describe("sweepInventory", () => {
  it("enumerates namespaces and their objects", async () => {
    const { fetcher, calls } = stubFetch((url) => (url.pathname.endsWith("/objects")
      ? {
          body: {
            success: true,
            result: [
              { id: "a".repeat(64), hasStoredData: true },
              { id: "b".repeat(64), hasStoredData: false },
            ],
            result_info: { cursor: "" },
          },
        }
      : { body: namespaceListing() }));

    const sweep = await sweepInventory(CREDENTIALS, { fetcher });

    expect(sweep.status).toBe("complete");
    expect(sweep.namespaces).toHaveLength(1);
    expect(sweep.namespaces[0]?.scriptName).toBe("avalon-api-global");
    expect(sweep.namespaces[0]?.usesSqlite).toBe(true);
    expect(sweep.namespaces[0]?.objects).toEqual([
      { objectId: "a".repeat(64), hasStoredData: true },
      { objectId: "b".repeat(64), hasStoredData: false },
    ]);
    expect(calls[0]).toContain("/workers/durable_objects/namespaces");
  });

  it("follows the cursor across pages without repeating an object", async () => {
    let page = 0;
    const { fetcher } = stubFetch((url) => {
      if (!url.pathname.endsWith("/objects")) return { body: namespaceListing() };
      page += 1;
      return page === 1
        ? {
            body: {
              success: true,
              result: [{ id: "a".repeat(64), hasStoredData: true }],
              result_info: { cursor: "next" },
            },
          }
        : {
            body: {
              success: true,
              result: [
                { id: "a".repeat(64), hasStoredData: true },
                { id: "b".repeat(64), hasStoredData: true },
              ],
              result_info: { cursor: null },
            },
          };
    });

    const sweep = await sweepInventory(CREDENTIALS, { fetcher });

    expect(page).toBe(2);
    expect(sweep.namespaces[0]?.objects).toHaveLength(2);
    expect(sweep.truncatedNamespaces).toEqual([]);
  });

  it("names a namespace it had to truncate rather than reporting it complete", async () => {
    const { fetcher } = stubFetch((url) => (url.pathname.endsWith("/objects")
      ? {
          body: {
            success: true,
            // A cursor that never empties: the page cap is what stops the loop.
            result: [{ id: `${Math.random()}`.padEnd(64, "0").slice(0, 64), hasStoredData: true }],
            result_info: { cursor: "more" },
          },
        }
      : { body: namespaceListing() }));

    const sweep = await sweepInventory(CREDENTIALS, { fetcher });

    expect(sweep.status).toBe("partial");
    expect(sweep.truncatedNamespaces).toEqual(["ns-1"]);
  });

  it("leaves a namespace unlisted when its objects cannot be read", async () => {
    const { fetcher } = stubFetch((url) => (url.pathname.endsWith("/objects")
      ? { status: 429, body: { success: false, errors: [{ code: 10000 }] } }
      : { body: namespaceListing() }));

    const sweep = await sweepInventory(CREDENTIALS, { fetcher });

    expect(sweep.status).toBe("partial");
    expect(sweep.namespaces[0]?.objects).toBeNull();
    expect(sweep.errorMessage).toBe("ns-1: cloudflare_api_status_429");
  });

  it("returns a failed sweep rather than throwing when the account cannot be listed", async () => {
    const { fetcher } = stubFetch(() => ({
      body: { success: false, errors: [{ code: 10000, message: "Authentication error" }] },
    }));

    const sweep = await sweepInventory(CREDENTIALS, { fetcher });

    expect(sweep.status).toBe("failed");
    expect(sweep.namespaces).toEqual([]);
    expect(sweep.errorMessage).toBe("cloudflare_api_error_10000");
  });

  it("sends the API token as a bearer credential", async () => {
    let authorization: string | null = null;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get("authorization");
      void input;
      return new Response(JSON.stringify({ success: true, result: [] }), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await sweepInventory(CREDENTIALS, { fetcher });

    expect(authorization).toBe("Bearer token-1");
  });
});
