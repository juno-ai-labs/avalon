import { expect, it } from "vitest";
import { BrowserSessionSchema } from "@rally/contracts/browser-session";
import { uuidToBase58 } from "@rally/contracts/uuid-base58";
import { cookieClientSession, inPlaceHash, shellLocation } from "../src/session";

const metadata = BrowserSessionSchema.parse({
  user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Guest", email: "guest@example.test", avatarUrl: null, timezone: "UTC", createdAt: "2026-09-17T00:00:00.000Z" },
  workspace: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Shared", slug: "shared", region: "global", role: null, accessClass: "guest", timezone: "UTC", createdAt: "2026-09-17T00:00:00.000Z" },
  expiresAt: "2026-10-01T00:00:00.000Z",
});

it("adapts browser metadata to the existing collaboration client without bearer credentials", () => {
  const session = cookieClientSession("global", metadata);
  expect(session.authentication).toBe("cookie");
  expect(session.apiBaseUrl).toBe(`/regional/global/browser/api/${metadata.workspace!.id}`);
  expect(session.user.id).toBe(metadata.user.id);
  expect(session.workspace?.accessClass).toBe("guest");
  expect(session).not.toHaveProperty("accessToken");
  expect(session).not.toHaveProperty("refreshToken");
  expect(session.user).not.toHaveProperty("avatarUrl");
  expect(cookieClientSession("global", { ...metadata, workspace: null }).apiBaseUrl).toBe("/regional/global/browser/api/_");
});

it("refuses an unconfigured deployment or an organization routed through another deployment", () => {
  expect(() => cookieClientSession("unknown", metadata)).toThrow();
  expect(() => cookieClientSession("global", { ...metadata, workspace: { ...metadata.workspace!, region: "another" } })).toThrow("deployment does not match");
});

it("rewrites canonical links into the shell's Canvas and Sidekick routes", () => {
  const workspaceId = metadata.workspace!.id;
  const spaceId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const workstreamId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const substreamId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const base = `/app/global/${uuidToBase58(workspaceId)}/s/${uuidToBase58(spaceId)}`;
  expect(shellLocation(`${base}/c/${uuidToBase58(workstreamId)}`, ""))
    .toBe(`/app/workspaces/global/${workspaceId}#/canvases/${workstreamId}`);
  expect(shellLocation(`${base}/c/${uuidToBase58(workstreamId)}/b/${uuidToBase58(substreamId)}`, ""))
    .toBe(`/app/workspaces/global/${workspaceId}#/canvases/${workstreamId}`);
  expect(shellLocation(`${base}/c/${uuidToBase58(workstreamId)}/a/${uuidToBase58(substreamId)}`, ""))
    .toBe(`/app/workspaces/global/${workspaceId}#/canvases/${workstreamId}`);
  expect(shellLocation(base, "")).toBe(`/app/workspaces/global/${workspaceId}#/canvases`);
  expect(shellLocation(`/app/global/${uuidToBase58(workspaceId)}/sk/${uuidToBase58(workstreamId)}/`, ""))
    .toBe(`/app/workspaces/global/${workspaceId}#/sidekicks/${workstreamId}`);
  expect(shellLocation(`/app/workspaces/global/${workspaceId}`, "")).toBe(`/app/workspaces/global/${workspaceId}#/`);
  expect(shellLocation(`/app/workspaces/global/${workspaceId}`, "#/settings")).toBeNull();
  expect(shellLocation("/login/email", "")).toBeNull();
});

it("routes an invitation's addressed conversation paths to the Canvas", () => {
  const workspaceId = metadata.workspace!.id;
  const workstreamId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const substreamId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const channel = `/app/workspaces/global/${workspaceId}/workstreams/${workstreamId}`;
  expect(shellLocation(channel, "")).toBe(`/app/workspaces/global/${workspaceId}#/canvases/${workstreamId}`);
  expect(shellLocation(`${channel}/substreams/${substreamId}`, ""))
    .toBe(`/app/workspaces/global/${workspaceId}#/canvases/${workstreamId}`);
});

it("routes a notification link in place only in the tab's own Organization", () => {
  const workspaceId = metadata.workspace!.id;
  const other = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const spaceId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const workstreamId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const link = `https://app.rallywith.ai/app/global/${uuidToBase58(workspaceId)}/s/${uuidToBase58(spaceId)}/c/${uuidToBase58(workstreamId)}`;
  expect(inPlaceHash(`/app/workspaces/global/${workspaceId}`, link)).toBe(`#/canvases/${workstreamId}`);
  expect(inPlaceHash(`/app/workspaces/global/${workspaceId}/`, link)).toBe(`#/canvases/${workstreamId}`);
  expect(inPlaceHash(`/app/workspaces/global/${other}`, link)).toBeNull();
  expect(inPlaceHash(`/app/workspaces/global/${workspaceId}`, "https://app.rallywith.ai/")).toBeNull();
});
