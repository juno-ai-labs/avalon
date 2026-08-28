import { asHarnessRunId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { WorkstreamWorkflowInput } from "@rally/contracts";
import type { Env } from "../src/env";
import { __integrationTesting } from "../src/services/integrations";
import { NoteService } from "../src/services/note-service";
import { withWorkstreamRuntimeDatabase } from "../src/services/workstream-runtime-database";
import { createCloudflareTestBinding, createTestEnv } from "./helpers/cloudflare-test";
import {
  executeWorkstreamObjectSql,
  seedWorkstreamObjectRoot,
  testSubstreamAgentsBinding,
  testWorkstreamObjectStore,
  workstreamObjectGet,
  workstreamObjectRun,
  workstreamObjectRootRow,
} from "./helpers/durable-authority";
import { legacyProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { applyWorkspaceResourceSchema } from "./helpers/workspace-object-tables";

const USER_ID = asUserId("00000000-0000-4000-8000-000000000000");
const WORKSPACE_ID = asWorkspaceId("00000000-0000-4000-8000-000000000001");
const WORKSTREAM_ID = asWorkstreamId("00000000-0000-4000-8000-000000000002");
const HARNESS_RUN_ID = asHarnessRunId("00000000-0000-4000-8000-000000000003");

/**
 * The `PAYLOADS` binding the tools under test need in order to construct, kept
 * behaviourally honest so a read finds whatever a fixture put there. It also
 * carried put-recording and a timeout injector for `create_artifact`, the one
 * provider-key tool that wrote an object before its row; nothing here writes R2
 * any more, so asserting on puts would only be asserting on this class.
 */
class MemoryBucket {
  private readonly objects = new Map<string, string | ArrayBuffer>();

  async put(key: string, value: string | ArrayBuffer): Promise<void> {
    this.objects.set(key, value);
  }

  async get(key: string): Promise<{ text: () => Promise<string>; arrayBuffer: () => Promise<ArrayBuffer> } | null> {
    const value = this.objects.get(key);
    if (value === undefined) return null;
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
    return {
      text: async () => new TextDecoder().decode(bytes),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

const openDatabases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

function fixture(): { database: DatabaseSync; objectStore: DatabaseSync; baseEnv: Env; env: Env } {
  const database = legacyProductSqliteDatabase();
  openDatabases.push(database);
  // The resource tools project the alias WorkspaceDO keeps beside each UUID.
  applyWorkspaceResourceSchema(database, WORKSPACE_ID);
  database.exec(`
    INSERT INTO users
      (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${USER_ID}', 'google-core-tool', 'core-tool@example.com', 'Core Tool', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces
      (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${WORKSPACE_ID}', 'Core Tool', 'core-tool', 'global', '${USER_ID}', '2026-01-01', '2026-01-01');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id,
       harness_status, last_activity_at, created_at, updated_at)
    VALUES ('${WORKSTREAM_ID}', '${WORKSPACE_ID}', 'Core Tool', 'Core Tool', 'ad_hoc', '${USER_ID}',
            'running', '2026-01-01', '2026-01-01', '2026-01-01');
  `);
  // The run, transcript, and elicitations live in the work stream's own
  // object since migration 0090; the tools reach them through the runtime
  // router, so the env under test is the routed execution environment the
  // harness hands its tools.
  const objectStore = testWorkstreamObjectStore();
  openDatabases.push(objectStore);
  seedWorkstreamObjectRoot(objectStore, {
    workstreamId: WORKSTREAM_ID,
    workspaceId: WORKSPACE_ID,
    title: "Core Tool",
    description: "Core Tool",
    originType: "ad_hoc",
    createdByUserId: USER_ID,
    exactState: "running",
  });

  workstreamObjectRun(
    objectStore,
    `INSERT INTO harness_runs
      (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
     VALUES (?, ?, ?, 'test', ?, 'running', '2026-08-03')`,
    HARNESS_RUN_ID,
    WORKSPACE_ID,
    WORKSTREAM_ID,
    JSON.stringify({ type: "user", userId: USER_ID }),
  );
  const baseEnv = createTestEnv({
    DB: sqliteD1(database),
    PAYLOADS: createCloudflareTestBinding<R2Bucket>(new MemoryBucket()),
    AVALON_REGION: "global",
    APP_ENV: "test",
    // The elicitation tool's replay check reaches the object through the
    // scheduling port rather than the runtime router, so the fixture needs the
    // binding that port dispatches through — over this same object store.
    SUBSTREAM_AGENTS: testSubstreamAgentsBinding(objectStore),
  });
  return {
    database,
    objectStore,
    baseEnv,
    env: withWorkstreamRuntimeDatabase(
      baseEnv,
      WORKSPACE_ID,
      WORKSTREAM_ID,
      "0",
      async (statements) => executeWorkstreamObjectSql(objectStore, statements),
    ),
  };
}

/**
 * Attach a workspace resource to the work-stream object the way the product
 * attach path does: a link row carrying the frozen descriptor copied from the
 * workspace row. The legacy `workstream_resources` D1 table was dropped by
 * migration 0090 and the compat view over the link table is read-only for
 * inserts — attachment is a product operation, not a runtime SQL write.
 */
function attachResourceLink(
  database: DatabaseSync,
  objectStore: DatabaseSync,
  resourceId: string,
  attachedAt: string,
): void {
  const resource = database.prepare(
    `SELECT id, connection_id, resource_type, provider, provider_resource_id, title,
            mime_type, content_ref, canonical_url, metadata_json
       FROM resources WHERE id = ?`,
  ).get(resourceId) as Record<string, string | null>;
  const at = Date.parse(attachedAt);
  objectStore.prepare(
    `INSERT INTO workstream_resource_links
       (resource_id, attached_by_user_id, watch_enabled, relationship_type, resource_json, attached_at, updated_at)
     VALUES (?, ?, 0, 'context', ?, ?, ?)`,
  ).run(resourceId, USER_ID, JSON.stringify({
    id: resourceId,
    connectionId: resource.connection_id,
    type: resource.resource_type,
    provider: resource.provider,
    providerResourceId: resource.provider_resource_id,
    title: resource.title,
    mimeType: resource.mime_type,
    contentRef: resource.content_ref,
    canonicalUrl: resource.canonical_url,
    metadata: JSON.parse(resource.metadata_json ?? "{}") as Record<string, unknown>,
  }), at, at);
  objectStore.prepare(
    `INSERT INTO resource_inventory_revision(id, revision, updated_at) VALUES (1, 1, ?)
     ON CONFLICT(id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at`,
  ).run(at);
}

function workflowInput(): WorkstreamWorkflowInput {
  return {
    region: "global",
    workspaceId: WORKSPACE_ID,
    workstreamId: WORKSTREAM_ID,
    harnessRunId: HARNESS_RUN_ID,
    triggerMessageId: null,
    automationSubscriptionId: null,
    activityId: null,
    executionPrincipal: { type: "user", userId: USER_ID },
    reason: "Core-tool idempotency test",
  };
}

function context(providerIdempotencyKey?: string) {
  return {
    workspaceId: WORKSPACE_ID,
    workstreamId: WORKSTREAM_ID,
    harnessRunId: HARNESS_RUN_ID,
    toolCallId: providerIdempotencyKey ?? "tool-call-without-provider-key",
    executionPrincipal: { type: "user" as const, userId: USER_ID },
    ...(providerIdempotencyKey ? { providerIdempotencyKey } : {}),
    signal: new AbortController().signal,
  };
}

describe("Avalon core write-tool idempotency", () => {
  it("revokes private note access from workspace-principal resource tools", async () => {
    const { database, objectStore, env } = fixture();
    const noteService = new NoteService(env, {
      sessionId: "note-owner-session",
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      region: "global",
      role: "owner",
    });
    const note = await noteService.create({
      id: "00000000-0000-4000-8000-000000000010",
      title: "Sensitive note",
      scope: "personal",
    });
    attachResourceLink(database, objectStore, note.resourceId, "2026-08-07T18:00:00.000Z");
    const workspaceInput = workflowInput();
    workspaceInput.executionPrincipal = { type: "workspace", workspaceId: WORKSPACE_ID };
    const tools = __integrationTesting.createAvalonTools(env, workspaceInput);
    const listResources = tools.find((tool) => tool.definition.name === "list_resources")!;
    const readResource = tools.find((tool) => tool.definition.name === "read_resource")!;

    await expect(listResources.execute({}, context())).resolves.toMatchObject({
      output: { items: [], totalVisibleResources: 0 },
    });
    await expect(readResource.execute({ resourceId: note.resourceId }, context()))
      .rejects.toMatchObject({ code: "resource_not_found" });

    await noteService.update(note.id, { scope: "workspace" });
    const visible = await listResources.execute({}, context());
    expect(visible.output).toMatchObject({
      items: [expect.objectContaining({ resourceId: note.resourceId, title: "Sensitive note" })],
    });
    await expect(readResource.execute({ resourceId: note.resourceId }, context()))
      .resolves.toMatchObject({ output: expect.objectContaining({ title: "Sensitive note" }) });

    await noteService.update(note.id, { scope: "personal" });
    await expect(readResource.execute({ resourceId: note.resourceId }, context()))
      .rejects.toMatchObject({ code: "resource_not_found" });

    const ownerReadResource = __integrationTesting.createAvalonTools(env, workflowInput())
      .find((tool) => tool.definition.name === "read_resource")!;
    await expect(ownerReadResource.execute({ resourceId: note.resourceId }, context()))
      .resolves.toMatchObject({ output: expect.objectContaining({ title: "Sensitive note" }) });

    database.prepare("UPDATE notes SET archived_at = ? WHERE id = ?")
      .run("2026-08-07T19:00:00.000Z", note.id);
    await expect(ownerReadResource.execute({ resourceId: note.resourceId }, context()))
      .rejects.toMatchObject({ code: "resource_not_found" });
  });

  it("returns easy-English current time in the user's configured timezone", async () => {
    const { database, env } = fixture();
    database.prepare("UPDATE users SET timezone = ? WHERE id = ?")
      .run("America/New_York", USER_ID);
    database.prepare("UPDATE workspaces SET timezone = ? WHERE id = ?")
      .run("Europe/London", WORKSPACE_ID);
    const tool = __integrationTesting.createAvalonTools(env, workflowInput())
      .find((candidate) => candidate.definition.name === "current_time");

    expect(tool?.definition).toMatchObject({
      capability: "time.read",
      mode: "read",
      idempotency: "safe",
    });
    const result = await tool!.execute({}, context());
    const lines = String(result.output).split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/^current local time: \d{2}:\d{2} (AM|PM)$/u);
    expect(lines[1]).toBe("local timezone: America/New_York");
    expect(lines[2]).toBe("workspace timezone: Europe/London");
    expect(lines[3]).toMatch(/^local date: [A-Z][a-z]+ \d{1,2} \d{4}$/u);
    expect(lines[4]).toMatch(/^iso8601 timestamp: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    expect(result.summary).toBe(result.output);
  });

  it("uses workspace time for workspace runs and validates explicit timezone overrides", async () => {
    const { database, env } = fixture();
    database.prepare("UPDATE workspaces SET timezone = ? WHERE id = ?")
      .run("Europe/London", WORKSPACE_ID);
    const workspaceInput = workflowInput();
    workspaceInput.executionPrincipal = { type: "workspace", workspaceId: WORKSPACE_ID };
    const tool = __integrationTesting.createAvalonTools(env, workspaceInput)
      .find((candidate) => candidate.definition.name === "current_time");

    const workspaceTime = await tool!.execute({}, {
      ...context(),
      executionPrincipal: workspaceInput.executionPrincipal,
    });
    expect(String(workspaceTime.output)).toContain("local timezone: Europe/London");
    expect(String(workspaceTime.output)).toContain("workspace timezone: Europe/London");

    const overrideTime = await tool!.execute({ timezone: "America/Los_Angeles" }, {
      ...context(),
      executionPrincipal: workspaceInput.executionPrincipal,
    });
    expect(String(overrideTime.output)).toContain("local timezone: America/Los_Angeles");
    expect(String(overrideTime.output)).toContain("workspace timezone: Europe/London");
    await expect(tool!.execute({ timezone: "Mars/Olympus_Mons" }, {
      ...context(),
      executionPrincipal: workspaceInput.executionPrincipal,
    })).rejects.toThrow("Invalid IANA timezone");
  });

  it("converges elicitation retries on one durable question", async () => {
    const { objectStore, baseEnv } = fixture();
    // The routed version could be raced: the existence check was a read of its
    // own in front of a three-statement batch, and this test injected a stale
    // answer to prove the `ON CONFLICT` converged anyway. The check is the
    // first statement of the authority's own transaction now, so there is no
    // window left to inject into — what is asserted instead is the outcome the
    // caller acts on: the second attempt writes nothing and announces nothing,
    // and the first attempt's question is still the only one.
    const roomEvents: Array<Record<string, unknown>> = [];
    const env = withWorkstreamRuntimeDatabase(
      createTestEnv({
        ...baseEnv,
        SUBSTREAM_AGENTS: testSubstreamAgentsBinding(objectStore, { roomEvents }),
      }),
      WORKSPACE_ID,
      WORKSTREAM_ID,
      "0",
      async (statements) => executeWorkstreamObjectSql(objectStore, statements),
    );
    const tool = __integrationTesting.createAvalonTools(env, workflowInput())
      .find((candidate) => candidate.definition.name === "request_elicitation");
    expect(tool?.definition.idempotency).toBe("provider_key");
    expect(tool?.definition.inputSchema).not.toHaveProperty("properties.targetUserId");

    const args = {
      prompt: "Which environment should Avalon deploy?",
      responseType: "single_select",
      options: [
        { value: "staging", label: "Staging", description: null },
        { value: "production", label: "Production", description: null },
      ],
      minimumSelections: 1,
      maximumSelections: 1,
    };
    const first = await tool!.execute(args, context("run:turn:2:tool:0"));
    const second = await tool!.execute(args, context("run:turn:2:tool:0"));

    expect(second).toEqual(first);
    expect(first).toMatchObject({ halt: "needs_input" });
    expect(roomEvents.filter((event) => event.type === "elicitation_created")).toHaveLength(1);
    expect(workstreamObjectGet(objectStore, "SELECT COUNT(*) AS count FROM elicitation_requests")).toEqual({ count: 1 });
    expect(workstreamObjectGet(objectStore, "SELECT target_user_id FROM elicitation_requests")).toEqual({ target_user_id: null });
    expect(workstreamObjectGet(
      objectStore,
      "SELECT COUNT(*) AS count FROM messages WHERE message_type = 'elicitation'",
    )).toEqual({ count: 1 });
    // `next_attention_ordinal` is the object's own counter; the retired view
    // rendered it as `latest_attention_sequence_number = next_attention_ordinal - 1`.
    expect(workstreamObjectRootRow(
      objectStore,
      "exact_state, next_sequence_number, next_attention_ordinal",
    )).toEqual({
      exact_state: "needs_input",
      next_sequence_number: 2,
      next_attention_ordinal: 2,
    });
  });

  it("refuses to execute provider-key writes without the receipt-derived key", async () => {
    const { env } = fixture();
    const tool = __integrationTesting.createAvalonTools(env, workflowInput())
      .find((candidate) => candidate.definition.name === "request_elicitation");

    await expect(tool!.execute(
      { prompt: "No receipt", responseType: "text" },
      context(),
    )).rejects.toThrow("requires a durable provider idempotency key");
  });
});
