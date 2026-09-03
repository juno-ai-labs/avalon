/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The durable resource-attachment authority, on real workerd.
 *
 * The Node suite proves what the SQL decides. This proves what the runtime
 * does: that a watch toggle commits its row and the directory projection the
 * sidebar reads in one step, that a read commits nothing, and that a misrouted
 * or quarantined object is refused before it writes.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asSubstreamId } from "@rally/contracts";

import { conversationObjectName } from "../src/durable-objects/names";
import {
  WORKSPACE_ID,
  WORKSTREAM_ID,
  boot,
  post,
  seedParticipantMessage,
  seedOpenWorkstreamAuthority,
  seedWorkstreamRoot,
} from "./helpers/substream-fixture";

beforeEach(async () => {
  await seedOpenWorkstreamAuthority(env.DB);
  // Generous, and only because of the interleave: a sibling file's `reset()`
  // takes every object's input gate, so this hook can wait out a full reset
  // before it gets to run at all. The seed itself takes milliseconds — a
  // failure here is a hang, never a slow query.
}, 30_000);

const RESOURCE = "00000000-0000-7000-8000-0000000000e1";

let unique = 0;
/** A fresh object per test; a reused id would carry the last test's rows. */
function agent(): DurableObjectStub {
  unique += 1;
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
    conversationObjectName(
      "global",
      WORKSPACE_ID,
      WORKSTREAM_ID,
      asSubstreamId(`00000000-0000-7000-8000-${String(unique).padStart(12, "2")}`),
    ),
  ));
}

/** Call the real endpoint, exactly as the Worker's port does. */
async function resources(
  stub: DurableObjectStub,
  operation: string,
  ...args: unknown[]
): Promise<{ status: number; value: unknown; error?: string }> {
  const { status, body } = await post(stub, "/internal/resources", {
    workspaceId: WORKSPACE_ID,
    workstreamId: WORKSTREAM_ID,
    operation,
    args,
  });
  const parsed = body as { value?: unknown; error?: string } | null;
  return { status, value: parsed?.value ?? null, ...(parsed?.error ? { error: parsed.error } : {}) };
}

function attach(state: DurableObjectState, watchEnabled = 0): void {
  state.storage.sql.exec(
    `INSERT INTO workstream_resource_links
       (resource_id, attached_by_user_id, watch_enabled, relationship_type,
        resource_json, attached_at, updated_at)
     VALUES (?, NULL, ?, 'attachment', '{}', 1, 1)`,
    RESOURCE,
    watchEnabled,
  );
}

describe("resource authority on real workerd", () => {
  it("commits a watch toggle and the directory projection in one step", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, async (_instance, state) => {
      seedWorkstreamRoot(state);
      attach(state);
    });

    const result = await resources(stub, "setWatchEnabled", {
      resourceId: RESOURCE,
      watchEnabled: 1,
    });

    expect(result.status).toBe(200);
    expect(result.value).toMatchObject({ outcome: "set", previousWatchEnabled: 0 });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(
        `SELECT watch_enabled FROM workstream_resource_links`,
      ).one().watch_enabled).toBe(1);
      // What a work stream is watching is on the sidebar, and a write whose
      // directory projection is a second commit can lose it.
      expect(state.storage.sql.exec(
        `SELECT COUNT(*) AS count FROM projection_keys WHERE projection_key = 'common'`,
      ).one().count).toBe(1);
    });
  });

  it("leaves no projection behind for a read", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, async (_instance, state) => {
      seedWorkstreamRoot(state);
      attach(state);
    });

    const result = await resources(stub, "attachedResourceIds");

    // Reads are most of this port's traffic — the rail, the harness's tool
    // surface, the compaction fence. Committing a projection for each would
    // republish the sidebar on every one.
    expect(result.value).toEqual([RESOURCE]);
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(`SELECT COUNT(*) AS count FROM projection_keys`).one().count)
        .toBe(0);
    });
  });

  it("does not advance the inventory revision for a watch toggle", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => {
      seedWorkstreamRoot(state);
      attach(state);
      state.storage.sql.exec(
        `INSERT INTO resource_inventory_revision (id, revision, updated_at) VALUES (1, 3, 1)`,
      );
    });

    await resources(stub, "setWatchEnabled", { resourceId: RESOURCE, watchEnabled: 1 });

    // The retired `_runtime_workstream_resources` update trigger bumped the
    // revision on every column it could write, this one included. But
    // `inventory:<revision>` fences a compaction checkpoint against a change in
    // what a run is *authorized to see*, and a watch flag changes nothing about
    // that — so bumping it invalidated checkpoints for a write that never
    // affected them.
    expect(await resources(stub, "inventoryRevision")).toMatchObject({ value: 3 });
  });

  it("refuses a request naming another work stream", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => {
      seedWorkstreamRoot(state);
      attach(state);
    });

    const { status, body } = await post(stub, "/internal/resources", {
      workspaceId: WORKSPACE_ID,
      workstreamId: "00000000-0000-7000-8000-0000000000ff",
      operation: "setWatchEnabled",
      args: [{ resourceId: RESOURCE, watchEnabled: 1 }],
    });

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: "workstream_resource_identity_mismatch" });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(
        `SELECT watch_enabled FROM workstream_resource_links`,
      ).one().watch_enabled).toBe(0);
    });
  });

  it("refuses a write against an object that is no longer the authority", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => {
      seedWorkstreamRoot(state);
      attach(state);
      state.storage.sql.exec(`UPDATE workstream SET authority_mode = 'quarantined' WHERE id = 1`);
    });

    const result = await resources(stub, "setWatchEnabled", {
      resourceId: RESOURCE,
      watchEnabled: 1,
    });

    expect(result.status).toBe(409);
    expect(result.error).toBe("workstream_runtime_authority_fenced");
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(
        `SELECT watch_enabled FROM workstream_resource_links`,
      ).one().watch_enabled).toBe(0);
    });
  });

  it("reads an attachment list wider than one statement can bind", async () => {
    const stub = agent();
    await boot(stub);
    const resourceIds = Array.from(
      { length: 250 },
      (_, index) => `00000000-0000-7000-8000-${String(index).padStart(12, "0")}`,
    );
    await runInDurableObject(stub, async (_instance, state) => {
      seedWorkstreamRoot(state);
      for (const [index, resourceId] of resourceIds.entries()) {
        state.storage.sql.exec(
          `INSERT INTO workstream_resource_links
             (resource_id, attached_by_user_id, watch_enabled, relationship_type,
              resource_json, attached_at, updated_at)
           VALUES (?, NULL, 0, 'attachment', '{}', ?, ?)`,
          resourceId,
          index + 1,
          index + 1,
        );
        await seedParticipantMessage(state, {
          id: `p${index}`,
          sequence: index + 1,
          text: "hi",
          authorUserId: "u1",
          clientMessageId: `c${index}`,
          attentionOrdinal: index + 1,
          now: 1,
        });
        state.storage.sql.exec(
          `INSERT INTO participant_transcript_attachments (turn_id, resource_id, position, attachment_json)
           VALUES (?, ?, 0, '{}')`,
          `p${index}`,
          resourceId,
        );
      }
    });

    // Nothing bounds a work stream's attachment list, and this engine binds 100
    // parameters per statement. An unchunked `IN` list is refused outright, so
    // the rail fails to load rather than loading slowly. Only the runtime has
    // that ceiling — `node:sqlite` accepts far more — which is why this cannot
    // live in the Node suite.
    const links = await resources(stub, "attachedLinks", { resourceIds });
    const onMessages = await resources(stub, "resourceIdsOnMessages", { resourceIds });

    expect(links.status).toBe(200);
    expect(links.value).toHaveLength(250);
    expect(onMessages.value).toHaveLength(250);
    // Ordering survives the chunking: each chunk is ordered, so the
    // concatenation is re-sorted rather than assumed.
    expect((links.value as Array<{ resource_id: string }>)[0]?.resource_id)
      .toBe(resourceIds.at(-1));
  });

  it("refuses an operation that is not on the contract", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => seedWorkstreamRoot(state));

    const { status, body } = await post(stub, "/internal/resources", {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      operation: "detachEverything",
      args: [],
    });

    expect(status).toBe(400);
    expect(body).toMatchObject({ error: "invalid_resource_operation" });
  });
});
