import { ServerSocketEventSchema, type ToolInvocation } from "@avalon/contracts";
import { describe, expect, it } from "vitest";

import { __integrationTesting } from "../src/services/integrations";
import { createTestD1Database, createTestD1PreparedStatement, createTestD1Result, createTestEnv } from "./helpers/cloudflare-test";

interface StoredToolMessage {
  id: string;
  clientMessageId: string;
  workspaceId: string;
  workstreamId: string;
  sequenceNumber: number;
  structuredContent: string;
  createdAt: string;
  editedAt: string | null;
}

class ToolTranscriptDatabase {
  nextSequenceNumber = 12;
  readonly messages = new Map<string, StoredToolMessage>();

  readonly binding = createTestD1Database({
    prepare: (sql: string) => createTestD1PreparedStatement(new ToolTranscriptStatement(this, sql)),
    batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
      const results: D1Result<T>[] = [];
      for (const statement of statements) results.push(await statement.run<T>());
      return results;
    },
  });
}

class ToolTranscriptStatement {
  private values: unknown[] = [];

  constructor(
    private readonly database: ToolTranscriptDatabase,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): ToolTranscriptStatement {
    this.values = values;
    return this;
  }

  async run<T>(): Promise<D1Result<T>> {
    const normalized = this.sql.replace(/\s+/gu, " ").trim();
    if (normalized.startsWith("INSERT INTO messages")) {
      const id = String(this.values[0]);
      const existing = this.database.messages.get(id);
      if (existing) {
        existing.structuredContent = String(this.values[3]);
        existing.editedAt = this.values[5] == null ? null : String(this.values[5]);
      } else {
        this.database.messages.set(id, {
          id,
          clientMessageId: String(this.values[1]),
          workspaceId: String(this.values[2]),
          workstreamId: String(this.values[6]),
          sequenceNumber: this.database.nextSequenceNumber,
          structuredContent: String(this.values[3]),
          createdAt: String(this.values[4]),
          editedAt: this.values[5] == null ? null : String(this.values[5]),
        });
      }
    } else if (normalized.startsWith("UPDATE workstreams SET next_sequence_number")) {
      const message = this.database.messages.get(String(this.values[3]));
      if (message?.sequenceNumber === this.database.nextSequenceNumber) {
        this.database.nextSequenceNumber += 1;
      }
    } else {
      throw new Error(`Unexpected durable transcript query: ${normalized}`);
    }
    return createTestD1Result<T>({ success: true, results: [], meta: { changes: 1 } });
  }
}

const workspaceId = "00000000-0000-7000-8000-000000000001";
const workstreamId = "00000000-0000-7000-8000-000000000002";
const harnessRunId = "00000000-0000-7000-8000-000000000003";
const invocationId = "00000000-0000-7000-8000-000000000004";

function invocation(status: "started" | "completed"): ToolInvocation {
  return {
    id: invocationId,
    harnessRunId,
    toolCallId: "tool-call-1",
    toolName: "Search evidence",
    activityName: "Search evidence",
    connectionId: null,
    plugin: null,
    status,
    inputSummary: '{"query":"invoice failures"}',
    outputSummary: status === "completed" ? "Found the relevant failures." : null,
    startedAt: "2026-08-01T12:00:01.000Z",
    completedAt: status === "completed" ? "2026-08-01T12:00:04.000Z" : null,
    error: null,
  };
}

describe("durable inline tool transcript", () => {
  it("keeps one canonical sequence while lifecycle and replay updates refresh the same row", async () => {
    const database = new ToolTranscriptDatabase();
    const env = createTestEnv({ DB: database.binding });
    const scope = { workspaceId, workstreamId };

    await __integrationTesting.persistToolTranscriptMessage(env, scope, invocation("started"));
    await __integrationTesting.persistToolTranscriptMessage(env, scope, invocation("completed"));
    await __integrationTesting.persistToolTranscriptMessage(env, scope, invocation("completed"));

    expect(database.nextSequenceNumber).toBe(13);
    expect(database.messages.size).toBe(1);
    const message = database.messages.get(invocationId);
    expect(message).toMatchObject({
      id: invocationId,
      clientMessageId: `tool:${invocationId}`,
      workspaceId,
      workstreamId,
      sequenceNumber: 12,
      createdAt: "2026-08-01T12:00:01.000Z",
      editedAt: "2026-08-01T12:00:04.000Z",
    });
    expect(JSON.parse(message?.structuredContent ?? "{}")).toEqual({
      invocation: invocation("completed"),
    });
  });

  it("keeps replay output exact regardless of serialized size", () => {
    const exactOutput = { body: "x".repeat(3_000), nested: [1, 2, 3] };
    expect(JSON.parse(__integrationTesting.serializeToolReplayOutput(exactOutput))).toEqual({
      replayVersion: 1,
      output: exactOutput,
    });

    const oversized = __integrationTesting.serializeToolReplayOutput({ body: "x".repeat(300_000) });
    expect(new TextEncoder().encode(oversized).byteLength).toBeGreaterThan(300_000);
    expect(JSON.parse(oversized)).toEqual({
      replayVersion: 1,
      output: { body: "x".repeat(300_000) },
    });
  });
});

class SingleRowDatabase {
  sql = "";

  constructor(private readonly row: Record<string, unknown> | null) {}

  readonly binding = createTestD1Database({
    prepare: (sql: string) => {
      this.sql = sql.replace(/\s+/gu, " ").trim();
      return createTestD1PreparedStatement({
        bind: () => ({ first: async () => this.row }),
      });
    },
  });
}

const invocationRow = {
  id: invocationId,
  harness_run_id: harnessRunId,
  tool_call_id: "tool-call-1",
  tool_name: "google_2_drive_search",
  status: "completed",
  input_json: '{"query":"avalon"}',
  output_summary: "Found the authorized Drive folder",
  started_at: "2026-08-01T12:00:01.000Z",
  completed_at: "2026-08-01T12:00:04.000Z",
  error_json: null,
};

describe("tool invocation attribution", () => {
  it("attributes an invocation to the connector that owns its tool", async () => {
    const database = new SingleRowDatabase({
      ...invocationRow,
      connection_id: "00000000-0000-7000-8000-000000000010",
      owner_connector_type: "google",
      owner_display_name: "Google Drive · Work",
      owner_model_plugin_id: "plugin_google_2",
    });
    const env = createTestEnv({ DB: database.binding });

    const loaded = await __integrationTesting.loadToolInvocation(env, harnessRunId, "tool-call-1");

    expect(database.sql).toContain("LEFT JOIN connector_connections owner ON owner.id = invocation.connection_id");
    expect(loaded?.plugin).toEqual({
      pluginId: "plugin_google_2",
      displayName: "Google Drive · Work",
      icon: "brand-google-drive",
    });
    expect(loaded?.activityName).toBe("Searched Google Drive · Work");
  });

  it("leaves an Avalon-owned tool unattributed", async () => {
    const database = new SingleRowDatabase({
      ...invocationRow,
      tool_name: "web_search",
      connection_id: null,
      owner_connector_type: null,
      owner_display_name: null,
      owner_model_plugin_id: null,
    });
    const env = createTestEnv({ DB: database.binding });

    const loaded = await __integrationTesting.loadToolInvocation(env, harnessRunId, "tool-call-1");

    expect(loaded?.connectionId).toBeNull();
    expect(loaded?.plugin).toBeNull();
    expect(loaded?.activityName).toBe("Searched the public web");
  });

  it("refuses to attribute a connection whose model plugin id is unusable", async () => {
    const database = new SingleRowDatabase({
      ...invocationRow,
      connection_id: "00000000-0000-7000-8000-000000000010",
      owner_connector_type: "google",
      owner_display_name: "Google Drive · Work",
      owner_model_plugin_id: "Not-A-Plugin-Id",
    });
    const env = createTestEnv({ DB: database.binding });

    expect((await __integrationTesting.loadToolInvocation(env, harnessRunId, "tool-call-1"))?.plugin).toBeNull();
  });
});

describe("tool invocation failure wording", () => {
  it("words a failed connector row as a failure, not a success", async () => {
    const database = new SingleRowDatabase({
      ...invocationRow,
      status: "failed",
      output_summary: null,
      error_json: JSON.stringify({ code: "provider_error", message: "Drive rejected the request" }),
      connection_id: "00000000-0000-7000-8000-000000000010",
      owner_connector_type: "google",
      owner_display_name: "Google Drive · Work",
      owner_model_plugin_id: "plugin_google_2",
    });
    const env = createTestEnv({ DB: database.binding });

    expect((await __integrationTesting.loadToolInvocation(env, harnessRunId, "tool-call-1"))?.activityName)
      .toBe("Could not reach Google Drive · Work");
  });

  it("keeps settled wording on an ambiguous write, which may still have landed", async () => {
    const database = new SingleRowDatabase({
      ...invocationRow,
      status: "ambiguous",
      connection_id: "00000000-0000-7000-8000-000000000010",
      owner_connector_type: "google",
      owner_display_name: "Google Drive · Work",
      owner_model_plugin_id: "plugin_google_2",
    });
    const env = createTestEnv({ DB: database.binding });

    expect((await __integrationTesting.loadToolInvocation(env, harnessRunId, "tool-call-1"))?.activityName)
      .toBe("Searched Google Drive · Work");
  });

  it("leaves a row unattributed when the connector name is blank", async () => {
    const database = new SingleRowDatabase({
      ...invocationRow,
      connection_id: "00000000-0000-7000-8000-000000000010",
      owner_connector_type: "google",
      owner_display_name: "   ",
      owner_model_plugin_id: "plugin_google_2",
    });
    const env = createTestEnv({ DB: database.binding });

    const loaded = await __integrationTesting.loadToolInvocation(env, harnessRunId, "tool-call-1");
    expect(loaded?.plugin).toBeNull();
    expect(loaded?.activityName).toBe("Google 2 drive search");
  });
});

describe("the frame that announces a settled narration row", () => {
  it("is a message the socket contract accepts", () => {
    // The room drops a frame that fails the contract, best-effort and silently:
    // every settle would vanish, the live transcript would go back to reading as
    // one block at the end, and every test of this change would still pass. The
    // other producer of this shape reads the row back through the repository;
    // this one builds it by hand, so the contract is asserted against the
    // function rather than against a copy of it written in a test.
    const frame = {
      type: "stream_completed" as const,
      sequence: 42,
      occurredAt: "2026-08-14T19:20:00.000Z",
      message: __integrationTesting.settledNarrationMessage(
        { workspaceId, workstreamId },
        {
          id: invocationId,
          sequenceNumber: 12,
          text: "Searching the repository.",
          createdAt: "2026-08-14T19:19:59.000Z",
        },
        `harness:${harnessRunId}:segment:0`,
      ),
    };

    const parsed = ServerSocketEventSchema.parse(frame);
    expect(parsed.type).toBe("stream_completed");
    if (parsed.type !== "stream_completed") throw new Error("expected a stream_completed frame");
    expect(parsed.message.textContent).toBe("Searching the repository.");
    expect(parsed.message.sequenceNumber).toBe(12);
    // The reader groups on this, and every window that counts what a work
    // stream has said filters on it.
    expect(parsed.message.narration).toBe(true);
  });
});
