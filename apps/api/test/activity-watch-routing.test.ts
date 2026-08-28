/**
 * What a watched resource's change notification tells the work stream.
 *
 * The poll and the routing are live machinery; what this covers is the half
 * that makes a notification actionable — the injected message naming the
 * resource that went stale, so a participant can ask for the re-fetch that
 * versions the snapshot they had been reading.
 */
import { asWorkspaceId } from "@rally/contracts";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { __testing } from "../src/queues/activity-consumer";
import { ensureResourceSlug } from "../src/services/resource-slug";
import {
  createCloudflareTestBinding,
  createTestDurableObjectId,
  createTestEnv,
} from "./helpers/cloudflare-test";
import { testSubstreamAgentsBinding, testWorkstreamObjectStore, workstreamObjectGet } from "./helpers/durable-authority";
import { sqliteD1 } from "./helpers/sqlite-d1";
import { workspaceObjectSqliteDatabase } from "./helpers/workspace-object-tables";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000201");
const WORKSTREAM_ID = "00000000-0000-7000-8000-000000000202";
const CONNECTION_ID = "00000000-0000-7000-8000-000000000204";
const RESOURCE_ID = "00000000-0000-7000-8000-000000000205";

const open: DatabaseSync[] = [];
afterEach(() => { for (const database of open.splice(0)) database.close(); });

function fixture() {
  const database = workspaceObjectSqliteDatabase(WORKSPACE_ID);
  open.push(database);
  database.prepare(
    `INSERT INTO resources
       (id, workspace_id, connection_id, resource_type, provider, provider_resource_id,
        title, content_ref, metadata_json, attachment_status, created_at, updated_at)
     VALUES (?, ?, ?, 'document', 'notion', 'notion-page-1', 'Launch plan',
             'r2/original-1', '{}', 'attached', '2026-08-28T01:00:00.000Z',
             '2026-08-28T01:00:00.000Z')`,
  ).run(RESOURCE_ID, WORKSPACE_ID, CONNECTION_ID);
  const objectStore = testWorkstreamObjectStore();
  open.push(objectStore);
  const workspaceNamespace = {
    idFromName: (name: string) => createTestDurableObjectId(name),
    get: () => ({
      workstreamsForResource: async () => ({ workstreamIds: [WORKSTREAM_ID] }),
      workstreamAudience: async () => ({ scope: "workspace" as const }),
    }),
    jurisdiction: () => workspaceNamespace,
  };
  const env = createTestEnv({
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    SESSION_SIGNING_KEY: "0".repeat(64),
    WORKSPACE_DOS: createCloudflareTestBinding<DurableObjectNamespace>(workspaceNamespace),
    SUBSTREAM_AGENTS: testSubstreamAgentsBinding(objectStore, {
      extra: {
        readerAudience: vi.fn(async () => ({ scope: "workspace" as const })),
        publishEvent: vi.fn(async () => ({ status: 200, bodyJson: "{}" })),
      },
    }),
  });
  return { database, objectStore, env };
}

const activity = {
  id: "00000000-0000-7000-8000-000000000206",
  workspace_id: WORKSPACE_ID,
  workspace_region: "global" as const,
  connection_id: CONNECTION_ID,
  connection_scope: "workspace",
  connection_owner_user_id: null,
  provider: "notion",
  event_type: "notion.page.updated",
  provider_resource_id: "notion-page-1",
  entity_keys_json: "[]",
  target_user_ids_json: "[]",
  visibility_json: "{}",
  title: "Launch plan changed",
  summary: "Someone edited the page",
  actor_json: "{}",
};

describe("a watched resource's change notification", () => {
  it("names the resource that went stale, by alias as well as id", async () => {
    const { database, objectStore, env } = fixture();
    const alias = await ensureResourceSlug(env, WORKSPACE_ID, RESOURCE_ID);

    await expect(__testing.routeDirectWatches(env, activity as never))
      .resolves.toEqual(new Set([WORKSTREAM_ID]));

    // Without this the message says only that "something changed at Notion":
    // the participant reading it cannot tell which of a work stream's attached
    // documents the re-fetch would refresh.
    const stored = workstreamObjectGet(
      objectStore,
      "SELECT structured_content_json FROM canonical_conversation_turn_details WHERE message_type = 'system'",
    ) as { structured_content_json: string };
    expect(JSON.parse(stored.structured_content_json)).toMatchObject({
      kind: "connected_activity",
      provider: "notion",
      staleResources: [{ resourceId: RESOURCE_ID, slug: alias, title: "Launch plan" }],
    });
    void database;
  });

  it("names the stale document in the text a participant actually reads", async () => {
    const { database, objectStore, env } = fixture();
    await ensureResourceSlug(env, WORKSPACE_ID, RESOURCE_ID);

    await expect(__testing.routeDirectWatches(env, activity as never))
      .resolves.toEqual(new Set([WORKSTREAM_ID]));

    // The structured field is for a surface that reads it; no surface does
    // today, and the transcript renders the text. A participant who cannot
    // name the document from the message cannot ask for its re-fetch, which
    // is the whole loop this notification exists to start.
    const stored = workstreamObjectGet(
      objectStore,
      "SELECT content AS text_content FROM canonical_conversation_turn_details WHERE message_type = 'system'",
    ) as { text_content: string };
    expect(stored.text_content).toContain("Launch plan changed");
    expect(stored.text_content).toContain("Attached here and now out of date: Launch plan");
    void database;
  });
});
