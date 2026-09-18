import { expect, it } from "vitest";
import { BrowserSessionSchema } from "@rally/contracts/browser-session";
import { cookieClientSession } from "../src/session";

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

it("refuses an unconfigured deployment or a workspace routed through another deployment", () => {
  expect(() => cookieClientSession("unknown", metadata)).toThrow();
  expect(() => cookieClientSession("global", { ...metadata, workspace: { ...metadata.workspace!, region: "another" } })).toThrow("deployment does not match");
});
