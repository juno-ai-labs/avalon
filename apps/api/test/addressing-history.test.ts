import { asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";

import { WorkstreamObjectProductService } from "../src/durable-objects/workstream-object-product";
import { WorkstreamObjectStore } from "../src/durable-objects/workstream-object-storage";
import { prepareTranscriptFact, WorkstreamTranscriptStorage } from "../src/durable-objects/workstream-transcript-storage";
import { createCloudflareTestBinding, createTestEnv } from "./helpers/cloudflare-test";
import { createTestSqlStorage } from "./helpers/sql-storage";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

// This exercises the history query against the real object migrations and
// canonical transcript view; no alarm, socket, or workerd lifecycle is involved.
it("selects the latest ten turns with text before the current message, skipping tool-only and blank turns", async () => {
  const database = new DatabaseSync(":memory:");
  const regional = migratedSqliteDatabase();
  try {
    const storage = createCloudflareTestBinding<DurableObjectStorage>({
      sql: createTestSqlStorage(database),
      transactionSync: (callback: () => unknown) => callback(),
    });
    const store = new WorkstreamObjectStore(storage, "addressing-history", "global");
    store.ensureIdentity({
      workspaceId: asWorkspaceId("00000000-0000-7000-8000-000000000001"),
      parentKind: "workstream",
      parentId: asWorkstreamId("00000000-0000-7000-8000-000000000002"),
    }, "global");
    const authorId = "00000000-0000-7000-8000-000000000003";
    regional.prepare(`INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES (?, 'history-author', 'author@example.com', 'Alex', '2026-10-21T00:00:00Z', '2026-10-21T00:00:00Z')`)
      .run(authorId);
    const product = new WorkstreamObjectProductService(storage, store, createTestEnv({ DB: sqliteD1(regional) }));
    const transcript = new WorkstreamTranscriptStorage(storage);
    let turnNumber = 0;
    async function append(content: string | null, actor: "human" | "assistant", toolCall = false): Promise<number> {
      const turnId = `history-turn-${++turnNumber}`;
      const prepared = await transcript.prepareParticipantMessage({
        turnId,
        actor,
        authorUserId: actor === "human" ? authorId : null,
        authorSnapshot: actor === "human" ? { displayName: "Alex", avatarUrl: null } : null,
        text: content ?? "",
        createdAtUtc: "2026-10-21T00:00:00Z",
        attentionOrdinal: turnNumber,
      });
      const fact = await prepareTranscriptFact({
        ...prepared.fact,
        payload: {
          role: actor === "human" ? "user" : "assistant",
          content,
          ...(toolCall ? { tool_calls: [{
            id: `call-${turnNumber}`,
            type: "function",
            function: { name: "current_time", arguments: "{}" },
          }] } : {}),
        },
      });
      return transcript.appendPreparedParticipantMessage({ ...prepared, fact });
    }

    await append("Older message outside the window", "human");
    await append("After Alex and KB respond, write an action plan", "human");
    await append("I’ll wait for their updates", "assistant");
    for (let index = 3; index <= 10; index += 1) {
      // Narration alongside a tool call still counts as text.
      await append(`Text ${index}`, index === 3 ? "assistant" : "human", index === 3);
      await append(null, "assistant", true);
      await append("", "assistant", true);
      await append(" \t\r\n ", "assistant");
    }
    const currentSequence = await append("Current message", "human");

    expect(await product["recentAddressingMessages"](currentSequence)).toEqual([
      { authorType: "human", authorName: "Alex", message: "After Alex and KB respond, write an action plan" },
      { authorType: "agent", authorName: "Rally", message: "I’ll wait for their updates" },
      { authorType: "agent", authorName: "Rally", message: "Text 3" },
      { authorType: "human", authorName: "Alex", message: "Text 4" },
      { authorType: "human", authorName: "Alex", message: "Text 5" },
      { authorType: "human", authorName: "Alex", message: "Text 6" },
      { authorType: "human", authorName: "Alex", message: "Text 7" },
      { authorType: "human", authorName: "Alex", message: "Text 8" },
      { authorType: "human", authorName: "Alex", message: "Text 9" },
      { authorType: "human", authorName: "Alex", message: "Text 10" },
    ]);
  } finally {
    database.close();
    regional.close();
  }
});
