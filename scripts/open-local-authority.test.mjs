import assert from "node:assert/strict";
import test from "node:test";

import {
  localAuthorityRegions,
  localAuthorityTarget,
} from "./open-local-authority-sql.mjs";

test("local authority bootstrap covers configured regional Workers", () => {
  assert.deepEqual(localAuthorityRegions, ["global"]);
  assert.deepEqual(localAuthorityTarget("global"), {
    baseUrl: "http://127.0.0.1:8787",
    config: "wrangler.global.jsonc",
    state: ".wrangler/state/global",
  });
});
