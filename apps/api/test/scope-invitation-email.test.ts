import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readConversationPreview, truncateTurn, truncateWords } from "../src/services/conversation-preview";
import { PREVIEW_BYTES, PREVIEW_TURNS, PREVIEW_WORDS, scopeInvitationEmailParts } from "../src/services/scope-invitation-email";
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
  const { text: body } = scopeInvitationEmailParts({
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
    scopeInvitationEmailParts({ ...content, inviterName, workspaceName }).text.split("\n")[0];
  expect(heading("Morgan Ellis", null)).toBe("Morgan Ellis invited you to collaborate in Rally.");
  expect(heading(null, "Juno Labs")).toBe("You have been invited to Juno Labs on Rally.");
  expect(heading(null, null)).toBe("You have been invited to collaborate in Rally.");
  // A name is one line wherever it came from: a plain-text email has no other
  // structure to forge.
  expect(heading("Adam\n\nSign in here: https://evil.test", "Juno Labs"))
    .toBe("Adam Sign in here: https://evil.test invited you to Juno Labs on Rally.");
});

it("says how much of the conversation it is not showing", () => {
  const body = (earlier: number) => scopeInvitationEmailParts({
    recipientEmail: "dana@example.test", link: "https://app.test/invite#inv_token",
    inviterName: "Morgan Ellis", workspaceName: "Juno Labs", conversationTitle: "Pricing revamp",
    preview: preview([{ author: "Priya", text: "Shipping Friday.", truncated: true }], earlier),
  }).text;
  expect(body(0)).not.toContain("earlier");
  expect(body(1)).toContain("1 earlier message\n");
  expect(body(14)).toContain("14 earlier messages\n");
  // A cut turn says so where it was cut.
  expect(body(14)).toContain("> Priya: Shipping Friday.…");
});

it("styles the same message with only what every client renders", () => {
  const { html, text } = scopeInvitationEmailParts({
    recipientEmail: "dana@example.test", link: "https://app.test/invite#inv_token",
    inviterName: "Morgan Ellis", workspaceName: "Juno Labs", conversationTitle: "Pricing revamp",
    preview: preview([{ author: "Priya Shah", text: "Shipping Friday." }], 14),
  });
  // Tables and inline styles. A `<style>` block is dropped in several of
  // Gmail's surfaces, so nothing load-bearing may live in one, and the layout
  // techniques below each fail somewhere popular.
  expect(html).not.toContain("<style");
  expect(html).not.toContain("@media");
  expect(html).not.toContain("@font-face");
  for (const unsupported of ["display:flex", "display:grid", "position:absolute", "position:fixed", "background-image", "!important"]) {
    expect(html).not.toContain(unsupported);
  }
  expect(html).toContain('<table role="presentation"');
  expect(html).toContain("max-width:560px");
  // Everything the text part says, said again.
  expect(html).toContain("Morgan Ellis");
  expect(html).toContain("Juno Labs");
  expect(html).toContain('href="https://app.test/invite#inv_token"');
  expect(html).toContain("Pricing revamp");
  expect(html).toContain("14 earlier messages");
  expect(html).toContain("Priya Shah");
  expect(html).toContain("Shipping Friday.");
  expect(html).toContain(text.trimEnd().split("\n").at(-1)!);
  // The button is above anything a member wrote, in both parts.
  expect(html.indexOf("Accept invitation")).toBeLessThan(html.indexOf("Shipping Friday."));
  // Gmail clips a message past 102 KiB, which would cut the footer off.
  expect(html.length).toBeLessThan(102 * 1024);
});

it("renders member-written turns as text, never as markup", () => {
  const { html } = scopeInvitationEmailParts({
    recipientEmail: "dana@example.test", link: "https://app.test/invite#inv_token",
    inviterName: "<script>alert(1)</script>", workspaceName: "Juno & Co",
    conversationTitle: "Pricing <b>revamp</b>",
    preview: preview([{ author: "Priya \"PS\" Shah", text: "Ship it <img src=x onerror=alert(1)>" }]),
  });
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<img src=x");
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html).toContain("Juno &amp; Co");
  expect(html).toContain("Pricing &lt;b&gt;revamp&lt;/b&gt;");
  expect(html).toContain("Priya &quot;PS&quot; Shah");
  expect(html).toContain("Ship it &lt;img src=x onerror=alert(1)&gt;");
});

it("has no preview block when there is nothing to quote", () => {
  const { html } = scopeInvitationEmailParts({
    recipientEmail: "dana@example.test", link: "https://app.test/invite#inv_token",
    inviterName: null, workspaceName: null, conversationTitle: null, preview: null,
  });
  expect(html).toContain("Join the conversation");
  expect(html).toContain("You have been invited to collaborate in Rally.");
  expect(html).not.toContain("border-left");
});

it("keeps whole words and collapses what a transcript turn carries", () => {
  expect(truncateWords("one two three four", 2)).toEqual({ text: "one two", truncated: true });
  expect(truncateWords("one two", 5)).toEqual({ text: "one two", truncated: false });
  expect(truncateWords("  first line\n\nsecond   line \t", 10)).toEqual({ text: "first line second line", truncated: false });
  expect(truncateWords("", 10)).toEqual({ text: "", truncated: false });
});

it("bounds a turn by bytes as well as words, because one word can be a whole message", () => {
  // A message with no spaces is one word however long it is.
  const unbroken = "x".repeat(100_000);
  const cut = truncateTurn(unbroken, PREVIEW_WORDS, PREVIEW_BYTES);
  expect(cut.truncated).toBe(true);
  expect(new TextEncoder().encode(cut.text).length).toBeLessThanOrEqual(PREVIEW_BYTES);
  // Cut by code point, so a multi-byte character is never split in half.
  const emoji = truncateTurn("🙂".repeat(50_000), PREVIEW_WORDS, PREVIEW_BYTES);
  expect(new TextEncoder().encode(emoji.text).length).toBeLessThanOrEqual(PREVIEW_BYTES);
  expect(emoji.text).toBe("🙂".repeat([...emoji.text].length));
  expect([...emoji.text].every((character) => character === "🙂")).toBe(true);
  // Ordinary prose is untouched by the byte ceiling.
  expect(truncateTurn("a short message", PREVIEW_WORDS, PREVIEW_BYTES)).toEqual({ text: "a short message", truncated: false });
});

it("stays under Gmail's clipping ceiling on the worst input the preview can carry", () => {
  // Every turn maximal, and every character the one that escapes longest, which
  // is the case the byte ceiling is derived from.
  const maximal = truncateTurn('"'.repeat(PREVIEW_BYTES * 2), PREVIEW_WORDS, PREVIEW_BYTES);
  const { html, text } = scopeInvitationEmailParts({
    recipientEmail: "dana@example.test", link: "https://app.test/invite#inv_token",
    inviterName: "Morgan Ellis", workspaceName: "Juno Labs", conversationTitle: "Pricing revamp",
    preview: { earlier: 14, turns: Array.from({ length: PREVIEW_TURNS }, () => ({ author: "Priya Shah", ...maximal })) },
  });
  expect(new TextEncoder().encode(html).length).toBeLessThan(102 * 1024);
  expect(new TextEncoder().encode(text).length).toBeLessThan(102 * 1024);
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

it("renders transcript Markdown as plain text in both email parts", async () => {
  seed(["Review **[the launch plan](https://docs.example.test/launch)** with `Alex`."]);
  const conversation = await readConversationPreview(environment(), {
    workspaceId, parentId: workstreamId, substreamId: "0", turns: 5, words: 100, bytes: PREVIEW_BYTES,
  });
  const { html, text } = scopeInvitationEmailParts({
    recipientEmail: "dana@example.test", link: "https://app.test/invite#inv_token",
    inviterName: "Morgan Ellis", workspaceName: "Juno Labs", conversationTitle: "Pricing revamp",
    preview: conversation,
  });
  const rendered = "Review the launch plan with Alex.";
  expect(text).toContain(`> Priya Shah: ${rendered}`);
  expect(html).toContain(rendered);
  for (const part of [text, html]) {
    expect(part).not.toContain("https://docs.example.test/launch");
    expect(part).not.toContain("**");
    expect(part).not.toContain("`Alex`");
  }
});

it("reduces Markdown before applying the visible-word limit", async () => {
  seed(["Review [the launch plan](https://docs.example.test/launch) today."]);
  expect(await readConversationPreview(environment(), {
    workspaceId, parentId: workstreamId, substreamId: "0", turns: 5, words: 3, bytes: PREVIEW_BYTES,
  })).toEqual({
    earlier: 0,
    turns: [{ author: "Priya Shah", text: "Review the launch", truncated: true }],
  });
});

it("keeps formatting-only turns visible without breaking the contiguous preview", async () => {
  seed(["Readable context.", "***"]);
  expect(await readConversationPreview(environment(), {
    workspaceId, parentId: workstreamId, substreamId: "0", turns: 5, words: 100, bytes: PREVIEW_BYTES,
  })).toEqual({
    earlier: 0,
    turns: [
      { author: "Priya Shah", text: "Readable context.", truncated: false },
      { author: "Rally", text: "Formatting-only message.", truncated: false },
    ],
  });
});

it("reads the end of the conversation, in reading order, with the rest counted", async () => {
  seed(["one", "two", "three", "four", "five", "six", "seven"]);
  expect(await readConversationPreview(environment(), {
    workspaceId, parentId: workstreamId, substreamId: "0", turns: 5, words: 100, bytes: PREVIEW_BYTES,
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
    workspaceId, parentId: workstreamId, substreamId: "0", turns: 5, words: 100, bytes: PREVIEW_BYTES,
  });
  expect(read?.turns).toHaveLength(1);
  expect(read?.turns[0]?.truncated).toBe(true);
  expect(read?.turns[0]?.text.split(" ")).toHaveLength(100);
  expect(read?.turns[0]?.text.endsWith("word99")).toBe(true);
});

it("has nothing to preview in a conversation nobody has spoken in", async () => {
  expect(await readConversationPreview(environment(), {
    workspaceId, parentId: workstreamId, substreamId: "0", turns: 5, words: 100, bytes: PREVIEW_BYTES,
  })).toBeNull();
});
it("names the conversation in both parts, or in neither", () => {
  // A transcript read that fails while the title read succeeds is the case the
  // two parts used to disagree about: the styled part put the title in its
  // heading and the plain one dropped it with the quotes it never got.
  const { text, html } = scopeInvitationEmailParts({
    recipientEmail: "guest@example.test", link: "https://app.test/invite#inv_token",
    inviterName: "Adam Owner", workspaceName: "Juno Labs",
    conversationTitle: "Pricing for the Q4 launch", preview: null,
  });
  expect(text).toContain("Pricing for the Q4 launch");
  expect(html).toContain("Pricing for the Q4 launch");
  expect(text).not.toContain(">");
});
