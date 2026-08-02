import type { ToolInvocation } from "@avalon/contracts";
import { describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import { __integrationTesting } from "../src/services/integrations";

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

  readonly binding = {
    prepare: (sql: string) => new ToolTranscriptStatement(this, sql) as unknown as D1PreparedStatement,
    batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
      const results: D1Result<T>[] = [];
      for (const statement of statements) results.push(await statement.run<T>());
      return results;
    },
  } as unknown as D1Database;
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
    return { success: true, results: [], meta: { changes: 1 } } as unknown as D1Result<T>;
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
    connectionId: null,
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
    const env = { DB: database.binding } as unknown as Env;
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

  it("keeps replay output exact within the bound and marks oversized previews", () => {
    const exactOutput = { body: "x".repeat(3_000), nested: [1, 2, 3] };
    expect(JSON.parse(__integrationTesting.serializeToolReplayOutput(exactOutput))).toEqual({
      replayVersion: 1,
      output: exactOutput,
    });

    const oversized = __integrationTesting.serializeToolReplayOutput({ body: "x".repeat(300_000) });
    expect(new TextEncoder().encode(oversized).byteLength).toBeLessThanOrEqual(256_000);
    expect(JSON.parse(oversized)).toMatchObject({
      replayVersion: 1,
      output: { truncated: true },
    });
  });
});
