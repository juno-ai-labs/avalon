import assert from "node:assert/strict";
import test from "node:test";

import {
  assertWorkspaceHandoffDesktop,
  assertWorkspaceHandoffSite,
  workspaceHandoffDesktopManifestUrl,
  workspaceHandoffProbeUrl,
} from "./check-workspace-handoff-site.mjs";

test("the probe uses the canonical addressed workspace path", () => {
  assert.equal(
    workspaceHandoffProbeUrl("https://rallywith.ai"),
    "https://rallywith.ai/app/workspaces/global/00000000-0000-7000-8000-000000000001/"
      + "workstreams/00000000-0000-7000-8000-000000000002",
  );
});

test("the desktop probe uses the production arm64 update manifest", () => {
  assert.equal(
    workspaceHandoffDesktopManifestUrl("https://downloads.rallywith.ai"),
    "https://downloads.rallywith.ai/stable/darwin/arm64/latest-mac.yml",
  );
});

test("the deployed work-stream handoff page satisfies the rollout preflight", async () => {
  await assert.doesNotReject(() => assertWorkspaceHandoffSite(new Response(
    '<title>Open work stream in Rally</title><a id="open-rally">Open Rally</a>',
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
  )));
});

test("only a released desktop manifest carrying the addressed-reader marker passes", async () => {
  await assert.doesNotReject(() => assertWorkspaceHandoffDesktop(new Response(
    "# rally-workspace-handoff-version: 2\nversion: 1.234.0\n",
    { status: 200, headers: { "content-type": "application/yaml" } },
  )));
  await assert.rejects(
    () => assertWorkspaceHandoffDesktop(new Response("version: 1.233.0\n", { status: 200 })),
    /compatible desktop reader/u,
  );
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
