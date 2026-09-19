import assert from "node:assert/strict";
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

test("reads the namespace and table from the checked-in manifests", async () => {
  const tables = await lakehouseTables();

  assert.deepEqual(
    tables.map((table) => `${table.namespace}.${table.table}`),
    ["avalon.analytics_events", "avalon.llm_inference"],
  );
});

test("the repository's own documents pass", async () => {
  assert.deepEqual(await check(), []);
});
