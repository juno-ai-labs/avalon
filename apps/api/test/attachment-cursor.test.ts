import { describe, expect, it } from "vitest";

import {
  AttachmentCursorError,
  openAttachmentCursor,
  sealAttachmentCursor,
} from "../src/lib/attachment-cursor";
import { hmacSha256 } from "../src/lib/crypto";

const SECRET = "test-session-signing-key-with-enough-entropy";

describe("attachment cursors", () => {
  it("round-trips a bounded purpose-tagged payload", async () => {
    const cursor = await sealAttachmentCursor(SECRET, {
      purpose: "workstream-read",
      expiresAt: Date.now() + 60_000,
      principal: "user:019ff769-f7a4-70c8-87a7-16722ff2ce43",
      scopeId: "019ff769-f7a4-70c8-87a7-16722ff2ce44",
      state: { resourceId: "019ff769-f7a4-70c8-87a7-16722ff2ce45", offset: 12_000 },
    });
    expect(cursor.length).toBeLessThanOrEqual(2_048);
    await expect(openAttachmentCursor(SECRET, cursor, {
      purpose: "workstream-read",
      principal: "user:019ff769-f7a4-70c8-87a7-16722ff2ce43",
      scopeId: "019ff769-f7a4-70c8-87a7-16722ff2ce44",
      now: Date.now(),
    })).resolves.toMatchObject({ state: { offset: 12_000 } });
  });

  it("rejects tampering and a cursor replayed across purpose, principal, or scope", async () => {
    const cursor = await sealAttachmentCursor(SECRET, {
      purpose: "workstream-list",
      expiresAt: Date.now() + 60_000,
      principal: "workspace:one",
      scopeId: "workstream-one",
      state: { limit: 25 },
    });
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("a") ? "b" : "a"}`;
    await expect(openAttachmentCursor(SECRET, tampered, {
      purpose: "workstream-list", principal: "workspace:one", scopeId: "workstream-one",
    })).rejects.toMatchObject({ code: "invalid_cursor" });
    await expect(openAttachmentCursor(SECRET, cursor, {
      purpose: "workstream-read", principal: "workspace:one", scopeId: "workstream-one",
    })).rejects.toMatchObject({ code: "invalid_cursor" });
    await expect(openAttachmentCursor(SECRET, cursor, {
      purpose: "workstream-list", principal: "workspace:two", scopeId: "workstream-one",
    })).rejects.toMatchObject({ code: "invalid_cursor" });
    await expect(openAttachmentCursor(SECRET, cursor, {
      purpose: "workstream-list", principal: "workspace:one", scopeId: "workstream-two",
    })).rejects.toMatchObject({ code: "invalid_cursor" });
  });

  it("distinguishes expiry and bounds malformed cursors", async () => {
    const cursor = await sealAttachmentCursor(SECRET, {
      purpose: "workstream-read",
      expiresAt: 1_000,
      principal: "user:one",
      scopeId: "workstream-one",
      state: {},
    });
    await expect(openAttachmentCursor(SECRET, cursor, {
      purpose: "workstream-read", principal: "user:one", scopeId: "workstream-one", now: 1_001,
    })).rejects.toEqual(new AttachmentCursorError("cursor_expired", "Attachment cursor expired"));
    await expect(openAttachmentCursor(SECRET, "x".repeat(2_049), {
      purpose: "workstream-read", principal: "user:one", scopeId: "workstream-one",
    })).rejects.toMatchObject({ code: "invalid_cursor" });
  });

  it("opens a cursor sealed under the separator used before the rename", async () => {
    // A cursor is valid for an hour and is held by an agent run between
    // paginated tool calls, so a deploy lands mid-run. Rejecting the superseded
    // separator interrupts a run holding an authentic, unexpired cursor.
    const payload = { version: 1, purpose: "workstream-read", expiresAt: 10_000,
      principal: "user:one", scopeId: "workstream-one", state: {} };
    const encoded = btoa(JSON.stringify(payload)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    const legacySecret = await hmacSha256(SECRET, "avalon:attachment-cursor:v1");
    const legacyCursor = `${encoded}.${await hmacSha256(legacySecret, encoded)}`;
    await expect(openAttachmentCursor(SECRET, legacyCursor, {
      purpose: "workstream-read", principal: "user:one", scopeId: "workstream-one", now: 1,
    })).resolves.toMatchObject({ purpose: "workstream-read", scopeId: "workstream-one" });
  });
});
