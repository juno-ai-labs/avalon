#!/usr/bin/env node
// Blocks an API writer deployment until the independently deployed public site
// and desktop release can both read the workspace-addressed link it emits.

import { isEntryPoint } from "./entry-point.mjs";

// Fixed Base58 encodings of UUIDs 1, 2, and 3 in the probe namespace.
const PROBE_ORGANIZATION_ID = "1111117Hxt1fAWDjN7TW";
const PROBE_SPACE_ID = "1111117Hxt1fAWDjN7TX";
const PROBE_CHANNEL_ID = "1111117Hxt1fAWDjN7TY";

export function workspaceHandoffProbeUrl(baseUrl = "https://rallywith.ai") {
  return new URL(
    `/app/global/${PROBE_ORGANIZATION_ID}/s/${PROBE_SPACE_ID}/c/${PROBE_CHANNEL_ID}`,
    `${baseUrl.replace(/\/+$/u, "")}/`,
  ).toString();
}

export function workspaceHandoffDesktopManifestUrl(baseUrl = "https://downloads.rallywith.ai") {
  return new URL(
    "/stable/darwin/arm64/latest-mac.yml",
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
    || !body.includes("Open channel in Rally")
    || !body.includes('id="open-rally"')
  ) {
    throw new Error("The live site does not expose the addressed work-stream handoff marker");
  }
}

export async function assertWorkspaceHandoffDesktop(response) {
  if (!response.ok) {
    throw new Error(`Workspace-addressed desktop preflight returned HTTP ${response.status}`);
  }
  const body = await response.text();
  if (!/^# rally-workspace-handoff-version: 3$/mu.test(body)) {
    throw new Error("The live update channel does not contain a compatible desktop reader");
  }
}

async function main() {
  const siteUrl = workspaceHandoffProbeUrl(process.argv[2] ?? "https://rallywith.ai");
  const desktopUrl = workspaceHandoffDesktopManifestUrl(
    process.argv[3] ?? "https://downloads.rallywith.ai",
  );
  const [siteResponse, desktopResponse] = await Promise.all([
    fetch(siteUrl, {
      redirect: "follow",
      headers: { accept: "text/html", "cache-control": "no-cache" },
    }),
    fetch(desktopUrl, {
      redirect: "follow",
      headers: { accept: "application/yaml,text/yaml,text/plain", "cache-control": "no-cache" },
    }),
  ]);
  await Promise.all([
    assertWorkspaceHandoffSite(siteResponse),
    assertWorkspaceHandoffDesktop(desktopResponse),
  ]);
  console.log(`Workspace-addressed handoff readers are ready (${siteUrl}; ${desktopUrl}).`);
}

if (isEntryPoint(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Workspace handoff site preflight failed");
    process.exitCode = 1;
  });
}
