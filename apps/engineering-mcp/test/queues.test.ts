import { afterEach, expect, it, vi } from "vitest";
import { inspectQueues, peekDeadLetters } from "../src/queues";

const env = { CLOUDFLARE_ACCOUNT_ID: "account", QUEUES_API_TOKEN: "queue-token" };
afterEach(() => vi.restoreAllMocks());

it("keeps queue identities and named failures when one metrics request fails", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/bad/metrics")) return new Response("upstream unavailable", { status: 502 });
    return Response.json({ success: true, result: url.includes("/good/metrics") ? { backlog_count: 7 } : [
      { queue_id: "bad", queue_name: "jobs", consumers: [{ dead_letter_queue: "failed" }] },
      { queue_id: "good", queue_name: "failed" },
    ] });
  });
  expect(await inspectQueues(env, false)).toEqual([
    { id: "bad", name: "jobs", sourceQueues: [], metrics: null, metricsError: "queue_metrics_failed:http_502" },
    { id: "good", name: "failed", sourceQueues: ["jobs"], metrics: { backlog_count: 7 } },
  ]);
});

it("names a non-JSON inventory failure instead of throwing a JSON syntax error", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("proxy error", { status: 503 }));
  await expect(inspectQueues(env, false)).rejects.toMatchObject({ code: "queue_list_failed:http_503" });
});

it("peeks with no JSON content type or body and never pulls or acknowledges", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input); calls.push({ url, init });
    return Response.json({ success: true, result: url.includes("/messages/peek") ? { messages: [{ id: "m1" }] } : [
      { queue_id: "source", queue_name: "jobs", consumers: [{ dead_letter_queue: "failed" }] },
      { queue_id: "dlq", queue_name: "failed" },
    ] });
  });
  expect(await peekDeadLetters(env, "dlq")).toEqual({ messages: [{ id: "m1" }] });
  const posts = calls.filter((c) => c.init?.method === "POST");
  expect(posts).toHaveLength(1);
  expect(posts[0]!.url).toBe("https://api.cloudflare.com/client/v4/accounts/account/queues/dlq/messages/peek");
  expect(new Headers(posts[0]!.init?.headers).has("content-type")).toBe(false);
  expect(posts[0]!.init?.body).toBeUndefined();
});
