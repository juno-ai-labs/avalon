import { describe, expect, it } from "vitest";

import { cloudflareWorkflowInstanceId } from "../src/lib/cloudflare-workflow-instance-id";

const CLOUDFLARE_WORKFLOW_INSTANCE_ID = /^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/u;

describe("cloudflareWorkflowInstanceId", () => {
  it("derives a stable fixed-alphabet ID from the complete typed identity", async () => {
    const eventId = "00000000-0000-7000-8000-0000000000f1";

    await expect(cloudflareWorkflowInstanceId("connector-event", eventId, 0)).resolves.toBe(
      "wf_e50ed5703ecd469340b1f1e466a913f9e5a8f563653264ec3ae8a7c00d90f8e9",
    );
    await expect(cloudflareWorkflowInstanceId("connector-event", eventId, 0)).resolves.toHaveLength(67);
  });

  it("keeps arbitrary provider bytes out of the external identifier", async () => {
    const hostileParts = [
      "google:calendar:event/with spaces",
      "../../../other-workflow",
      "cf_" + "a".repeat(64),
      "emoji-🚀-and-\n-newline",
      "x".repeat(10_000),
    ];

    for (const part of hostileParts) {
      const id = await cloudflareWorkflowInstanceId("connector-event", part, 5);
      expect(id).toMatch(CLOUDFLARE_WORKFLOW_INSTANCE_ID);
      expect(id).toHaveLength(67);
      expect(id).not.toContain(part);
    }
  });

  it("does not collapse identity-part boundaries or value types", async () => {
    const ids = await Promise.all([
      cloudflareWorkflowInstanceId("connector-event", "ab", "c"),
      cloudflareWorkflowInstanceId("connector-event", "a", "bc"),
      cloudflareWorkflowInstanceId("connector-event", "1"),
      cloudflareWorkflowInstanceId("connector-event", 1),
    ]);

    expect(new Set(ids)).toHaveLength(ids.length);
  });
});
