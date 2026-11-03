/**
 * The one way onto the interactive queue: `sendInteractive` carries a
 * registered kind, with its delay, and refuses anything else before it
 * reaches a queue whose consumer could not read it.
 */
import { describe, expect, it, vi } from "vitest";

import { sendInteractive } from "../src/services/interactive-queue";
import { createCloudflareTestBinding } from "./helpers/cloudflare-test";

const WORKSPACE = "00000000-0000-7000-8000-0000000000a1";

function queue() {
  const send = vi.fn(async () => undefined);
  return { send, env: { INTERACTIVE_QUEUE: createCloudflareTestBinding<Queue>({ send }) } };
}

describe("sendInteractive", () => {
  it("carries a registered kind, and its delay when one is asked for", async () => {
    const { send, env } = queue();
    const job = { kind: "slack_ingress", region: "global", workspaceId: WORKSPACE, jobId: "event:Ev1" } as const;

    await sendInteractive(env, job);
    await sendInteractive(env, job, { delaySeconds: 30 });

    expect(send.mock.calls).toEqual([
      [{ kind: "slack_ingress", region: "global", workspaceId: WORKSPACE, jobId: "event:Ev1" }],
      [{ kind: "slack_ingress", region: "global", workspaceId: WORKSPACE, jobId: "event:Ev1" }, { delaySeconds: 30 }],
    ]);
  });

  it("refuses a kind nothing on the queue handles, and sends nothing", async () => {
    const { send, env } = queue();
    const unregistered = { kind: "linear_agent_session", region: "global", workspaceId: WORKSPACE };

    // @ts-expect-error The compiler refuses it too; this is the runtime check behind that.
    await expect(sendInteractive(env, unregistered)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});
