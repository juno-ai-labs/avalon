/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { connectorTextPages } from "../src/services/connector-text-pages";

describe("connector text snapshots on real R2", () => {
  it("persists a snapshot across store instances and serves exact byte ranges within its scope", async () => {
    const scope = { region: "global", workspaceId: crypto.randomUUID(), workstreamId: "thread", substreamId: "0", connectionId: "connection" };
    const owned = async () => {};
    const first = connectorTextPages(env.PAYLOADS, scope, owned);
    const id = await first.write(new TextEncoder().encode("first page\nsecond page"));
    const resumed = connectorTextPages(env.PAYLOADS, scope, owned);
    const page = await resumed.read(id, 11, 11);
    expect(new TextDecoder().decode(page.bytes)).toBe("second page");
    expect(page.totalBytes).toBe(22);
    await expect(connectorTextPages(env.PAYLOADS, { ...scope, connectionId: "other" }, owned).read(id, 0, 11)).rejects.toMatchObject({ details: { reason: "text_snapshot_unavailable" } });
    await expect(connectorTextPages(env.PAYLOADS, { ...scope, substreamId: "private" }, owned).read(id, 0, 11)).rejects.toMatchObject({ details: { reason: "text_snapshot_unavailable" } });
  });

  it("refuses reads after authority is lost even when the source is stored", async () => {
    let owned = true;
    const store = connectorTextPages(env.PAYLOADS, { region: "global", workspaceId: crypto.randomUUID(), workstreamId: "thread", substreamId: "0", connectionId: "connection" }, async () => { if (!owned) throw new Error("authority_lost"); });
    const id = await store.write(new TextEncoder().encode("private source"));
    owned = false;
    await expect(store.read(id, 0, 128000)).rejects.toThrow("authority_lost");
  });
});
