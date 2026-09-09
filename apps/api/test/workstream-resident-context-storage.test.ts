import { DatabaseSync } from "node:sqlite";
import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { afterEach, describe, expect, it } from "vitest";

import { WorkstreamResidentContextStorage } from "../src/durable-objects/workstream-resident-context-storage";
import { applyWorkstreamObjectSchema } from "../src/durable-objects/workstream-object-schema";
import { createCloudflareTestBinding } from "./helpers/cloudflare-test";
import { createTestSqlStorage } from "./helpers/sql-storage";

const NOW = Date.parse("2026-09-09T00:00:00.000Z");
const KIND = "repository_instructions" as const;

describe("the context-residency ledger", () => {
  const databases: DatabaseSync[] = [];
  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  function open() {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    const storage = createCloudflareTestBinding<DurableObjectStorage>({
      getAlarm: async () => null,
      setAlarm: async () => undefined,
      transactionSync: (body: () => unknown) => body(),
      sql: createTestSqlStorage(database),
    });
    applyWorkstreamObjectSchema(storage, "resident-context-test", NOW);
    return { ledger: new WorkstreamResidentContextStorage(storage), database };
  }

  const root = { blockId: "AGENTS.md", sha256: "a".repeat(64), content: "root rules", truncated: false };
  const nested = { blockId: "apps/api/AGENTS.md", sha256: "b".repeat(64), content: "api rules", truncated: false };

  /** Prepare then commit, as the harness and the object do around a summary turn. */
  function compact(ledger: WorkstreamResidentContextStorage, index: number, now: number) {
    const section = ledger.prepareCompaction(`loop:compaction:${index}`, now);
    const applied = ledger.applyCompactionInTransaction(`loop:compaction:${index}`, now + 1);
    return { section, applied };
  }

  it("records a load once with a pending delivery and reports a resident block as already resident", () => {
    const { ledger } = open();
    expect(ledger.recordLoaded({ kind: KIND, sourceGeneration: 1, blocks: [root, nested], now: NOW }))
      .toEqual({ recorded: ["AGENTS.md", "apps/api/AGENTS.md"], alreadyResident: [] });
    // Recorded is not yet seen: the gate's known set fills at delivery.
    expect(ledger.residentBlocks({ kind: KIND })).toEqual([]);
    expect(ledger.pendingDeliveries().map((delivery) => delivery.sourceId))
      .toEqual([`AGENTS.md@${root.sha256}`, `apps/api/AGENTS.md@${nested.sha256}`]);
    expect(ledger.recordLoaded({ kind: KIND, sourceGeneration: 1, blocks: [root], now: NOW + 1 }))
      .toEqual({ recorded: [], alreadyResident: ["AGENTS.md"] });
    expect(ledger.markDeliveredInTransaction(ledger.pendingDeliveries(), NOW + 2))
      .toEqual([`AGENTS.md@${root.sha256}`, `apps/api/AGENTS.md@${nested.sha256}`]);
    expect(ledger.pendingDeliveries()).toEqual([]);
    expect(ledger.residentBlocks({ kind: KIND })).toEqual([`AGENTS.md@${root.sha256}`, `apps/api/AGENTS.md@${nested.sha256}`]);
    // A second mark finds nothing left to close.
    expect(ledger.markDeliveredInTransaction([{ block: ledger.allBlocks()[0]!, sourceKind: KIND, sourceId: "x" }], NOW + 3)).toEqual([]);
  });

  it("retires an edited transcript block and delivers the new content once", () => {
    const { ledger } = open();
    ledger.recordLoaded({ kind: KIND, sourceGeneration: 1, blocks: [root], now: NOW });
    ledger.markDeliveredInTransaction(ledger.pendingDeliveries(), NOW);
    const edited = { ...root, sha256: "c".repeat(64), content: "new root rules" };
    expect(ledger.recordLoaded({ kind: KIND, sourceGeneration: 1, blocks: [edited], now: NOW + 1 }))
      .toEqual({ recorded: ["AGENTS.md"], alreadyResident: [] });
    expect(ledger.allBlocks().map((block) => [block.sha256[0], block.residency]))
      .toEqual([["a", "none"], ["c", "transcript"]]);
    ledger.markDeliveredInTransaction(ledger.pendingDeliveries(), NOW + 2);
    expect(ledger.residentBlocks({ kind: KIND })).toEqual([`AGENTS.md@${edited.sha256}`]);
  });

  it("promotes a still-pending block into the prompt without delivering it as a message too, and skips a row of an unknown kind", () => {
    const { ledger, database } = open();
    ledger.recordLoaded({ kind: KIND, sourceGeneration: 1, blocks: [root], now: NOW });
    compact(ledger, 1, NOW + 1);
    expect(ledger.allBlocks().map((block) => [block.residency, block.compactionsRemaining])).toEqual([["system", 2]]);
    expect(ledger.pendingDeliveries()).toEqual([]);
    expect(ledger.renderSections()).toContain("root rules");
    // A replayed prepare for the applied event answers with what it produced.
    expect(ledger.prepareCompaction("loop:compaction:1", NOW + 3)).toBe(ledger.renderSections());
    // A row this build does not register is ignored by every read.
    database.exec(`INSERT INTO resident_context_blocks
      (kind, block_id, sha256, source_generation, content, truncated, residency, superseded, compactions_remaining, pending_delivery, first_delivered_at, last_delivered_at)
      VALUES ('future_kind', 'x', '${"f".repeat(64)}', NULL, 'later', 0, 'system', 0, 1, 0, ${NOW}, ${NOW})`);
    expect(ledger.allBlocks()).toHaveLength(1);
    expect(ledger.renderSections()).not.toContain("later");
    expect(ledger.pendingDeliveries()).toEqual([]);
  });

  it("moves transcript blocks into the prompt at a compaction, once per event, and renders the section from the proposed state first", () => {
    const { ledger } = open();
    ledger.recordLoaded({ kind: KIND, sourceGeneration: 1, blocks: [root, nested], now: NOW });
    ledger.markDeliveredInTransaction(ledger.pendingDeliveries(), NOW);
    expect(ledger.renderSections()).toBeNull();
    const proposed = ledger.prepareCompaction("loop:compaction:1", NOW + 1);
    expect(proposed).toContain("# Repository instructions");
    expect(proposed).toContain("Instructions added from ./AGENTS.md:\nroot rules");
    expect(proposed).toContain("Instructions added from ./apps/api/AGENTS.md:\napi rules");
    // Preparing wrote nothing.
    expect(ledger.renderSections()).toBeNull();
    expect(ledger.applyCompactionInTransaction("loop:compaction:1", NOW + 2)).toEqual({ applied: true });
    expect(ledger.renderSections()).toBe(proposed);
    expect(ledger.allBlocks().map((block) => [block.residency, block.compactionsRemaining]))
      .toEqual([["system", 2], ["system", 2]]);
    // A replayed commit changes nothing.
    expect(ledger.applyCompactionInTransaction("loop:compaction:1", NOW + 3)).toEqual({ applied: false, reason: "already_applied" });
    expect(ledger.allBlocks().map((block) => block.compactionsRemaining)).toEqual([2, 2]);
    compact(ledger, 2, NOW + 4);
    compact(ledger, 3, NOW + 6);
    expect(ledger.allBlocks().map((block) => [block.residency, block.compactionsRemaining]))
      .toEqual([["system", 0], ["system", 0]]);
    expect(ledger.renderSections()).toBe(proposed);
    compact(ledger, 4, NOW + 8);
    expect(ledger.allBlocks().map((block) => block.residency)).toEqual(["none", "none"]);
    expect(ledger.renderSections()).toBeNull();
    // Retired is not forgotten: the next touch delivers again.
    expect(ledger.recordLoaded({ kind: KIND, sourceGeneration: 1, blocks: [root], now: NOW + 6 }))
      .toEqual({ recorded: ["AGENTS.md"], alreadyResident: [] });
  });

  it("flags an edited prompt-resident block as superseded and retires it at the next compaction", () => {
    const { ledger } = open();
    ledger.recordLoaded({ kind: KIND, sourceGeneration: 1, blocks: [root], now: NOW });
    ledger.markDeliveredInTransaction(ledger.pendingDeliveries(), NOW);
    compact(ledger, 1, NOW + 1);
    const edited = { ...root, sha256: "c".repeat(64), content: "new root rules" };
    ledger.recordLoaded({ kind: KIND, sourceGeneration: 1, blocks: [edited], now: NOW + 3 });
    // The old block stays in the prompt; the prefix does not change mid-run.
    expect(ledger.renderSections()).toContain("root rules");
    expect(ledger.renderSections()).not.toContain("new root rules");
    expect(ledger.allBlocks().map((block) => [block.sha256[0], block.residency, block.superseded]))
      .toEqual([["a", "system", true], ["c", "transcript", false]]);
    // Superseded is rendered but no longer current, so it is not in the known set.
    ledger.markDeliveredInTransaction(ledger.pendingDeliveries(), NOW + 3);
    expect(ledger.residentBlocks({ kind: KIND })).toEqual([`AGENTS.md@${edited.sha256}`]);
    compact(ledger, 2, NOW + 4);
    expect(ledger.allBlocks().map((block) => [block.sha256[0], block.residency, block.compactionsRemaining]))
      .toEqual([["a", "none", 0], ["c", "system", 2]]);
    expect(ledger.renderSections()).toContain("new root rules");
  });

  it("reinstates a superseded prompt block when the source reverts to its content, and delivers it again", () => {
    const { ledger } = open();
    ledger.recordLoaded({ kind: KIND, sourceGeneration: 1, blocks: [root], now: NOW });
    ledger.markDeliveredInTransaction(ledger.pendingDeliveries(), NOW);
    compact(ledger, 1, NOW + 1);
    const edited = { ...root, sha256: "c".repeat(64), content: "new root rules" };
    ledger.recordLoaded({ kind: KIND, sourceGeneration: 1, blocks: [edited], now: NOW + 3 });
    ledger.markDeliveredInTransaction(ledger.pendingDeliveries(), NOW + 4);
    // The file goes back to the prompt-resident content before the next
    // compaction. The probe reports it because it is not in the known set; the
    // ledger keeps it in the prompt, makes it current again with a fresh
    // lifetime, retires the edit, and delivers it once more so the transcript's
    // last word on this path is the content the file has.
    expect(ledger.recordLoaded({ kind: KIND, sourceGeneration: 1, blocks: [root], now: NOW + 5 }))
      .toEqual({ recorded: ["AGENTS.md"], alreadyResident: [] });
    expect(ledger.allBlocks().map((block) => [block.sha256[0], block.residency, block.superseded, block.compactionsRemaining]))
      .toEqual([["a", "system", false, 2], ["c", "none", false, 0]]);
    expect(ledger.pendingDeliveries().map((delivery) => delivery.sourceId)).toEqual([`AGENTS.md@${root.sha256}`]);
    expect(ledger.residentBlocks({ kind: KIND })).toEqual([]);
    ledger.markDeliveredInTransaction(ledger.pendingDeliveries(), NOW + 5);
    expect(ledger.residentBlocks({ kind: KIND })).toEqual([`AGENTS.md@${root.sha256}`]);
    // The prefix did not change: the block was in the prompt throughout.
    expect(ledger.renderSections()).toContain("root rules");
    expect(ledger.renderSections()).not.toContain("new root rules");
    compact(ledger, 2, NOW + 6);
    expect(ledger.allBlocks().map((block) => [block.sha256[0], block.residency, block.compactionsRemaining]))
      .toEqual([["a", "system", 1], ["c", "none", 0]]);
  });

  it("commits exactly the blocks it prepared and leaves one recorded in between to the next compaction", () => {
    const { ledger } = open();
    ledger.recordLoaded({ kind: KIND, sourceGeneration: 1, blocks: [root], now: NOW });
    ledger.markDeliveredInTransaction(ledger.pendingDeliveries(), NOW);
    const proposed = ledger.prepareCompaction("loop:compaction:1", NOW + 1);
    // A background bootstrap records a block while the summary turn is in flight.
    ledger.recordLoaded({ kind: KIND, sourceGeneration: 1, blocks: [nested], now: NOW + 2 });
    expect(ledger.applyCompactionInTransaction("loop:compaction:1", NOW + 3)).toEqual({ applied: true });
    // What the compacted system message carries is what the ledger says is
    // there; the late block is still a pending transcript delivery.
    expect(ledger.renderSections()).toBe(proposed);
    expect(ledger.allBlocks().map((block) => [block.blockId, block.residency]))
      .toEqual([["AGENTS.md", "system"], ["apps/api/AGENTS.md", "transcript"]]);
    expect(ledger.pendingDeliveries().map((delivery) => delivery.block.blockId)).toEqual(["apps/api/AGENTS.md"]);
    // A commit for an event nobody prepared moves nothing.
    expect(ledger.applyCompactionInTransaction("loop:compaction:2", NOW + 4)).toEqual({ applied: false, reason: "not_prepared" });
    expect(ledger.allBlocks().map((block) => block.residency)).toEqual(["system", "transcript"]);
    // Preparing again before the commit replaces the prepared set.
    ledger.prepareCompaction("loop:compaction:2", NOW + 5);
    ledger.markDeliveredInTransaction(ledger.pendingDeliveries(), NOW + 5);
    expect(ledger.applyCompactionInTransaction("loop:compaction:2", NOW + 6)).toEqual({ applied: true });
    expect(ledger.allBlocks().map((block) => [block.residency, block.compactionsRemaining]))
      .toEqual([["system", 1], ["system", 2]]);
  });

  it("invalidates every block of a kind at once, pending deliveries included", () => {
    const { ledger } = open();
    ledger.recordLoaded({ kind: KIND, sourceGeneration: 1, blocks: [root], now: NOW });
    ledger.markDeliveredInTransaction(ledger.pendingDeliveries(), NOW);
    compact(ledger, 1, NOW + 1);
    ledger.recordLoaded({ kind: KIND, sourceGeneration: 1, blocks: [nested], now: NOW + 3 });
    expect(ledger.invalidateKind({ kind: KIND })).toEqual({ retired: 2 });
    expect(ledger.residentBlocks({ kind: KIND })).toEqual([]);
    expect(ledger.pendingDeliveries()).toEqual([]);
    expect(ledger.renderSections()).toBeNull();
    expect(ledger.invalidateKind({ kind: KIND })).toEqual({ retired: 0 });
  });
});
