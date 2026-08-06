import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { SlackAgentService } from "../src/services/slack-agent-service";

interface Job {
  id: string;
  bodyHash: string;
  status: string;
}

class IngressStatement {
  private values: unknown[] = [];
  constructor(private readonly database: IngressDatabase, private readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values; return this; }
  first<T>() { return this.database.first(this.sql, this.values) as Promise<T | null>; }
  run<T>() { return this.database.run(this.sql, this.values) as Promise<D1Result<T>>; }
}

class IngressDatabase {
  readonly jobs = new Map<string, Job>();
  prepare(sql: string) { return new IngressStatement(this, sql); }

  async first(sql: string, values: unknown[]) {
    if (sql.includes("FROM connector_connections") && sql.includes("provider_account_id = ?")) {
      return {
        id: "11111111-1111-4111-8111-111111111111",
        workspace_id: "22222222-2222-4222-8222-222222222222",
        provider_account_id: String(values[0]),
        encrypted_credentials: "encrypted",
        credential_iv: "iv",
        status: "healthy",
      };
    }
    if (sql.includes("SELECT body_hash, status FROM slack_ingress_jobs")) {
      const job = this.jobs.get(String(values[0]));
      return job ? { body_hash: job.bodyHash, status: job.status } : null;
    }
    throw new Error(`Unexpected first query: ${sql}`);
  }

  async run(sql: string, values: unknown[]) {
    if (sql.includes("INSERT INTO slack_ingress_jobs")) {
      const id = String(values[0]);
      if (this.jobs.has(id)) return result(0);
      this.jobs.set(id, { id, bodyHash: String(values[4]), status: "queued" });
      return result(1);
    }
    throw new Error(`Unexpected run query: ${sql}`);
  }
}

describe("Slack Agent durable ingress", () => {
  it("returns modal field errors synchronously", async () => {
    const service = new SlackAgentService({ AVALON_REGION: "global" } as Env);
    await expect(service.processInteraction({
      type: "view_submission",
      team: { id: "T1" },
      user: { id: "U1" },
      view: {
        id: "V1",
        callback_id: "avalon_start_task_submit",
        state: { values: { prompt: { value: { value: "" } } } },
      },
    }, "body-hash")).resolves.toEqual({
      response_action: "errors",
      errors: { prompt: "Describe what Avalon should do." },
    });
  });

  it("does not acknowledge an event until its regional queue publish succeeds", async () => {
    const database = new IngressDatabase();
    let releaseQueue!: () => void;
    const send = vi.fn(() => new Promise<void>((resolve) => { releaseQueue = resolve; }));
    const service = new SlackAgentService(environment(database, send));
    let settled = false;
    const operation = service.processEvent(eventPayload(), "body-hash").then((value) => {
      settled = true;
      return value;
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    expect(send).toHaveBeenCalledWith({
      kind: "slack_ingress",
      region: "global",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      jobId: "event:Ev1",
    });
    releaseQueue();
    await expect(operation).resolves.toEqual({ ok: true });
  });

  it("deduplicates completed events without publishing another queue message", async () => {
    const database = new IngressDatabase();
    database.jobs.set("event:Ev1", { id: "event:Ev1", bodyHash: "body-hash", status: "completed" });
    const send = vi.fn(async () => undefined);
    const service = new SlackAgentService(environment(database, send));

    await expect(service.processEvent(eventPayload(), "body-hash"))
      .resolves.toEqual({ ok: true, duplicate: true });
    expect(send).not.toHaveBeenCalled();
  });
});

function eventPayload() {
  return {
    type: "event_callback",
    api_app_id: "A1",
    team_id: "T1",
    event_id: "Ev1",
    event: { type: "message", user: "U1", channel: "D1", ts: "1.1", text: "hello" },
  };
}

function environment(database: IngressDatabase, send: (body: unknown) => Promise<void>): Env {
  return {
    DB: database as unknown as D1Database,
    ACTIVITY_QUEUE: { send } as unknown as Queue,
    AVALON_REGION: "global",
    SLACK_APP_ID: "A1",
  } as Env;
}

function result<T = unknown>(changes: number): D1Result<T> {
  return { success: true, results: [], meta: { changes } as D1Meta & Record<string, unknown> };
}
