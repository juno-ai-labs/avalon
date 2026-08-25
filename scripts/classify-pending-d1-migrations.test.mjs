import assert from "node:assert/strict";
import test from "node:test";

import { classifyPendingD1Migrations } from "./classify-pending-d1-migrations.mjs";

const retirement = "0090_drop_legacy_product_tables.sql";
const inferenceRetirement = "0094_retire_agent_inference_payload_ledger.sql";
const fullEmailRoutes = "0097_email_routes_use_full_address.sql";
const workerFirst = [retirement, inferenceRetirement, fullEmailRoutes];

test("keeps ordinary migration ordering when retirement is not pending", () => {
  assert.equal(
    classifyPendingD1Migrations("No migrations to apply!", workerFirst),
    "worker_first=false",
  );
});

test("selects Worker-first ordering when retirement is the sole pending migration", () => {
  assert.equal(
    classifyPendingD1Migrations(`┌─────────────────────────────────────────────┐
│ Name                                        │
├─────────────────────────────────────────────┤
│ ${retirement} │
└─────────────────────────────────────────────┘`, workerFirst),
    "worker_first=true",
  );
});

test("selects Worker-first ordering for inference-ledger retirement", () => {
  assert.equal(
    classifyPendingD1Migrations(inferenceRetirement, workerFirst),
    "worker_first=true",
  );
});

test("selects Worker-first ordering for the full-address registry cutover", () => {
  assert.equal(
    classifyPendingD1Migrations(fullEmailRoutes, workerFirst),
    "worker_first=true",
  );
});

test("refuses to defer a later migration behind the retirement Worker", () => {
  assert.throws(
    () => classifyPendingD1Migrations(
      `${retirement}\n0091_require_new_worker_column.sql`,
      workerFirst,
    ),
    /must be the only pending migration.*0091_require_new_worker_column\.sql/u,
  );
});

test("refuses two Worker-first migrations in one deployment", () => {
  assert.throws(
    () => classifyPendingD1Migrations(
      `${retirement}\n${inferenceRetirement}`,
      workerFirst,
    ),
    /Only one Worker-first migration may be pending/u,
  );
});
