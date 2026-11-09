/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { receiveCloudflareEmail } from "../src/services/cloudflare-inbound-email";

const bindings: Env = env;
const recipient = "bright-steady-luminous-curie@rallywithai.com";

function message(raw = "From: outside@example.com\r\nTo: public@example.com\r\n\r\nHello") {
  return {
    from: "outside@example.com", to: recipient, headers: new Headers(),
    raw: new Blob([raw]).stream(), rawSize: new TextEncoder().encode(raw).byteLength,
    setReject: vi.fn<(reason: string) => void>(),
    forward: async () => ({ messageId: "unused" }),
    reply: async () => ({ messageId: "unused" }),
  } satisfies ForwardableEmailMessage;
}

beforeEach(async () => {
  await reset();
  // This suite's D1 starts empty; declare only the Global routing control plane.
  await bindings.DB.exec(`
    CREATE TABLE workstream_authority_control (id INTEGER PRIMARY KEY, phase TEXT, generation INTEGER, required_serving_contract_version INTEGER, serving_contract_version INTEGER);
    INSERT INTO workstream_authority_control VALUES (1, 'durable_object_open', 1, 1, 1);
    CREATE TABLE workstream_email_routes (email_address TEXT PRIMARY KEY, region TEXT, workspace_id TEXT, workstream_id TEXT, automation_subscription_id TEXT, address_source TEXT);
    CREATE TABLE resend_webhook_receipts (svix_id TEXT PRIMARY KEY, resend_email_id TEXT, event_type TEXT, received_at TEXT, routed_at TEXT, error_json TEXT);
  `);
});

describe("Cloudflare email event ingress", () => {
  it("consumes a real stream and persists a single content-derived routing receipt on replay", async () => {
    const first = message();
    await receiveCloudflareEmail(first, bindings);
    await receiveCloudflareEmail(message(), bindings);
    expect(first.setReject).not.toHaveBeenCalled();
    const rows = await bindings.DB.prepare("SELECT resend_email_id, routed_at FROM resend_webhook_receipts").all<{ resend_email_id: string; routed_at: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]!.resend_email_id).toMatch(/^cf_[a-f0-9]{64}$/u);
    expect(rows.results[0]!.routed_at).toEqual(expect.any(String));
  });

  it("rejects oversized mail based on actual stream bytes, including a wrong rawSize", async () => {
    const incoming = { ...message("A message larger than the configured limit"), rawSize: 1 };
    await receiveCloudflareEmail(incoming, { ...bindings, INBOUND_EMAIL_MAX_BYTES: "4" });
    expect(incoming.setReject).toHaveBeenCalledExactlyOnceWith("Email exceeds the configured size limit");
    expect(await bindings.DB.prepare("SELECT count(*) AS count FROM resend_webhook_receipts").first())
      .toEqual({ count: 0 });
  });

  it("propagates maintenance for a temporary failure before acknowledging any mail", async () => {
    await bindings.DB.prepare("UPDATE workstream_authority_control SET phase = 'maintenance_draining'").run();
    await expect(receiveCloudflareEmail(message(), bindings)).rejects.toMatchObject({ code: "workstream_maintenance" });
    expect(await bindings.DB.prepare("SELECT count(*) AS count FROM resend_webhook_receipts").first())
      .toEqual({ count: 0 });
  });
});
