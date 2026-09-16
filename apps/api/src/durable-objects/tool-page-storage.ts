import { z } from "zod";
import { WORKSTREAM_ADDRESS_ADJECTIVES_V1, WORKSTREAM_ADDRESS_NOUNS_V1 } from "../lib/workstream-email-address";

export const TOOL_PAGE_SCHEMA = `CREATE TABLE tool_pages (
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  producer_id TEXT NOT NULL REFERENCES tool_effects(effect_intent_id) ON DELETE CASCADE,
  slot TEXT NOT NULL,
  operation TEXT NOT NULL,
  connection_id TEXT,
  principal_json TEXT NOT NULL,
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  consumer_id TEXT REFERENCES tool_effects(effect_intent_id) ON DELETE CASCADE,
  parent_page_id TEXT,
  PRIMARY KEY(run_id, page_id),
  UNIQUE(producer_id, slot)
) STRICT`;
export const TOOL_PAGE_CONSUMER_INDEX = "CREATE INDEX tool_pages_consumer ON tool_pages(run_id, consumer_id)";

export const PageIdentitySchema = z.object({
  runId: z.string(), effectIntentId: z.string(), operation: z.string(),
  connectionId: z.string().nullable(), principalJson: z.string(),
});
export const PageIssueSchema = PageIdentitySchema.extend({
  prefix: z.string().regex(/^[a-z][a-z0-9_]*$/u),
  slot: z.string(), inputJson: z.string(),
});
export const PageClaimSchema = PageIdentitySchema.extend({ pageId: z.string() });

/** Called only inside the receipt authority's fenced synchronous transaction. */
export class ToolPageStorage {
  constructor(private readonly sql: SqlStorage) {}

  issue(raw: z.infer<typeof PageIssueSchema>): string {
    const input = PageIssueSchema.parse(raw);
    const existing = this.sql.exec<{ page_id: string; input_json: string; operation: string }>(
      "SELECT page_id, input_json, operation FROM tool_pages WHERE producer_id = ? AND slot = ?",
      input.effectIntentId, input.slot,
    ).toArray()[0];
    if (existing) {
      if (existing.input_json !== input.inputJson || existing.operation !== input.operation) {
        throw new Error("page_receipt_result_changed");
      }
      return existing.page_id;
    }
    const parent = this.sql.exec<{ page_id: string }>(
      "SELECT page_id FROM tool_pages WHERE run_id = ? AND consumer_id = ?",
      input.runId, input.effectIntentId,
    ).toArray()[0];
    if (parent && input.slot === "nextPageId") {
      // Follow this pagination chain only, not independent searches or
      // deliberate backwards navigation. A new slug must not hide a loop.
      const cycle = this.sql.exec<{ page_id: string }>(`WITH RECURSIVE ancestors AS (
        SELECT page_id, parent_page_id, input_json, operation, slot FROM tool_pages WHERE run_id = ?1 AND page_id = ?2
        UNION ALL
        SELECT p.page_id, p.parent_page_id, p.input_json, p.operation, p.slot
        FROM tool_pages p JOIN ancestors a ON p.page_id = a.parent_page_id
        WHERE p.run_id = ?1 AND a.slot = 'nextPageId'
      ) SELECT page_id FROM ancestors WHERE input_json = ?3 AND operation = ?4 AND slot = 'nextPageId' LIMIT 1`,
      input.runId, parent.page_id, input.inputJson, input.operation).toArray()[0];
      if (cycle) throw new Error("page_did_not_advance: The provider repeated a continuation. Restart with the first-page tool.");
    }
    for (;;) {
      const bytes = crypto.getRandomValues(new Uint32Array(4));
      const words: Array<string | undefined> = [0, 1, 2].map((i) => WORKSTREAM_ADDRESS_ADJECTIVES_V1[bytes[i]! % WORKSTREAM_ADDRESS_ADJECTIVES_V1.length]);
      words.push(WORKSTREAM_ADDRESS_NOUNS_V1[bytes[3]! % WORKSTREAM_ADDRESS_NOUNS_V1.length]);
      const pageId = `${input.prefix}_${words.join("_")}`;
      const inserted = this.sql.exec<{ page_id: string }>(
        `INSERT INTO tool_pages(run_id, page_id, producer_id, slot, operation, connection_id, principal_json, input_json, parent_page_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_id, page_id) DO NOTHING RETURNING page_id`,
        input.runId, pageId, input.effectIntentId, input.slot, input.operation,
        input.connectionId, input.principalJson, input.inputJson, parent?.page_id ?? null,
      ).toArray()[0];
      if (inserted) return inserted.page_id;
    }
  }

  claim(raw: z.infer<typeof PageClaimSchema>): { inputJson: string } {
    const input = PageClaimSchema.parse(raw);
    const row = this.sql.exec<{
      input_json: string; consumer_id: string | null; consumer_status: string | null;
    }>(`SELECT page.input_json, page.consumer_id, consumer.status AS consumer_status
      FROM tool_pages page JOIN tool_effects producer ON producer.effect_intent_id = page.producer_id
      LEFT JOIN tool_effects consumer ON consumer.effect_intent_id = page.consumer_id
      WHERE page.run_id = ? AND page.page_id = ? AND page.operation = ?
        AND page.connection_id IS ? AND page.principal_json = ? AND producer.status = 'completed'`,
    input.runId, input.pageId, input.operation, input.connectionId, input.principalJson).toArray()[0];
    if (!row) throw new Error("page_id_invalid: Restart with the first-page tool; pageId is not available for this operation and run.");
    if (row.consumer_id !== null && row.consumer_id !== input.effectIntentId && row.consumer_status !== "failed") {
      throw new Error(row.consumer_status === "completed"
        ? "page_already_consumed: Use nextPageId from the completed page, or restart with the first-page tool."
        : "page_in_progress: This page already has a call in progress.");
    }
    this.sql.exec("UPDATE tool_pages SET consumer_id = ? WHERE run_id = ? AND page_id = ?",
      input.effectIntentId, input.runId, input.pageId);
    return { inputJson: row.input_json };
  }
}
