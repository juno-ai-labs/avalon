import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { ScheduledAlarm } from "../src/durable-objects/scheduled-alarms";
import { WorkspaceDO } from "../src/durable-objects/workspace-do";
import {
  createCloudflareTestBinding,
  createTestEnv,
  createTestJurisdictionalDurableObjectId,
} from "./helpers/cloudflare-test";
import { createTestSqlStorage } from "./helpers/sql-storage";

// Not credential-shaped: Gitleaks' Slack token rules want digit groups.
const BOT_TOKEN = "xoxb-ops-test";
const CHANNEL_ID = "C0OPSTEST";
const WORKSPACE_ID = "00000000-0000-7000-8000-0000000000a1";

const databases: DatabaseSync[] = [];

/**
 * A WorkspaceDO over node:sqlite, the way `digest-run.test.ts` boots one. The
 * stall hook itself is pure policy over a logger and a webhook post — which
 * attempt warns, which errors, which one notifies — so the Node suite is the
 * right rung; the gate that calls it is proved on workerd in
 * `test-workers/scheduled-alarms.test.ts`.
 */
async function bootWorkspace(): Promise<{
  stalled: (alarm: ScheduledAlarm, attempt: number) => void;
  failed: (alarm: ScheduledAlarm, error: unknown, attempt: number) => void;
  settled: () => Promise<void>;
}> {
  const doDatabase = new DatabaseSync(":memory:");
  databases.push(doDatabase);
  const pending: Promise<unknown>[] = [];
  const storage = createCloudflareTestBinding<DurableObjectStorage>({
    getAlarm: async () => null,
    setAlarm: async () => undefined,
    deleteAlarm: async () => undefined,
    transactionSync: <T,>(body: () => T) => body(),
    sql: createTestSqlStorage(doDatabase),
  });
  vi.stubGlobal("WebSocketRequestResponsePair", class {
    constructor(readonly request: string, readonly response: string) {}
  });
  const instance = new WorkspaceDO(
    createCloudflareTestBinding<DurableObjectState>({
      // A deployed region asserts its jurisdiction on construction; the
      // notifier posts nowhere else, so the test has to be one.
      id: createTestJurisdictionalDurableObjectId("workspace-do", "us"),
      blockConcurrencyWhile: async <T,>(body: () => Promise<T>) => body(),
      setWebSocketAutoResponse: () => undefined,
      waitUntil: (promise: Promise<unknown>) => { pending.push(promise); },
      storage,
    }),
    createTestEnv({
      AVALON_REGION: "global",
      // A deployed region: the notifier deliberately posts nothing elsewhere.
      APP_ENV: "production",
      LOG_LEVEL: "warn",
      OPS_SLACK_BOT_TOKEN: BOT_TOKEN,
      OPS_SLACK_CHANNEL_ID: CHANNEL_ID,
    }),
  );
  await (instance as unknown as { initialized: Promise<void> }).initialized;
  doDatabase.prepare(
    `INSERT INTO workspace_identity
       (id, workspace_id, region, placement_affinity, created_at, updated_at)
     VALUES (1, ?, 'global', 'wnam', 0, 0)`,
  ).run(WORKSPACE_ID);
  const hooks = instance as unknown as {
    onScheduledAlarmStalled(alarm: ScheduledAlarm, attempt: number): void;
    onScheduledAlarmFailure(alarm: ScheduledAlarm, error: unknown, attempt: number): void;
  };
  return {
    stalled: (alarm, attempt) => hooks.onScheduledAlarmStalled(alarm, attempt),
    failed: (alarm, error, attempt) => hooks.onScheduledAlarmFailure(alarm, error, attempt),
    settled: async () => { await Promise.all(pending); },
  };
}

function attemptsLogged(spy: { mock: { calls: unknown[][] } }, event: string): number[] {
  return spy.mock.calls
    .map((call) => call[0] as { event?: unknown; attempt?: unknown })
    .filter((entry) => entry.event === event)
    .map((entry) => Number(entry.attempt));
}

const ALARM: ScheduledAlarm = {
  kind: "maintenance",
  key: "slack_ingress",
  dueAt: Date.parse("2026-08-22T17:41:00.000Z"),
  repeatEveryMs: null,
  retryAt: 0,
  attempt: 0,
  payload: null,
};

/** Every `chat.postMessage` the notifier sends, by the text it carried. */
function capturePosts(): string[] {
  const posted: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("https://slack.com/api/chat.postMessage");
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${BOT_TOKEN}`);
    const body = JSON.parse(String(init?.body)) as { channel: string; text: string };
    expect(body.channel).toBe(CHANNEL_ID);
    posted.push(body.text);
    return new Response(JSON.stringify({ ok: true }));
  }));
  return posted;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});

describe("a workspace alarm target the gate is holding", () => {
  it("warns for the first stalls, errors from the third, and notifies exactly once", async () => {
    const posted = capturePosts();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failure = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const workspace = await bootWorkspace();

    for (const attempt of [1, 2, 3, 4, 5]) workspace.stalled(ALARM, attempt);
    await workspace.settled();

    expect(attemptsLogged(warning, "workspace_scheduled_alarm_stalled")).toEqual([1, 2]);
    expect(attemptsLogged(failure, "workspace_scheduled_alarm_stalled")).toEqual([3, 4, 5]);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("*[global]* `workspace_scheduled_alarm_stalled`");
    expect(posted[0]).toContain(`• workspace_id: ${WORKSPACE_ID}`);
    expect(posted[0]).toContain("• alarm_kind: maintenance");
    expect(posted[0]).toContain("• alarm_key: slack_ingress");
    expect(posted[0]).toContain("• attempt: 3");
    expect(posted[0]).toContain("• due_at: 2026-08-22T17:41:00.000Z");
  });

  it("reports a target that keeps throwing on the same terms", async () => {
    const posted = capturePosts();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failure = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const workspace = await bootWorkspace();

    for (const attempt of [1, 2, 3, 4]) workspace.failed(ALARM, new Error("r2_delete_failed"), attempt);
    await workspace.settled();

    expect(attemptsLogged(warning, "workspace_scheduled_alarm_failed")).toEqual([1, 2]);
    expect(attemptsLogged(failure, "workspace_scheduled_alarm_failed")).toEqual([3, 4]);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("`workspace_scheduled_alarm_failed`");
    expect(posted[0]).toContain("• code: r2_delete_failed");
  });

  it("carries a thrown message to the channel only when it has the shape of a code", async () => {
    // A handler can throw a Zod issue list, a parse error quoting a row, or a
    // provider SDK's prose. The log row keeps the message; the notice gets a
    // code or the error's class, and nothing that Slack would read as markup.
    const posted = capturePosts();
    const failure = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const workspace = await bootWorkspace();

    for (const attempt of [1, 2, 3]) {
      workspace.failed(ALARM, new SyntaxError('<!channel> {"received": "user"} is not valid JSON'), attempt);
    }
    await workspace.settled();

    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("• code: handler_error:SyntaxError");
    expect(posted[0]).not.toContain("<!channel>");
    expect(posted[0]).not.toContain("received");
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({
      event: "workspace_scheduled_alarm_failed",
      attempt: 3,
      code: '<!channel> {"received": "user"} is not valid JSON',
    }));
  });

  it("names the field a handler's schema rejection rejected, and not the value", async () => {
    // A stored definition parsed against a schema that has since moved throws
    // a `ZodError` inside the handler, issues intact. Its message is a JSON
    // blob the notice refuses, so the channel read `handler_error:ZodError` —
    // the class and nothing else. The path is schema shape and crosses; the
    // rejected value is member content and does not.
    const posted = capturePosts();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const workspace = await bootWorkspace();
    const rejection = z.strictObject({
      triggers: z.array(z.strictObject({ connectorType: z.enum(["slack", "linear"]) })),
    }).safeParse({ triggers: [{ connectorType: "fireflies <!channel>" }] });
    if (rejection.success) throw new Error("expected a rejection");

    for (const attempt of [1, 2, 3]) workspace.failed(ALARM, rejection.error, attempt);
    await workspace.settled();

    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("• code: handler_error:ZodError:triggers.0.connectorType:invalid_value");
    expect(posted[0]).not.toContain("fireflies");
    expect(posted[0]).not.toContain("<!channel>");
  });

  it("notifies once for an episode that mixes throws and stalls", async () => {
    // The attempt counter is shared: a throw that lands on the third attempt
    // must not swallow the notice, and a stall after it must not add one.
    const posted = capturePosts();
    const workspace = await bootWorkspace();

    workspace.stalled(ALARM, 1);
    workspace.failed(ALARM, new Error("terminal_provider_unavailable"), 2);
    workspace.failed(ALARM, new Error("terminal_provider_unavailable"), 3);
    workspace.stalled(ALARM, 4);
    await workspace.settled();

    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("`workspace_scheduled_alarm_failed`");
    expect(posted[0]).toContain("• attempt: 3");
  });
});
