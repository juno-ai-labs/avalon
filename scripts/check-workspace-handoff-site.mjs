#!/usr/bin/env node
// Blocks an API writer deployment until the independently deployed public site
// can resolve the workspace-addressed handoff path that writer emits.

import { isEntryPoint } from "./entry-point.mjs";

const PROBE_WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const PROBE_WORKSTREAM_ID = "00000000-0000-7000-8000-000000000002";

export function workspaceHandoffProbeUrl(baseUrl = "https://rallywith.ai") {
  return new URL(
    `/app/workspaces/global/${PROBE_WORKSPACE_ID}/workstreams/${PROBE_WORKSTREAM_ID}`,
    `${baseUrl.replace(/\/+$/u, "")}/`,
  ).toString();
}

export async function assertWorkspaceHandoffSite(response) {
  if (!response.ok) {
    throw new Error(`Workspace-addressed handoff preflight returned HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  if (
    !contentType.toLowerCase().includes("text/html")
    || !body.includes("Open work stream in Rally")
    || !body.includes('id="open-rally"')
  ) {
    throw new Error("The live site does not expose the addressed work-stream handoff marker");
  }
}

async function main() {
  const baseUrl = process.argv[2] ?? "https://rallywith.ai";
  const url = workspaceHandoffProbeUrl(baseUrl);
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      accept: "text/html",
      "cache-control": "no-cache",
    },
  });
  await assertWorkspaceHandoffSite(response);
  console.log(`Workspace-addressed handoff site is ready (${url}).`);
}

if (isEntryPoint(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Workspace handoff site preflight failed");
    process.exitCode = 1;
  });
}
