import { describe, expect, it } from "vitest";

import type { PushDeliveryMessage } from "@rally/contracts/push-notifications";
import { enqueueNotice } from "../src/services/push-delivery-service";
import { createCloudflareTestBinding, createTestEnv } from "./helpers/cloudflare-test";

/** A deployment that can queue but has no push transport, so a push is never queued. */
function noPushEnv(sent: unknown[]) {
  return createTestEnv({
    AVALON_REGION: "global",
    PUSH_DELIVERY_QUEUE: createCloudflareTestBinding<Queue<PushDeliveryMessage>>({ send: async (message: unknown) => { sent.push(message); } }),
  });
}

const address = { workspaceId: "00000000-0000-4000-8000-0000000000b1", recipientUserId: "00000000-0000-4000-8000-0000000000b2", intentId: "intent-1" };

describe("enqueueNotice", () => {
  it("sends email when both are chosen and no push could be queued, once either way", async () => {
    const sent: unknown[] = [];
    expect(await enqueueNotice(noPushEnv(sent), address, ["push", "email"], { pushElseEmail: true })).toBe(true);
    expect(sent).toEqual([{ region: "global", ...address, channel: "email" }]);
  });

  it("sends nothing by email when push alone is chosen, whatever pushElseEmail says", async () => {
    const sent: unknown[] = [];
    expect(await enqueueNotice(noPushEnv(sent), address, ["push"], { pushElseEmail: true })).toBe(false);
    expect(sent).toEqual([]);
  });
});
