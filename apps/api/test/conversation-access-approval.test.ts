import { describe, expect, it } from "vitest";

import { encryptString, sealString } from "../src/lib/crypto";
import { conversationAccessRoutes } from "../src/routes/conversation-access";
import { asUserId, asWorkspaceId } from "@rally/contracts";
import { approvalUrl, ConversationAccessRequestService, openApproval } from "../src/services/conversation-access-request-service";
import { createTestEnv } from "./helpers/cloudflare-test";

const env = createTestEnv({
  OAUTH_STATE_ENCRYPTION_KEY: "conversation-access-test-key",
  PUBLIC_API_BASE_URL: "https://api.example.test",
});

const approval = {
  workspaceId: "00000000-0000-4000-8000-0000000ac001",
  requestId: "00000000-0000-4000-8000-0000000ac099",
  approverUserId: "00000000-0000-4000-8000-0000000ac011",
};

const tokenOf = (url: string) => new URL(url).searchParams.get("token")!;

describe("conversation access approval token", () => {
  it("opens to exactly what was sealed, from the link the email carries", async () => {
    const url = await approvalUrl(env, approval);
    expect(url.startsWith("https://api.example.test/conversation-access/approve?token=")).toBe(true);
    expect(await openApproval(env, tokenOf(url))).toEqual(approval);
  });

  it("refuses a value sealed under the same key for another purpose", async () => {
    expect(await openApproval(env, await sealString(JSON.stringify(approval), env.OAUTH_STATE_ENCRYPTION_KEY))).toBeNull();
    const other = await encryptString(JSON.stringify(approval), env.OAUTH_STATE_ENCRYPTION_KEY, "rally-scope-invitation");
    expect(await openApproval(env, `${other.iv}.${other.ciphertext}`)).toBeNull();
  });

  it("refuses an approval whose sealed half was altered", async () => {
    const token = tokenOf(await approvalUrl(env, approval));
    const altered = `${token.slice(0, -2)}${token.endsWith("AA") ? "BB" : "AA"}`;
    expect(await openApproval(env, altered)).toBeNull();
  });
});

describe("approve page", () => {
  it("answers the link with a page that posts the token back, granting nothing on the fetch", async () => {
    const token = tokenOf(await approvalUrl(env, approval));
    const response = await conversationAccessRoutes.request(`/approve?token=${encodeURIComponent(token)}`, {}, env);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`<input type="hidden" name="token" value="${token}">`);
    const nonce = /<script nonce="([^"]+)">/u.exec(html)?.[1];
    expect(response.headers.get("content-security-policy")).toContain(`script-src 'nonce-${nonce}'`);
  });

  it("says a forged link is not valid", async () => {
    const forged = await sealString(JSON.stringify(approval), env.OAUTH_STATE_ENCRYPTION_KEY);
    const response = await conversationAccessRoutes.request("/approve", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: forged }).toString(),
    }, env);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("This link is not valid");
  });
});

describe("a guest", () => {
  // A guest is told nothing it does not take part in (docs/listing-rules.md):
  // not a private conversation's name, and not whether it exists. The refusal
  // comes before any read, so this needs no Organization object.
  const guest = new ConversationAccessRequestService(createTestEnv({}), {
    sessionId: "session-guest",
    userId: asUserId("00000000-0000-4000-8000-0000000ac014"),
    workspaceId: asWorkspaceId("00000000-0000-4000-8000-0000000ac001"),
    region: "global",
    role: null,
  });
  const channel = "00000000-0000-4000-8000-0000000ac0a0";

  it("is told a conversation does not exist rather than shown its name", async () => {
    await expect(guest.preview(channel, "0")).rejects.toMatchObject({ status: 404, code: "conversation_not_found" });
  });

  it("cannot ask to join", async () => {
    await expect(guest.request(channel, "0")).rejects.toMatchObject({ status: 404, code: "conversation_not_found" });
  });
});
