import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { applyWorkstreamObjectSchema } from "../src/durable-objects/workstream-object-schema";
import { WorkstreamResourceStorage } from "../src/durable-objects/workstream-resource-storage";
import { createCloudflareTestBinding } from "./helpers/cloudflare-test";
import { createTestSqlStorage } from "./helpers/sql-storage";

const NOW = 1_787_000_000_000;

const databases: DatabaseSync[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function open() {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  const sql = createTestSqlStorage(database);
  const binding = createCloudflareTestBinding<DurableObjectStorage>({
    getAlarm: async () => null,
    setAlarm: async () => undefined,
    transactionSync: (body: () => unknown) => body(),
    sql,
  });
  applyWorkstreamObjectSchema(binding, "resource-storage-test", NOW);
  sql.exec(`INSERT INTO workstream (
      id, workstream_key, parent_workspace_key, parent_do_id, parent_generation, region,
      authority_mode, authority_generation, title, description, preview, scope,
      exact_state, state_reason_code, next_sequence_number, next_attention_ordinal,
      unread_tracking_start_ordinal, authority_epoch, scope_epoch,
      source_authorization_floor, listing_epoch, deletion_epoch, run_revision,
      created_at, last_people_activity_at, state_changed_at, updated_at
    ) VALUES (1,'S','W',NULL,0,'global','authoritative',1,'T','','','workspace',
              'idle','s',1,1,0,0,0,0,0,0,0,1,1,1,1)`);
  sql.exec(`INSERT INTO substreams (id,kind,inherit_mode,depth,return_mode,audience,tool_policy,status,created_at)
    VALUES ('0','main','none',0,'none','workspace','full','open',1)`);
  return { storage: new WorkstreamResourceStorage(binding), sql };
}

function attach(
  sql: SqlStorage,
  resourceId: string,
  overrides: { attachedAt?: number; watchEnabled?: number; relationshipType?: string } = {},
): void {
  sql.exec(
    `INSERT INTO workstream_resource_links
       (resource_id, attached_by_user_id, watch_enabled, relationship_type,
        resource_json, attached_at, updated_at)
     VALUES (?, NULL, ?, ?, '{}', ?, ?)`,
    resourceId,
    overrides.watchEnabled ?? 0,
    overrides.relationshipType ?? "attachment",
    overrides.attachedAt ?? NOW,
    overrides.attachedAt ?? NOW,
  );
}

describe("what a work stream has attached", () => {
  it("rejects relationship types outside the stored enum", () => {
    const { sql } = open();

    expect(() => attach(sql, "r-a", { relationshipType: "made_up" }))
      .toThrow(/CHECK constraint failed/u);
  });

  it("answers newest first, and by id when two arrived together", () => {
    const { storage, sql } = open();
    attach(sql, "r-b", { attachedAt: NOW });
    attach(sql, "r-a", { attachedAt: NOW });
    attach(sql, "r-c", { attachedAt: NOW + 1_000 });

    // The rail reads newest first. A tie on the instant is broken by id rather
    // than left to the rowid, because a page boundary landing inside a tie is
    // where an unspecified order stops being academic.
    expect(storage.attachedLinks().map((link) => link.resource_id))
      .toEqual(["r-c", "r-a", "r-b"]);
    expect(storage.attachedResourceIds()).toEqual(["r-a", "r-b", "r-c"]);
  });

  it("narrows to the ids a caller names, and asks nothing for an empty list", () => {
    const { storage, sql } = open();
    attach(sql, "r-a");
    attach(sql, "r-b");

    expect(storage.attachedLinks({ resourceIds: ["r-b", "r-b"] })
      .map((link) => link.resource_id)).toEqual(["r-b"]);
    // An empty list is a question with a known answer, not a query with no
    // placeholders in its `IN`.
    expect(storage.attachedLinks({ resourceIds: [] })).toEqual([]);
    expect(storage.isAttached({ resourceId: "r-a" })).toBe(true);
    expect(storage.isAttached({ resourceId: "r-z" })).toBe(false);
  });

  it("says which attachments also ride on a transcript message", () => {
    const { storage, sql } = open();
    attach(sql, "r-a");
    attach(sql, "r-b");
    sql.exec(
      `INSERT INTO parts
         (id, substream_id, sequence_number, attention_ordinal, role, kind, author_type,
          author_user_id, content, client_message_id, visibility, pinned, message_type,
          created_at, updated_at)
       VALUES ('p1','0',1,1,'user','text','member','u1','hi','c1','both',0,'text',?,?)`,
      NOW,
      NOW,
    );
    sql.exec(
      `INSERT INTO part_attachments (part_id, resource_id, position, attachment_json)
       VALUES ('p1','r-a',0,'{}')`,
    );

    // The rail marks a resource a member sent in a message differently from one
    // attached to the work stream. The retired reader asked this as a
    // correlated `EXISTS` per row; both tables are in this object, so it is one
    // read of the page.
    expect(storage.resourceIdsOnMessages({ resourceIds: ["r-a", "r-b"] })).toEqual(["r-a"]);
    expect(storage.resourceIdsOnMessages({ resourceIds: [] })).toEqual([]);
  });
});

describe("toggling a watch", () => {
  it("writes the new value and answers with the one it replaced", () => {
    const { storage, sql } = open();
    attach(sql, "r-a", { watchEnabled: 1 });

    // The answer is what makes the caller's compensation correct: the regional
    // watch row and this link are in different authorities, so a failed
    // regional write has to restore what *this* operation replaced rather than
    // a value read in an earlier round trip.
    expect(storage.setWatchEnabled({ resourceId: "r-a", watchEnabled: 0 }))
      .toEqual({ outcome: "set", previousWatchEnabled: 1 });
    expect(sql.exec(`SELECT watch_enabled FROM workstream_resource_links`).one().watch_enabled)
      .toBe(0);
    expect(storage.setWatchEnabled({ resourceId: "r-a", watchEnabled: 1 }))
      .toEqual({ outcome: "set", previousWatchEnabled: 0 });
  });

  it("refuses a resource this work stream does not hold", () => {
    const { storage } = open();

    // An ordinary answer rather than a throw: a member can detach a resource
    // between opening the rail and pressing the toggle, and the caller turns
    // this into the 404 the routed version raised from a missing row.
    expect(storage.setWatchEnabled({ resourceId: "r-a", watchEnabled: 1 }))
      .toEqual({ outcome: "not_attached" });
  });
});

describe("the inventory revision", () => {
  it("is zero before anything has written it", () => {
    const { storage } = open();

    // What the retired view's `COALESCE(revision.revision, 0)` answered for a
    // work stream that has never attached anything. The compaction
    // checkpoint's fence is `inventory:<revision>`, so this is the value a
    // first checkpoint is written against.
    expect(storage.inventoryRevision()).toBe(0);
  });

  it("reads the row the authorized-inventory writers advance", () => {
    const { storage, sql } = open();
    sql.exec(
      `INSERT INTO resource_inventory_revision (id, revision, updated_at) VALUES (1, 7, ?)`,
      NOW,
    );

    expect(storage.inventoryRevision()).toBe(7);
  });
});
