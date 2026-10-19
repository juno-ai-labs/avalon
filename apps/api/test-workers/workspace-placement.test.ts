import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { workspacePlacementAffinity } from "../src/lib/durable-object-namespace";
import { createTestD1Database, createTestD1PreparedStatement } from "../test/helpers/cloudflare-test";

const WORKSPACE = "00000000-0000-7000-8000-0000000073a1";

beforeEach(async () => {
  await reset();
  await env.DB.exec("CREATE TABLE workspaces (id TEXT PRIMARY KEY, region TEXT, placement_affinity TEXT)");
  await env.DB.prepare("INSERT INTO workspaces VALUES (?, 'global', 'enam')").bind(WORKSPACE).run();
});

describe("workspace placement cache", () => {
  it("lets another lookup succeed when the initiating lookup is cancelled", async () => {
    let cancel!: (reason: Error) => void;
    const gate = new Promise<void>((_resolve, reject) => { cancel = reject; });
    let first = true;
    // Storage and query results are real D1. Only cancellation timing is
    // injected: workerd's test runner cannot cancel its own request context
    // while continuing to assert in it. The gate holds that request's read
    // after starting it, and rejects it after the second lookup has begun.
    const database = createTestD1Database({
      prepare: (query: string) => createTestD1PreparedStatement({
        bind: (...values: unknown[]) => createTestD1PreparedStatement({
          first: async () => {
            const result = env.DB.prepare(query).bind(...values).first();
            const held = first;
            first = false;
            if (held) {
              await Promise.all([result, gate]);
            }
            return result;
          },
        }),
      }),
    });
    const context = { DB: database, APP_ENV: "production", AVALON_REGION: "global" } as const;
    const cancelled = workspacePlacementAffinity(context, WORKSPACE);
    const cancellation = expect(cancelled).rejects.toThrow("request_cancelled");
    const independent = workspacePlacementAffinity(context, WORKSPACE);
    // Attach the assertion before releasing the cancellation, so the broken
    // implementation's shared rejection is handled too.
    const success = expect(independent).resolves.toBe("enam");
    cancel(new Error("request_cancelled"));
    await cancellation;
    await success;
    expect(await workspacePlacementAffinity(context, WORKSPACE)).toBe("enam");
  });

  it("reuses a completed immutable placement without another database read", async () => {
    const context = { DB: env.DB, APP_ENV: "production", AVALON_REGION: "global" } as const;
    expect(await workspacePlacementAffinity(context, WORKSPACE)).toBe("enam");
    await env.DB.exec("DROP TABLE workspaces");
    expect(await workspacePlacementAffinity(context, WORKSPACE)).toBe("enam");
  });

  it("does not cache the local fallback after a failed read", async () => {
    // A fresh binding wrapper gives this case its own cache, just as another
    // Worker isolate would have, while every query still reaches real D1.
    const database = createTestD1Database({ prepare: (query: string) => env.DB.prepare(query) });
    const context = { DB: database, APP_ENV: "test", AVALON_REGION: "global" } as const;
    await env.DB.prepare("DELETE FROM workspaces WHERE id = ?").bind(WORKSPACE).run();
    expect(await workspacePlacementAffinity(context, WORKSPACE)).toBe("wnam");
    await env.DB.prepare("INSERT INTO workspaces VALUES (?, 'global', 'enam')").bind(WORKSPACE).run();
    expect(await workspacePlacementAffinity(context, WORKSPACE)).toBe("enam");
  });

  it("evicts only one warm entry when concurrent reads fill the same missing key", async () => {
    const database = createTestD1Database({ prepare: (query: string) => env.DB.prepare(query) });
    const context = { DB: database, APP_ENV: "production", AVALON_REGION: "global" } as const;
    // Fill the existing 1,024-entry cache, keeping a known insertion order.
    // The last key is reserved for two overlapping cache misses.
    await env.DB.prepare(`WITH RECURSIVE numbers(n) AS (
      VALUES(0) UNION ALL SELECT n + 1 FROM numbers WHERE n < 1024
    ) INSERT INTO workspaces SELECT 'placement-' || n, 'global', 'enam' FROM numbers`).run();
    for (let index = 0; index < 1024; index += 1) {
      await workspacePlacementAffinity(context, `placement-${index}`);
    }
    expect(await Promise.all([
      workspacePlacementAffinity(context, "placement-1024"),
      workspacePlacementAffinity(context, "placement-1024"),
    ])).toEqual(["enam", "enam"]);
    await env.DB.exec("DROP TABLE workspaces");
    // The first miss evicts placement-0. The other completion must not evict
    // placement-1 too: its cached answer still works without the database.
    expect(await workspacePlacementAffinity(context, "placement-1")).toBe("enam");
  });
});
