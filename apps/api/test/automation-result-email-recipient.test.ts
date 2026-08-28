import { describe, expect, it, vi } from "vitest";

import { deliverFrozenAutomationResultEmail } from "../src/services/automation-email-service";
import {
  createTestD1Database,
  createTestD1PreparedStatement,
  createTestEnv,
} from "./helpers/cloudflare-test";

const WORKSPACE_ID = "00000000-0000-4000-8000-0000000000e1";
const AUTHOR_ID = "00000000-0000-4000-8000-0000000000e2";
const RUN_ID = "00000000-0000-4000-8000-0000000000e3";
const WORKSTREAM_ID = "00000000-0000-4000-8000-0000000000e4";
const AUTOMATION_ID = "00000000-0000-4000-8000-0000000000e5";

/**
 * The one row the delivery reads: who this recipient is right now.
 *
 * `null` stands for a person who is no longer an active member of the
 * workspace, which is the case the join itself refuses.
 */
function environment(recipient: { timezone: string | null; email: string | null } | null) {
  const statement = {
    bind: () => statement,
    first: async () => recipient,
  };
  return createTestEnv({
    DB: createTestD1Database({ prepare: () => createTestD1PreparedStatement(statement) }),
    APP_ENV: "production",
    AVALON_REGION: "global",
    RESEND_API_KEY: "re_test",
    RESEND_FROM_EMAIL: "rally@example.com",
    RESEND_NOTIFICATION_FROM_EMAIL: "rally@example.com",
    PUBLIC_WEB_BASE_URL: "https://app.example.com",
  });
}

function delivery(request: typeof fetch) {
  return deliverFrozenAutomationResultEmail(
    environment({ timezone: "UTC", email: "author@example.com" }),
    {
      workspaceId: WORKSPACE_ID,
      automationSubscriptionId: AUTOMATION_ID,
      automationRunId: RUN_ID,
      workstreamId: WORKSTREAM_ID,
      recipientEmail: "author@example.com",
      recipientUserId: AUTHOR_ID,
      title: "Issue watcher",
      text: "Two issues need attention.",
      outcomeStatus: "completed",
    },
    request,
  );
}

describe("delivering an automation result to a frozen address", () => {
  it("sends to the address the recipient still holds", async () => {
    const sent: string[] = [];
    const request = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      sent.push(String(init?.body));
      return new Response(JSON.stringify({ id: "email-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await expect(delivery(request as unknown as typeof fetch)).resolves.toBe("sent");
    expect(request).toHaveBeenCalledOnce();
    expect(JSON.parse(sent[0] ?? "{}").to).toEqual(["author@example.com"]);
  });

  it("refuses an address the recipient no longer holds", async () => {
    const request = vi.fn();
    // The automation froze `author@example.com` at acceptance; the person has
    // since moved to another address, and the old mailbox may now belong to
    // somebody else entirely. Their workspace membership is untouched, so the
    // membership join alone would still have let this through.
    const state = await deliverFrozenAutomationResultEmail(
      environment({ timezone: "UTC", email: "moved@example.com" }),
      {
        workspaceId: WORKSPACE_ID,
        automationSubscriptionId: AUTOMATION_ID,
        automationRunId: RUN_ID,
        workstreamId: WORKSTREAM_ID,
        recipientEmail: "author@example.com",
        recipientUserId: AUTHOR_ID,
        title: "Issue watcher",
        text: "Two issues need attention.",
        outcomeStatus: "completed",
      },
      request as unknown as typeof fetch,
    );

    expect(state).toBe("skipped");
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses a recipient who is no longer an active member", async () => {
    const request = vi.fn();
    const state = await deliverFrozenAutomationResultEmail(
      environment(null),
      {
        workspaceId: WORKSPACE_ID,
        automationSubscriptionId: AUTOMATION_ID,
        automationRunId: RUN_ID,
        workstreamId: WORKSTREAM_ID,
        recipientEmail: "author@example.com",
        recipientUserId: AUTHOR_ID,
        title: "Issue watcher",
        text: "Two issues need attention.",
        outcomeStatus: "completed",
      },
      request as unknown as typeof fetch,
    );

    expect(state).toBe("skipped");
    expect(request).not.toHaveBeenCalled();
  });
});
