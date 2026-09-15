import { describe, expect, it, vi } from "vitest";
import { provisionDaytonaWebhook } from "../scripts/daytona-webhook-provisioning";
import { verifySvixSignature } from "../src/lib/svix-signature";

function gateway() {
  let endpoint: { id: string; uid?: string; url: string; disabled: boolean; filterTypes: string[] } | undefined;
  const key = `whsec_${Buffer.alloc(32, 9).toString("base64")}`;
  let installed: Record<string, string> = {};
  const calls: string[] = [];
  const paths: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (target, init) => {
    const url = new URL(String(target));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);
    const headers = new Headers(init?.headers);
    if (url.host === "daytona.test") {
      expect(headers.get("authorization")).toBe("Bearer daytona-key");
      if (url.pathname.endsWith("/app-portal-access")) return Response.json({ token: "portal.us.scoped" });
      if (url.pathname.endsWith("/refresh-endpoints")) return new Response(null, { status: 204 });
      return Response.json({});
    }
    if (url.host === "rally.test") {
      await verifySvixSignature({ secret: installed.DAYTONA_WEBHOOK_SECRET!, rawBody: String(init?.body),
        id: headers.get("svix-id"), timestamp: headers.get("svix-timestamp"), signature: headers.get("svix-signature"),
        now: Date.now(), replayWindowSeconds: 300 });
      return Response.json({ accepted: true });
    }
    expect(url.host).toBe("api.us.svix.com");
    expect(headers.get("authorization")).toBe("Bearer portal.us.scoped");
    if (method === "GET" && url.pathname.endsWith("/endpoint")) return Response.json({ data: endpoint ? [endpoint] : [], done: true, iterator: null });
    if (method === "PUT") {
      paths.push(url.pathname);
      endpoint = { id: endpoint?.id ?? "ep_1", ...JSON.parse(String(init?.body)) };
    }
    if (method !== "PUT" && ![endpoint?.id, endpoint?.uid].includes(url.pathname.split("/")[6])) {
      return new Response(null, { status: 404 });
    }
    if (method === "PATCH") endpoint = { ...endpoint!, ...JSON.parse(String(init?.body)) };
    return Response.json(url.pathname.endsWith("/secret") ? { key } : endpoint);
  });
  const installSecrets = vi.fn(async (secrets: Record<string, string>) => { installed = secrets; calls.push("install"); });
  return { input: { apiKey: "daytona-key", apiUrl: "https://daytona.test/api", organizationId: "org", webhookUrl: "https://rally.test/ingest/daytona", fetcher, installSecrets }, calls, paths, endpoint: () => endpoint };
}
describe("Daytona webhook provisioning", () => {
  it("reuses one endpoint and verifies secret installation before enabling delivery", async () => {
    const f = gateway();
    const first = await provisionDaytonaWebhook(f.input);
    const second = await provisionDaytonaWebhook(f.input);
    expect(first.endpointId).toBe(second.endpointId);
    expect(f.paths[0]).toContain("/endpoint/rally-terminal-");
    expect(f.paths[1]).toBe("/api/v1/app/org/endpoint/ep_1");
    expect(f.endpoint()).toMatchObject({ uid: expect.stringContaining("rally-terminal-"), disabled: false, filterTypes: ["sandbox.created", "sandbox.state.updated"] });
    const install = f.calls.indexOf("install");
    const probe = f.calls.indexOf("POST /ingest/daytona");
    const enable = f.calls.findIndex((call) => call.startsWith("PATCH"));
    expect(install).toBeLessThan(probe);
    expect(probe).toBeLessThan(enable);
  });
  it("finds an existing endpoint on a later page instead of creating a duplicate", async () => {
    const f = gateway();
    const original = f.input.fetcher.getMockImplementation()!;
    f.input.fetcher.mockImplementation((target, init) => {
      const url = new URL(String(target));
      if (url.pathname.endsWith("/endpoint")) return Promise.resolve(Response.json(
        url.searchParams.has("iterator")
          ? { data: [{ id: "ep_manual", url: f.input.webhookUrl, disabled: false, filterTypes: null }], done: true, iterator: null }
          : { data: [], done: false, iterator: "page-2" },
      ));
      return original(target, init);
    });
    await provisionDaytonaWebhook(f.input);
    expect(f.paths).toEqual(["/api/v1/app/org/endpoint/ep_manual"]);
  });

  it("leaves delivery disabled if installing the secret fails", async () => {
    const f = gateway();
    f.input.installSecrets.mockRejectedValueOnce(new Error("deployment failed"));
    await expect(provisionDaytonaWebhook(f.input)).rejects.toThrow("deployment failed");
    expect(f.endpoint()?.disabled).toBe(true);
    expect(f.calls.some((call) => call.startsWith("PATCH"))).toBe(false);
  });
  it("does not enable delivery when the deployed receiver rejects the probe", async () => {
    const f = gateway();
    const original = f.input.fetcher.getMockImplementation()!;
    f.input.fetcher.mockImplementation((target, init) => String(target).includes("rally.test")
      ? Promise.resolve(new Response(null, { status: 503 })) : original(target, init));
    await expect(provisionDaytonaWebhook(f.input)).rejects.toThrow("receiver probe failed");
    expect(f.endpoint()?.disabled).toBe(true);
  });
});
