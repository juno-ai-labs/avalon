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

it("rewrites Canvas and Sidekick links into the shell's hash routes", () => {
  const workspaceId = metadata.workspace!.id;
  const canvasId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const artifactId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const organization = `/app/global/${uuidToBase58(workspaceId)}`;
  expect(shellLocation(`${organization}/cv/${uuidToBase58(canvasId)}/`, ""))
    .toBe(`/app/workspaces/global/${workspaceId}#/canvases/${canvasId}`);
  expect(shellLocation(`${organization}/cv/${uuidToBase58(canvasId)}`, ""))
    .toBe(`/app/workspaces/global/${workspaceId}#/canvases/${canvasId}`);
  expect(shellLocation(`${organization}/cv/${uuidToBase58(canvasId)}/a/${uuidToBase58(artifactId)}/`, ""))
    .toBe(`/app/workspaces/global/${workspaceId}#/canvases/${canvasId}?artifact=${artifactId}`);
  expect(shellLocation(`${organization}/sk/${uuidToBase58(canvasId)}/`, ""))
    .toBe(`/app/workspaces/global/${workspaceId}#/sidekicks/${canvasId}`);
  expect(shellLocation(`/app/workspaces/global/${workspaceId}`, "")).toBe(`/app/workspaces/global/${workspaceId}#/`);
  expect(shellLocation(`/app/workspaces/global/${workspaceId}`, "#/settings")).toBeNull();
  expect(shellLocation("/login/email", "")).toBeNull();
});

it("routes no Space or Breakout link into the shell, and a Thread link as its Canvas", () => {
  const workspaceId = metadata.workspace!.id;
  const spaceId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const threadId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const space = `/app/global/${uuidToBase58(workspaceId)}/s/${uuidToBase58(spaceId)}`;
  for (const retired of [
    space,
    `${space}/c/${uuidToBase58(threadId)}/b/${uuidToBase58(spaceId)}`,
    `/app/workstreams/${threadId}`,
  ]) {
    expect(shellLocation(retired, "")).toBeNull();
    expect(inPlaceHash(`/app/workspaces/global/${workspaceId}`, `https://app.rallywith.ai${retired}`)).toBeNull();
  }
  // A Thread's own link opens the Canvas a conversion kept under its id.
  for (const thread of [`${space}/c/${uuidToBase58(threadId)}`, `/app/workspaces/global/${workspaceId}/workstreams/${threadId}`]) {
    expect(shellLocation(thread, "")).toBe(`/app/workspaces/global/${workspaceId}#/canvases/${threadId}`);
    expect(inPlaceHash(`/app/workspaces/global/${workspaceId}`, `https://app.rallywith.ai${thread}`)).toBe(`#/canvases/${threadId}`);
  }
});

it("routes a notification link in place only in the tab's own Organization", () => {
  const workspaceId = metadata.workspace!.id;
  const other = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const canvasId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const link = `https://app.rallywith.ai/app/global/${uuidToBase58(workspaceId)}/cv/${uuidToBase58(canvasId)}/`;
  expect(inPlaceHash(`/app/workspaces/global/${workspaceId}`, link)).toBe(`#/canvases/${canvasId}`);
  expect(inPlaceHash(`/app/workspaces/global/${workspaceId}/`, link)).toBe(`#/canvases/${canvasId}`);
  expect(inPlaceHash(`/app/workspaces/global/${other}`, link)).toBeNull();
  expect(inPlaceHash(`/app/workspaces/global/${workspaceId}`, "https://app.rallywith.ai/")).toBeNull();
  // A pinned Canvas's new version opens the Canvas onto that artifact, in place too.
  const artifactId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  expect(inPlaceHash(`/app/workspaces/global/${workspaceId}`, `${link}a/${uuidToBase58(artifactId)}/`))
    .toBe(`#/canvases/${canvasId}?artifact=${artifactId}`);
});

it("opens a push link at the message it names, in a new tab and in place", () => {
  const workspaceId = metadata.workspace!.id;
  const canvasId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const turnId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const path = `/app/global/${uuidToBase58(workspaceId)}/cv/${uuidToBase58(canvasId)}/`;
  const route = `#/canvases/${canvasId}?turn=${turnId}&sequence=12`;
  expect(shellLocation(path, "", `?turn=${turnId}&sequence=12`)).toBe(`/app/workspaces/global/${workspaceId}${route}`);
  expect(inPlaceHash(`/app/workspaces/global/${workspaceId}`, `https://app.rallywith.ai${path}?turn=${turnId}&sequence=12`)).toBe(route);
  // A query that is not a message leaves the Canvas link opening the Canvas.
  expect(shellLocation(path, "", "?utm_source=mail")).toBe(`/app/workspaces/global/${workspaceId}#/canvases/${canvasId}`);
  expect(shellLocation(path, "", `?turn=${turnId}&sequence=0`)).toBe(`/app/workspaces/global/${workspaceId}#/canvases/${canvasId}`);
});
