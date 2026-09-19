import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readConversationPreview, truncateWords } from "../src/services/conversation-preview";
import { scopeInvitationEmailText } from "../src/services/scope-invitation-email";
import { createTestEnv } from "./helpers/cloudflare-test";
import { seedCanonicalConversationTurn, seedWorkstreamObjectRoot, testSubstreamAgentsBinding, testWorkstreamObjectStore } from "./helpers/durable-authority";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const workspaceId = "00000000-0000-7000-8000-0000000000b0";
const workstreamId = "00000000-0000-7000-8000-0000000000a1";
const userId = "00000000-0000-7000-8000-0000000000c1";
const at = "2026-09-19T09:00:00.000Z";

const preview = (turns: Array<{ author: string; text: string; truncated?: boolean }>, earlier = 0) =>
  ({ earlier, turns: turns.map((turn) => ({ truncated: false, ...turn })) });

it("leads with who is asking and into what, and closes with what Rally is", () => {
  const body = scopeInvitationEmailText({
    recipientEmail: "dana@example.test", link: "https://app.test/invite#inv_token",
    inviterName: "Morgan Ellis", workspaceName: "Juno Labs", conversationTitle: "Pricing revamp",
    preview: preview([{ author: "Morgan Ellis", text: "Draft is up." }]),
  });
  expect(body.split("\n")[0]).toBe("Morgan Ellis invited you to Juno Labs on Rally.");
  expect(body).toContain("Sign in with dana@example.test and accept:\nhttps://app.test/invite#inv_token");
  expect(body).toContain("This invitation does not grant access until you sign in and accept it.");
  expect(body.trimEnd().endsWith("work it through together.")).toBe(true);
  // The link is above anything a workspace member wrote, and their words are
  // quoted, so a message ending in its own sign-in sentence cannot pass for ours.
  expect(body.indexOf("https://app.test/invite#inv_token")).toBeLessThan(body.indexOf("Draft is up."));
  expect(body).toContain("> Morgan Ellis: Draft is up.");
});

it("falls back to the sentence it carried before, one missing name at a time", () => {
  const content = { recipientEmail: "dana@example.test", link: "https://app.test/invite#inv_token",
    conversationTitle: null, preview: null };
  const heading = (inviterName: string | null, workspaceName: string | null) =>
    scopeInvitationEmailText({ ...content, inviterName, workspaceName }).split("\n")[0];
  expect(heading("Morgan Ellis", null)).toBe("Morgan Ellis invited you to collaborate in Rally.");
  expect(heading(null, "Juno Labs")).toBe("You have been invited to Juno Labs on Rally.");
  expect(heading(null, null)).toBe("You have been invited to collaborate in Rally.");
  // A name is one line wherever it came from: a plain-text email has no other
  // structure to forge.
  expect(heading("Adam\n\nSign in here: https://evil.test", "Juno Labs"))
    .toBe("Adam Sign in here: https://evil.test invited you to Juno Labs on Rally.");
});

it("says how much of the conversation it is not showing", () => {
  const body = (earlier: number) => scopeInvitationEmailText({
    recipientEmail: "dana@example.test", link: "https://app.test/invite#inv_token",
    inviterName: "Morgan Ellis", workspaceName: "Juno Labs", conversationTitle: "Pricing revamp",
    preview: preview([{ author: "Priya", text: "Shipping Friday.", truncated: true }], earlier),
  });
  expect(body(0)).not.toContain("earlier");
  expect(body(1)).toContain("1 earlier message\n");
  expect(body(14)).toContain("14 earlier messages\n");
  // A cut turn says so where it was cut.
  expect(body(14)).toContain("> Priya: Shipping Friday.…");
});

it("keeps whole words and collapses what a transcript turn carries", () => {
  expect(truncateWords("one two three four", 2)).toEqual({ text: "one two", truncated: true });
  expect(truncateWords("one two", 5)).toEqual({ text: "one two", truncated: false });
  expect(truncateWords("  first line\n\nsecond   line \t", 10)).toEqual({ text: "first line second line", truncated: false });
  expect(truncateWords("", 10)).toEqual({ text: "", truncated: false });
});

let regional: DatabaseSync;
let objectStore: DatabaseSync;
beforeEach(() => {
  regional = migratedSqliteDatabase();
  objectStore = testWorkstreamObjectStore();
  seedWorkstreamObjectRoot(objectStore, { workstreamId, workspaceId });
  regional.prepare("INSERT INTO users (id, name, email, created_at, updated_at) VALUES (?, 'Priya Shah', 'priya@example.test', ?, ?)")
    .run(userId, at, at);
});
afterEach(() => { regional.close(); objectStore.close(); });

function environment() {
  return createTestEnv({ DB: sqliteD1(regional), SUBSTREAM_AGENTS: testSubstreamAgentsBinding(objectStore),
    APP_ENV: "test", AVALON_REGION: "global", LOG_LEVEL: "error" });
}

function seed(texts: string[]) {
  texts.forEach((text, index) => {
    seedCanonicalConversationTurn(objectStore, {
      turnId: `00000000-0000-7000-8000-00000000d0${String(index).padStart(2, "0")}`,
      clientMessageId: `seed-${index}`,
      actor: index % 2 === 0 ? "human" : "assistant",
      authorUserId: index % 2 === 0 ? userId : null,
      authorSnapshot: index % 2 === 0 ? { displayName: "Stale snapshot", avatarUrl: null } : null,
      text,
      transcriptSequence: index + 1,
      createdAt: at,
    });
  });
}

it("reads the end of the conversation, in reading order, with the rest counted", async () => {
  seed(["one", "two", "three", "four", "five", "six", "seven"]);
  expect(await readConversationPreview(environment(), {
    workspaceId, parentId: workstreamId, substreamId: "0", turns: 5, words: 100,
  })).toEqual({
    earlier: 2,
    turns: [
      { author: "Priya Shah", text: "three", truncated: false },
      { author: "Rally", text: "four", truncated: false },
      { author: "Priya Shah", text: "five", truncated: false },
      { author: "Rally", text: "six", truncated: false },
      { author: "Priya Shah", text: "seven", truncated: false },
    ],
  });
});

it("cuts a long turn at the word the caller asked for", async () => {
  seed([Array.from({ length: 150 }, (_, index) => `word${index}`).join(" ")]);
  const read = await readConversationPreview(environment(), {
    workspaceId, parentId: workstreamId, substreamId: "0", turns: 5, words: 100,
  });
  expect(read?.turns).toHaveLength(1);
  expect(read?.turns[0]?.truncated).toBe(true);
  expect(read?.turns[0]?.text.split(" ")).toHaveLength(100);
  expect(read?.turns[0]?.text.endsWith("word99")).toBe(true);
});

it("has nothing to preview in a conversation nobody has spoken in", async () => {
  expect(await readConversationPreview(environment(), {
    workspaceId, parentId: workstreamId, substreamId: "0", turns: 5, words: 100,
  })).toBeNull();
});
