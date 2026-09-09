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

  it("records a load once with a pending delivery and reports a resident block as already resident", () => {
    const { ledger } = open();
    expect(ledger.recordLoaded({ kind: KIND, sourceGeneration: 1, blocks: [root, nested], now: NOW }))
      .toEqual({ recorded: ["AGENTS.md", "apps/api/AGENTS.md"], alreadyResident: [] });
    expect(ledger.residentBlocks({ kind: KIND })).toEqual([`AGENTS.md@${root.sha256}`, `apps/api/AGENTS.md@${nested.sha256}`]);
    expect(ledger.pendingDeliveries().map((delivery) => delivery.sourceId))
      .toEqual([`AGENTS.md@${root.sha256}`, `apps/api/AGENTS.md@${nested.sha256}`]);
    expect(ledger.recordLoaded({ kind: KIND, sourceGeneration: 1, blocks: [root], now: NOW + 1 }))
      .toEqual({ recorded: [], alreadyResident: ["AGENTS.md"] });
    expect(ledger.markDeliveredInTransaction(ledger.pendingDeliveries(), NOW + 2))
      .toEqual([`AGENTS.md@${root.sha256}`, `apps/api/AGENTS.md@${nested.sha256}`]);
    expect(ledger.pendingDeliveries()).toEqual([]);
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
    expect(ledger.residentBlocks({ kind: KIND })).toEqual([`AGENTS.md@${edited.sha256}`]);
  });

  it("moves transcript blocks into the prompt at a compaction, once per event, and renders the section from the proposed state first", () => {
    const { ledger } = open();
    ledger.recordLoaded({ kind: KIND, sourceGeneration: 1, blocks: [root, nested], now: NOW });
    ledger.markDeliveredInTransaction(ledger.pendingDeliveries(), NOW);
    expect(ledger.renderSections()).toBeNull();
    const proposed = ledger.prepareCompaction();
    expect(proposed).toContain("# Repository instructions");
    expect(proposed).toContain("Instructions added from ./AGENTS.md:\nroot rules");
    expect(proposed).toContain("Instructions added from ./apps/api/AGENTS.md:\napi rules");
    // Preparing wrote nothing.
    expect(ledger.renderSections()).toBeNull();
    expect(ledger.applyCompactionInTransaction("loop:compaction:1", NOW + 1)).toEqual({ applied: true });
    expect(ledger.renderSections()).toBe(proposed);
    expect(ledger.allBlocks().map((block) => [block.residency, block.compactionsRemaining]))
      .toEqual([["system", 2], ["system", 2]]);
    // A replayed commit changes nothing.
    expect(ledger.applyCompactionInTransaction("loop:compaction:1", NOW + 2)).toEqual({ applied: false });
    expect(ledger.allBlocks().map((block) => block.compactionsRemaining)).toEqual([2, 2]);
    ledger.applyCompactionInTransaction("loop:compaction:2", NOW + 3);
    ledger.applyCompactionInTransaction("loop:compaction:3", NOW + 4);
    expect(ledger.allBlocks().map((block) => [block.residency, block.compactionsRemaining]))
      .toEqual([["system", 0], ["system", 0]]);
    expect(ledger.renderSections()).toBe(proposed);
    ledger.applyCompactionInTransaction("loop:compaction:4", NOW + 5);
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
    ledger.applyCompactionInTransaction("loop:compaction:1", NOW + 1);
    const edited = { ...root, sha256: "c".repeat(64), content: "new root rules" };
    ledger.recordLoaded({ kind: KIND, sourceGeneration: 1, blocks: [edited], now: NOW + 2 });
    // The old block stays in the prompt; the prefix does not change mid-run.
    expect(ledger.renderSections()).toContain("root rules");
    expect(ledger.renderSections()).not.toContain("new root rules");
    expect(ledger.allBlocks().map((block) => [block.sha256[0], block.residency, block.superseded]))
      .toEqual([["a", "system", true], ["c", "transcript", false]]);
    ledger.applyCompactionInTransaction("loop:compaction:2", NOW + 3);
    expect(ledger.allBlocks().map((block) => [block.sha256[0], block.residency, block.compactionsRemaining]))
      .toEqual([["a", "none", 0], ["c", "system", 2]]);
    expect(ledger.renderSections()).toContain("new root rules");
  });

  it("invalidates every block of a kind at once, pending deliveries included", () => {
    const { ledger } = open();
    ledger.recordLoaded({ kind: KIND, sourceGeneration: 1, blocks: [root], now: NOW });
    ledger.markDeliveredInTransaction(ledger.pendingDeliveries(), NOW);
    ledger.applyCompactionInTransaction("loop:compaction:1", NOW + 1);
    ledger.recordLoaded({ kind: KIND, sourceGeneration: 1, blocks: [nested], now: NOW + 2 });
    expect(ledger.invalidateKind({ kind: KIND })).toEqual({ retired: 2 });
    expect(ledger.residentBlocks({ kind: KIND })).toEqual([]);
    expect(ledger.pendingDeliveries()).toEqual([]);
    expect(ledger.renderSections()).toBeNull();
    expect(ledger.invalidateKind({ kind: KIND })).toEqual({ retired: 0 });
  });
});
