import { expect, it } from "vitest";
import { BrowserSessionSchema } from "@rally/contracts/browser-session";
import { uuidToBase58 } from "@rally/contracts/uuid-base58";
import { browserShellFor, cookieClientSession, memberShellLocation } from "../src/session";

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

it("mounts the member shell for members and keeps guests on the guest shell", () => {
  expect(browserShellFor(metadata)).toBe("guest");
  const member = { ...metadata.workspace!, accessClass: undefined };
  expect(browserShellFor({ workspace: { ...member, role: "member" } })).toBe("member");
  expect(browserShellFor({ workspace: { ...member, role: "member", accessClass: "member" } })).toBe("member");
});

it("rewrites canonical links into the member shell's hash routes", () => {
  const workspaceId = metadata.workspace!.id;
  const spaceId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const workstreamId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const substreamId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const base = `/app/global/${uuidToBase58(workspaceId)}/s/${uuidToBase58(spaceId)}`;
  expect(memberShellLocation(`${base}/c/${uuidToBase58(workstreamId)}`, ""))
    .toBe(`/app/workspaces/global/${workspaceId}#/workstreams/${workstreamId}?space=${spaceId}`);
  expect(memberShellLocation(`${base}/c/${uuidToBase58(workstreamId)}/b/${uuidToBase58(substreamId)}`, ""))
    .toBe(`/app/workspaces/global/${workspaceId}#/workstreams/${workstreamId}?substream=${substreamId}&space=${spaceId}`);
  expect(memberShellLocation(base, "")).toBe(`/app/workspaces/global/${workspaceId}#/spaces/${spaceId}`);
  expect(memberShellLocation(`/app/workspaces/global/${workspaceId}`, "")).toBe(`/app/workspaces/global/${workspaceId}#/`);
  expect(memberShellLocation(`/app/workspaces/global/${workspaceId}`, "#/settings")).toBeNull();
  expect(memberShellLocation("/login/email", "")).toBeNull();
});
