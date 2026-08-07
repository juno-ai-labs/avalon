import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  createDatabase,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type D1ResultLike,
} from "../src/index";

const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));

function migrateFreshDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  for (const fileName of readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(new URL(`../migrations/${fileName}`, import.meta.url), "utf8"));
  }
  return database;
}

function sqliteD1(database: DatabaseSync): D1DatabaseLike {
  const prepare = (sql: string): D1PreparedStatementLike => {
    let values: unknown[] = [];
    const statement: D1PreparedStatementLike = {
      bind(...next: unknown[]) {
        values = next;
        return statement;
      },
      async first<T>(column?: string) {
        const row = database.prepare(sql).get(...values as never[]) as Record<string, unknown> | undefined;
        return (column ? row?.[column] : row ?? null) as T | null;
      },
      async all<T>() {
        return {
          results: database.prepare(sql).all(...values as never[]) as T[],
          success: true,
          meta: {},
        };
      },
      async run<T>() {
        const result = database.prepare(sql).run(...values as never[]);
        return {
          results: [],
          success: true,
          meta: { changes: Number(result.changes) },
        } as D1ResultLike<T>;
      },
    };
    return statement;
  };
  return {
    prepare,
    async batch<T>(statements: D1PreparedStatementLike[]) {
      database.exec("BEGIN");
      try {
        const results: D1ResultLike<T>[] = [];
        for (const statement of statements) results.push(await statement.run<T>());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

describe("work-stream persistence", () => {
  it("attaches only eligible draft uploads to the opening message", async () => {
    const database = migrateFreshDatabase();
    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES ('user-create', 'google-create', 'create@example.com', 'Creator', '2026-01-01', '2026-01-01');
      INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('workspace-create', 'Create', 'create', 'global', 'user-create', '2026-01-01', '2026-01-01');
      INSERT INTO resources
        (id, workspace_id, resource_type, provider, title, mime_type, content_ref,
         metadata_json, uploaded_by_user_id, attachment_status, created_at, updated_at)
      VALUES
        ('resource-create', 'workspace-create', 'uploaded_file', 'avalon_upload', 'notes.txt',
         'text/plain', 'payload/notes', '{"size":5}', 'user-create', 'draft', '2026-01-01', '2026-01-01'),
        ('resource-attached', 'workspace-create', 'uploaded_file', 'avalon_upload', 'old.txt',
         'text/plain', 'payload/old', '{"size":3}', 'user-create', 'attached', '2026-01-01', '2026-01-01');
    `);
    const repository = createDatabase(sqliteD1(database));

    const created = await repository.workstreams.create({
      id: "workstream-create",
      workspaceId: "workspace-create",
      title: "Review notes",
      objective: "Review the attached notes",
      emailAddress: "review-notes@automation.with-avalon.com",
      creatorUserId: "user-create",
      openingAuthor: { type: "human", userId: "user-create" },
      openingMessage: "",
      clientMessageId: "client-create",
      participantUserIds: [],
      attachmentIds: ["resource-create", "resource-attached", "resource-create"],
    });

    expect(database.prepare(
      "SELECT resource_id, position FROM message_attachments WHERE message_id = ?",
    ).get(created.messageId)).toEqual({ resource_id: "resource-create", position: 0 });
    expect(database.prepare(
      "SELECT resource_id, relationship_type FROM workstream_resources WHERE workstream_id = ?",
    ).get(created.workstream.id)).toEqual({ resource_id: "resource-create", relationship_type: "message_attachment" });
    expect(database.prepare(
      "SELECT attachment_status FROM resources WHERE id = 'resource-create'",
    ).get()).toEqual({ attachment_status: "attached" });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM message_attachments WHERE resource_id = 'resource-attached'",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM workstream_resources WHERE resource_id = 'resource-attached'",
    ).get()).toEqual({ count: 0 });
    database.close();
  });
});
