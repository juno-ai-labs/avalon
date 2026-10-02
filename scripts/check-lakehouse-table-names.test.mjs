import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  check,
  lakehouseTables,
  misqualifiedReferences,
} from "./check-lakehouse-table-names.mjs";

const INFERENCE = { namespace: "avalon", table: "llm_inference" };

test("catches the damage that prompted this check", () => {
  // Verbatim from docs/runbook.md, in the recipe for reading a run's raw
  // inference during an incident. The namespace is `avalon`; a rebrand sweep
  // rewrote it to the product name and the table stopped existing.
  const found = misqualifiedReferences(
    [
      "SELECT captured_at, event_id",
      "FROM rally.llm_inference",
      "WHERE workstream_id = '<workstream-uuid>'",
    ].join("\n"),
    INFERENCE,
  );

  assert.equal(found.length, 1);
  assert.equal(found[0].line, 2);
  assert.equal(found[0].found, "rally.llm_inference");
  assert.equal(found[0].expected, "avalon.llm_inference");
});

test("reports every misqualified reference, with its line", () => {
  const found = misqualifiedReferences(
    [
      "FROM rally.llm_inference",
      "",
      "FROM avalon.llm_inference",
      "",
      "  FROM warehouse.llm_inference",
    ].join("\n"),
    INFERENCE,
  );

  assert.deepEqual(found.map((problem) => problem.line), [1, 5]);
});

test("catches a query that dropped the namespace entirely", () => {
  assert.equal(misqualifiedReferences("FROM llm_inference\n", INFERENCE).length, 1);
  assert.equal(misqualifiedReferences("  JOIN llm_inference AS i\n", INFERENCE).length, 1);
});

/**
 * The manifest itself and the prose around it name the table without a
 * namespace. Neither is a query, and flagging them would make the check
 * unusable in the document that explains the table.
 */
test("leaves a bare mention outside a query alone", () => {
  assert.deepEqual(
    misqualifiedReferences(
      'namespace `avalon`, table `llm_inference`; Cloudflare creates the namespace\n',
      INFERENCE,
    ),
    [],
  );
});

test("catches a quoted identifier, which slips past a bare-word match", () => {
  const found = misqualifiedReferences('FROM "rally"."llm_inference"\n', INFERENCE);

  assert.equal(found.length, 1);
  assert.equal(found[0].found, "rally.llm_inference");
  assert.deepEqual(misqualifiedReferences('FROM "avalon"."llm_inference"\n', INFERENCE), []);
});

/** A quoting style the check cannot see is a wrong table that passes. */
test("catches the dialect quoting styles too", () => {
  assert.equal(misqualifiedReferences("FROM `rally`.`llm_inference`\n", INFERENCE).length, 1);
  assert.equal(misqualifiedReferences("FROM [rally].[llm_inference]\n", INFERENCE).length, 1);
  assert.deepEqual(misqualifiedReferences("FROM `avalon`.`llm_inference`\n", INFERENCE), []);
});

/**
 * A wrapped query is still a query. Matching line by line could not see one,
 * which made the check bypassable by ordinary SQL formatting.
 */
test("catches a reference split across lines, and reports where it starts", () => {
  const found = misqualifiedReferences(
    ["SELECT captured_at", "FROM", "  llm_inference", "WHERE 1 = 1"].join("\n"),
    INFERENCE,
  );

  assert.equal(found.length, 1);
  assert.equal(found[0].line, 2);
  assert.equal(found[0].found, "llm_inference");
  assert.equal(
    misqualifiedReferences("FROM rally\n  .llm_inference\n", INFERENCE).length,
    1,
  );
  assert.deepEqual(misqualifiedReferences("FROM avalon\n  .llm_inference\n", INFERENCE), []);
});

/**
 * R2 SQL is backed by an Iceberg catalog, whose namespace names are
 * case-sensitive, so a differently-cased qualifier names a table that does not
 * resolve. The matcher is case-insensitive so the mention is found; the
 * comparison is not, so it is reported.
 */
test("reports a qualifier that differs from the manifest only in case", () => {
  assert.equal(misqualifiedReferences("FROM AVALON.llm_inference\n", INFERENCE).length, 1);
});

/** A manifest name is an identifier today; a future one must not be a pattern. */
test("treats a table name as a literal rather than a pattern", () => {
  const dotted = { namespace: "avalon", table: "llm.inference" };

  // Unescaped, the manifest's `.` matches the `X` and reports a table that
  // was never named.
  assert.deepEqual(misqualifiedReferences("FROM rally.llmXinference\n", dotted), []);
  assert.equal(misqualifiedReferences("FROM rally.llm.inference\n", dotted).length, 1);
});

/**
 * Drives `check()` end to end: manifest discovery, the document walk, and the
 * reported shape. Asserting only that the real `docs/` tree comes back empty
 * would pass just as well if the walk silently found no files at all.
 */
test("check() walks a tree and reports the offending file, line and names", async () => {
  const root = await mkdtemp(join(tmpdir(), "lakehouse-check-"));
  try {
    await mkdir(join(root, "docs", "nested"), { recursive: true });
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(
      join(root, "config", "inference-lakehouse.json"),
      JSON.stringify({ namespace: "avalon", table: "llm_inference" }),
    );
    await writeFile(
      join(root, "docs", "clean.md"),
      "SELECT 1\nFROM avalon.llm_inference\n",
    );
    await writeFile(
      join(root, "docs", "nested", "broken.md"),
      "# Runbook\n\nSELECT 1\nFROM rally.llm_inference\n",
    );

    assert.deepEqual(await check(join(root, "docs"), join(root, "config")), [{
      file: join(root, "docs", "nested", "broken.md"),
      line: 4,
      text: "FROM rally.llm_inference",
      found: "rally.llm_inference",
      expected: "avalon.llm_inference",
      manifest: join(root, "config", "inference-lakehouse.json"),
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("names the manifest a syntax error came from", async () => {
  const root = await mkdtemp(join(tmpdir(), "lakehouse-check-"));
  try {
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config", "broken.json"), "{ not json");

    await assert.rejects(
      lakehouseTables(join(root, "config")),
      (error) => error.message.includes(join(root, "config", "broken.json")),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** Dated proposals are history; see the note beside `EXCLUDED`. */
test("leaves docs/PRDs alone", async () => {
  const root = await mkdtemp(join(tmpdir(), "lakehouse-check-"));
  try {
    await mkdir(join(root, "docs", "PRDs", "2026-01-01-thing"), { recursive: true });
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(
      join(root, "config", "inference-lakehouse.json"),
      JSON.stringify({ namespace: "avalon", table: "llm_inference" }),
    );
    await writeFile(
      join(root, "docs", "PRDs", "2026-01-01-thing", "prd.md"),
      "As proposed then:\n\nFROM rally.llm_inference\n",
    );

    assert.deepEqual(await check(join(root, "docs"), join(root, "config")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
