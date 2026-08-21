import assert from "node:assert/strict";
import test from "node:test";

import { classifyPendingD1Migrations } from "./classify-pending-d1-migrations.mjs";

const retirement = "0090_drop_legacy_product_tables.sql";

test("keeps ordinary migration ordering when retirement is not pending", () => {
  assert.equal(
    classifyPendingD1Migrations("No migrations to apply!", retirement),
    "worker_first=false",
  );
});

test("selects Worker-first ordering when retirement is the sole pending migration", () => {
  assert.equal(
    classifyPendingD1Migrations(`┌─────────────────────────────────────────────┐
│ Name                                        │
├─────────────────────────────────────────────┤
│ ${retirement} │
└─────────────────────────────────────────────┘`, retirement),
    "worker_first=true",
  );
});

test("refuses to defer a later migration behind the retirement Worker", () => {
  assert.throws(
    () => classifyPendingD1Migrations(
      `${retirement}\n0091_require_new_worker_column.sql`,
      retirement,
    ),
    /must be the only pending migration.*0091_require_new_worker_column\.sql/u,
  );
});
