import { asWorkspaceId, asWorkstreamId } from "@avalon/contracts";
import type { ToolInvocation } from "@avalon/contracts";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { ToolReceiptObjectPort } from "../src/durable-objects/workstream-tool-receipt-protocol";
import type { ToolReceiptRecord } from "../src/durable-objects/workstream-tool-receipt-storage";
import { __integrationTesting } from "../src/services/integrations";
import { createTestD1Database, createTestD1PreparedStatement, createTestEnv } from "./helpers/cloudflare-test";
import {
  seedWorkstreamObjectRoot,
  testSubstreamAgentsBinding,
  testWorkstreamObjectStore,
} from "./helpers/durable-authority";

const workspaceId = asWorkspaceId("00000000-0000-7000-8000-000000000001");
const workstreamId = asWorkstreamId("00000000-0000-7000-8000-000000000002");
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

const openStores: DatabaseSync[] = [];

afterEach(() => {
  while (openStores.length > 0) openStores.pop()?.close();
});

/** An object store holding one work stream, with its sequence counter advanced. */
function transcriptObjectStore(nextSequenceNumber: number): DatabaseSync {
  const store = testWorkstreamObjectStore();
  openStores.push(store);
  seedWorkstreamObjectRoot(store, { workspaceId, workstreamId });
  store.prepare(`UPDATE workstream SET next_sequence_number = ? WHERE id = 1`)
    .run(nextSequenceNumber);
  return store;
}

interface StoredToolPart extends Record<string, string | number | null> {
  id: string;
  client_message_id: string;
  sequence_number: number;
  message_type: string;
  structured_content_json: string;
  created_at: number;
  edited_at: number | null;
}

describe("durable inline tool transcript", () => {
  it("keeps one canonical sequence while lifecycle and replay updates refresh the same row", async () => {
    const store = transcriptObjectStore(12);
    const env = createTestEnv({
      SUBSTREAM_AGENTS: testSubstreamAgentsBinding(store),
      AVALON_REGION: "global",
    });
    const scope = { workspaceId, workstreamId };

    await __integrationTesting.persistToolTranscriptMessage(env, scope, invocation("started"));
    await __integrationTesting.persistToolTranscriptMessage(env, scope, invocation("completed"));
    await __integrationTesting.persistToolTranscriptMessage(env, scope, invocation("completed"));

    // One row, one sequence position, and the counter moved exactly once — the
    // two refreshes rewrote the card rather than taking a new position.
    const parts = store.prepare(`SELECT * FROM parts`).all() as StoredToolPart[];
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      id: invocationId,
      client_message_id: `tool:${invocationId}`,
      sequence_number: 12,
      message_type: "tool",
      created_at: Date.parse("2026-08-01T12:00:01.000Z"),
      edited_at: Date.parse("2026-08-01T12:00:04.000Z"),
    });
    expect(JSON.parse(parts[0]!.structured_content_json)).toEqual({
      invocation: invocation("completed"),
    });
    const root = store.prepare(
      `SELECT next_sequence_number, next_attention_ordinal FROM workstream WHERE id = 1`,
    ).get() as { next_sequence_number: number; next_attention_ordinal: number };
    expect(root.next_sequence_number).toBe(13);
    // A tool card is machinery a member did not do, so it takes no attention
    // ordinal — the retired insert trigger drew that line, and the object keeps it.
    expect(root.next_attention_ordinal).toBe(1);
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

/**
 * Only the connector lookup reaches D1 now.
 *
 * `loadToolInvocation` used to be one statement against a compatibility view,
 * with attribution either joined in or fetched separately depending on whether
 * `WORKSPACE_DOS` was bound. The join arm is deleted — the two tables live in
 * different Durable Objects and nothing can join them — so attribution is
 * always its own workspace-authority read, and the receipt itself comes through
 * the typed port. What these tests are about is unchanged: what the projection
 * makes of the two answers.
 */
class ConnectorLookup {
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

const receiptRecord: ToolReceiptRecord = {
  effectIntentId: invocationId,
  runId: harnessRunId,
  toolCallId: "tool-call-1",
  toolName: "google_2_drive_search",
  mode: "read",
  connectionId: null,
  requestHash: "request-hash",
  inputJson: '{"query":"avalon"}',
  status: "completed",
  outputRef: null,
  outputSummary: "Found the authorized Drive folder",
  providerOperationId: null,
  errorJson: null,
  executionPlanHash: null,
  executionPlanJson: null,
  startedAt: Date.parse("2026-08-01T12:00:01.000Z"),
  settledAt: Date.parse("2026-08-01T12:00:04.000Z"),
  checkpointIndex: 0,
};

/** Run the projection over one receipt and one connector row. */
async function project(
  receipt: Partial<ToolReceiptRecord>,
  owner: Record<string, unknown> | null,
): Promise<{ loaded: ToolInvocation | null; lookup: ConnectorLookup }> {
  const lookup = new ConnectorLookup(owner);
  const port = {
    receiptForCall: async () => ({ ...receiptRecord, ...receipt }),
  } satisfies Pick<ToolReceiptObjectPort, "receiptForCall">;
  const loaded = await __integrationTesting.loadToolInvocation(
    createTestEnv({ DB: lookup.binding }),
    { workspaceId, workstreamId, harnessRunId },
    "tool-call-1",
    port,
  );
  return { loaded, lookup };
}

const CONNECTION_ID = "00000000-0000-7000-8000-000000000010";
const driveOwner = {
  connector_type: "google",
  display_name: "Google Drive · Work",
  model_plugin_id: "plugin_google_2",
};

describe("tool invocation attribution", () => {
  it("attributes an invocation to the connector that owns its tool", async () => {
    const { loaded, lookup } = await project({ connectionId: CONNECTION_ID }, driveOwner);

    // Attribution is a read of its own, against the workspace's connector
    // table — not a join, which is no longer expressible across the boundary.
    expect(lookup.sql).toContain("FROM connector_connections WHERE id = ?");
    expect(loaded?.plugin).toEqual({
      pluginId: "plugin_google_2",
      displayName: "Google Drive · Work",
      icon: "brand-google-drive",
    });
    expect(loaded?.activityName).toBe("Searched Google Drive · Work");
  });

  it("leaves an Avalon-owned tool unattributed", async () => {
    const { loaded, lookup } = await project(
      { toolName: "web_search", connectionId: null },
      driveOwner,
    );

    expect(loaded?.connectionId).toBeNull();
    expect(loaded?.plugin).toBeNull();
    expect(loaded?.activityName).toBe("Searched the public web");
    // A receipt with no connection must not spend a round trip asking who owns
    // it. The routed version got this free from a LEFT JOIN; here it is a
    // decision, so it is asserted.
    expect(lookup.sql).toBe("");
  });

  it("refuses to attribute a connection whose model plugin id is unusable", async () => {
    const { loaded } = await project(
      { connectionId: CONNECTION_ID },
      { ...driveOwner, model_plugin_id: "Not-A-Plugin-Id" },
    );

    expect(loaded?.plugin).toBeNull();
  });

  it("leaves a receipt unattributed when its connection is gone", async () => {
    const { loaded } = await project({ connectionId: CONNECTION_ID }, null);

    expect(loaded?.plugin).toBeNull();
  });

  it("translates the object's statuses and timestamps to the published shape", async () => {
    // The compatibility view did this remap in SQL; it now happens here,
    // because `ToolInvocationSchema` publishes `pending`/`started` and ISO-8601
    // and the object stores neither.
    expect((await project({ status: "admitted" }, null)).loaded?.status).toBe("pending");
    expect((await project({ status: "executing" }, null)).loaded?.status).toBe("started");
    const { loaded } = await project({}, null);
    expect(loaded?.startedAt).toBe("2026-08-01T12:00:01.000Z");
    expect(loaded?.completedAt).toBe("2026-08-01T12:00:04.000Z");
  });

  it("returns nothing when the object holds no receipt for the call", async () => {
    const lookup = new ConnectorLookup(null);
    const port = {
      receiptForCall: async () => null,
    } satisfies Pick<ToolReceiptObjectPort, "receiptForCall">;

    expect(await __integrationTesting.loadToolInvocation(
      createTestEnv({ DB: lookup.binding }),
      { workspaceId, workstreamId, harnessRunId },
      "tool-call-1",
      port,
    )).toBeNull();
  });
});

describe("tool invocation failure wording", () => {
  it("words a failed connector row as a failure, not a success", async () => {
    const { loaded } = await project({
      status: "failed",
      outputSummary: null,
      errorJson: JSON.stringify({ code: "provider_error", message: "Drive rejected the request" }),
      connectionId: CONNECTION_ID,
    }, driveOwner);

    expect(loaded?.activityName).toBe("Could not reach Google Drive · Work");
  });

  it("keeps settled wording on an ambiguous write, which may still have landed", async () => {
    const { loaded } = await project(
      { status: "ambiguous", connectionId: CONNECTION_ID },
      driveOwner,
    );

    expect(loaded?.activityName).toBe("Searched Google Drive · Work");
  });

  it("leaves a row unattributed when the connector name is blank", async () => {
    const { loaded } = await project(
      { connectionId: CONNECTION_ID },
      { ...driveOwner, display_name: "   " },
    );

    expect(loaded?.plugin).toBeNull();
    expect(loaded?.activityName).toBe("Google 2 drive search");
  });
});
