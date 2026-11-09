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
        name: "avalon-api-global-AgentLoopDO",
        script: "avalon-api-global",
        class: "AgentLoopDO",
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

    const sweep = await sweepInventory(CREDENTIALS, {
      fetcher,
      now: () => 1_700_000_000_000,
    });

    expect(sweep.status).toBe("complete");
    expect(sweep.namespaces).toHaveLength(1);
    expect(sweep.namespaces[0]?.scriptName).toBe("avalon-api-global");
    expect(sweep.namespaces[0]?.usesSqlite).toBe(true);
    expect(sweep.namespaces[0]?.objects).toEqual([
      { objectId: "a".repeat(64), hasStoredData: true, observedAt: 1_700_000_000_000 },
      { objectId: "b".repeat(64), hasStoredData: false, observedAt: 1_700_000_000_000 },
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

  it("fails the namespace listing visibly when an object omits its storage fact", async () => {
    const { fetcher } = stubFetch((url) => (url.pathname.endsWith("/objects")
      ? {
          body: {
            success: true,
            result: [{ id: "a".repeat(64) }],
            result_info: { cursor: "" },
          },
        }
      : { body: namespaceListing() }));

    const sweep = await sweepInventory(CREDENTIALS, { fetcher });

    expect(sweep.status).toBe("partial");
    expect(sweep.namespaces[0]?.objects).toBeNull();
    expect(sweep.errorMessage).toBe("ns-1: cloudflare_object_missing_has_stored_data");
  });

  it("fails the namespace listing visibly when an object omits its id", async () => {
    const { fetcher } = stubFetch((url) => (url.pathname.endsWith("/objects")
      ? {
          body: {
            success: true,
            result: [{ hasStoredData: true }],
            result_info: { cursor: "" },
          },
        }
      : { body: namespaceListing() }));

    const sweep = await sweepInventory(CREDENTIALS, { fetcher });

    expect(sweep.status).toBe("partial");
    expect(sweep.namespaces[0]?.objects).toBeNull();
    expect(sweep.errorMessage).toBe("ns-1: cloudflare_object_missing_id");
  });

  /**
   * The namespace listing is the account's inventory, and the registry retires
   * everything missing from a `complete` one. These three cases are the ways it
   * could report less than the whole account while still calling itself
   * complete — each of which would retire live classes.
   */
  describe("the namespace listing has to be the whole account", () => {
    /** `count` namespaces, page `page`, in the API's envelope shape. */
    function page(index: number, size: number): unknown {
      return {
        success: true,
        result: Array.from({ length: size }, (_unused, offset) => ({
          id: `ns-${index * 100 + offset}`,
          script: "avalon-api-global",
          class: `Class${index * 100 + offset}`,
          use_sqlite: true,
        })),
      };
    }

    it("follows the namespace pages past the first", async () => {
      let requested = 0;
      const { fetcher } = stubFetch((url) => {
        if (url.pathname.endsWith("/objects")) {
          return { body: { success: true, result: [], result_info: { cursor: "" } } };
        }
        requested += 1;
        // A full page, then a short one: 150 namespaces over two requests.
        return { body: requested === 1 ? page(0, 100) : page(1, 50) };
      });

      const sweep = await sweepInventory(CREDENTIALS, { fetcher });

      expect(sweep.status).toBe("complete");
      expect(sweep.namespaces).toHaveLength(150);
      expect(requested).toBe(2);
    });

    /**
     * Cloudflare does not document this endpoint as paginated, so it may simply
     * ignore `page` and answer with the same list every time. That must
     * terminate, and must not report each namespace more than once.
     */
    it("stops when a page repeats what the last one returned", async () => {
      let requested = 0;
      const { fetcher } = stubFetch((url) => {
        if (url.pathname.endsWith("/objects")) {
          return { body: { success: true, result: [], result_info: { cursor: "" } } };
        }
        requested += 1;
        return { body: page(0, 100) };
      });

      const sweep = await sweepInventory(CREDENTIALS, { fetcher });

      expect(sweep.status).toBe("complete");
      expect(sweep.namespaces).toHaveLength(100);
      expect(requested).toBe(2);
    });

    it("refuses to call the sweep complete when a namespace payload has no id", async () => {
      const { fetcher } = stubFetch((url) => (url.pathname.endsWith("/objects")
        ? { body: { success: true, result: [], result_info: { cursor: "" } } }
        : {
            body: {
              success: true,
              result: [
                { id: "ns-1", script: "avalon-api-global", class: "AgentLoopDO" },
                { script: "avalon-api-global", class: "MysteryAgent" },
              ],
            },
          }));

      const sweep = await sweepInventory(CREDENTIALS, { fetcher });

      // The namespace it could read is still reported; the sweep just stops
      // claiming to be the account's full inventory.
      expect(sweep.namespaces).toHaveLength(1);
      expect(sweep.status).toBe("partial");
      expect(sweep.errorMessage).toContain("no usable id");
    });
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
