import assert from "node:assert/strict";
import test from "node:test";

import {
  assertWorkspaceHandoffSite,
  workspaceHandoffProbeUrl,
} from "./check-workspace-handoff-site.mjs";

test("the probe uses the canonical addressed workspace path", () => {
  assert.equal(
    workspaceHandoffProbeUrl("https://rallywith.ai"),
    "https://rallywith.ai/app/workspaces/global/00000000-0000-7000-8000-000000000001/"
      + "workstreams/00000000-0000-7000-8000-000000000002",
  );
});

test("the deployed work-stream handoff page satisfies the rollout preflight", async () => {
  await assert.doesNotReject(() => assertWorkspaceHandoffSite(new Response(
    '<title>Open work stream in Rally</title><a id="open-rally">Open Rally</a>',
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
  )));
});

test("a missing rewrite or an unrelated success page fails closed", async () => {
  await assert.rejects(
    () => assertWorkspaceHandoffSite(new Response("not found", { status: 404 })),
    /HTTP 404/u,
  );
  await assert.rejects(
    () => assertWorkspaceHandoffSite(new Response("<title>Rally</title>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })),
    /addressed work-stream handoff marker/u,
  );
});
