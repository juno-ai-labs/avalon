/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";

import { inFlowSpan, inSpan } from "../src/observability/tracing";

/**
 * These run on real workerd rather than Node, because the constraint being
 * tested is a runtime one: whether `tracing.enterSpan` from `cloudflare:workers`
 * exists and behaves at this Worker's compatibility date.
 *
 * Every other test of this subsystem runs against the hand-written
 * `cloudflare:workers` stub in `test/helpers/`, which is the right tool for
 * asserting span names and attributes cheaply — but `AGENTS.md` reserves a
 * double for what *cannot* run here, and custom spans can. Without this file
 * the entire feature rests on an import that no test ever resolves for real, on
 * a platform API that is explicitly in open beta. What is pinned here is
 * deliberately shallow — the API is reachable, it runs the callback, it awaits
 * the promise, it propagates a throw — because the runtime exposes no way to
 * read a finished span back, and asserting on anything deeper would be
 * asserting on the stub again.
 */
describe("custom spans on the Workers runtime", () => {
  it("runs the callback and returns its value through a real span", async () => {
    const seen: string[] = [];

    const result = await inSpan("workstream.create.receipt.reserve", { "rally.flow": "workstream_create" }, async () => {
      seen.push("ran");
      return "receipt-1";
    });

    expect(result).toBe("receipt-1");
    expect(seen).toEqual(["ran"]);
  });

  it("awaits the callback rather than ending the span on the first tick", async () => {
    let settled = false;

    await inSpan("workstream.create.object.initialize", {}, async () => {
      await scheduler.wait(1);
      settled = true;
    });

    // If `enterSpan` returned before the promise resolved, this would be false
    // — the span would close while the work it names was still running.
    expect(settled).toBe(true);
  });

  it("propagates a throw out of a real span", async () => {
    await expect(inSpan("workstream.message.object_write", {}, () => Promise.reject(new Error("boom"))))
      .rejects.toThrow("boom");
  });

  it("nests steps inside a flow and still emits the summary row", async () => {
    const rows: Record<string, unknown>[] = [];
    const original = console.info;
    console.info = (row: unknown) => { rows.push(row as Record<string, unknown>); };

    try {
      await inFlowSpan({ ...env, LOG_LEVEL: "info" }, "workstream.create", {
        flow: "workstream_create",
        component: "api",
        identity: { workspaceId: "workspace-1" },
      }, async (span) => {
        await span.step("workstream.create.receipt.reserve", async () => undefined);
        await span.step("workstream.create.object.initialize", async () => undefined);
      });
    } finally {
      console.info = original;
    }

    const flow = rows.find((row) => row["event"] === "perf_flow");
    expect(flow).toMatchObject({ flow: "workstream_create", component: "api", workspace_id: "workspace-1" });
    // Durations are not asserted: workerd usually pins `Date.now()` across a
    // synchronous run, but a full suite can advance the clock before the first
    // step and legitimately record that positive gap as `unattributed`.
    const steps = flow?.["steps"] as Record<string, number>;
    expect(Object.keys(steps).filter((name) => name !== "unattributed")).toEqual([
      "workstream.create.receipt.reserve",
      "workstream.create.object.initialize",
    ]);
    if (steps["unattributed"] !== undefined) expect(steps["unattributed"]).toBeGreaterThan(0);
  });
});
