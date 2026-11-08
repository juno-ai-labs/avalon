/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import seed from "../../../packages/db/seed-product.json";
import { SeedProductBodySchema, seedPayloads } from "../src/routes/dev";

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000002";

describe("the development seed's stored bodies", () => {
  it("stores the Launch plan artifact's body where its content_ref points, so it renders", async () => {
    // The local-authority script drops the human-readable note before posting.
    const body: Record<string, unknown> = { ...seed };
    delete body.comment;
    const fixture = SeedProductBodySchema.parse(body);
    await seedPayloads({ ...env, AVALON_REGION: "global" }, fixture.workspaceId, fixture.payloads);

    const artifact = fixture.workspaceTables.resources!.find((row) => row.id === "00000000-0000-7000-8000-000000000041")!;
    const stored = await env.PAYLOADS.get(String(artifact.content_ref));
    expect(stored?.httpMetadata?.contentType).toBe("text/markdown; charset=utf-8");
    expect((await stored!.text()).split("\n")[0]).toBe("# Pricing launch readiness");
  });

  it("refuses a body outside the Organization's seed prefix", async () => {
    await expect(seedPayloads({ ...env, AVALON_REGION: "global" }, WORKSPACE_ID, [
      { key: `global/${WORKSPACE_ID}/resources/real.md`, contentType: "text/plain", text: "x" },
    ])).rejects.toMatchObject({ code: "seed_payload_key_not_allowed" });
    expect(await env.PAYLOADS.get(`global/${WORKSPACE_ID}/resources/real.md`)).toBeNull();
  });
});
