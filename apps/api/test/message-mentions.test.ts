import { describe, expect, it } from "vitest";

import {
  isCanonicalPersonMention,
  prepareMentionMarkdown,
  renderPersonMentionMarkdown,
} from "../src/lib/message-mentions";

const adaId = "00000000-0000-7000-8000-000000000042";
const graceId = "00000000-0000-7000-8000-000000000043";

describe("canonical person mention Markdown", () => {
  it("persists stable person identities and recalculates subsequent offsets", () => {
    const text = "Ask @Ada Lovelace and @Grace Hopper.";
    const prepared = prepareMentionMarkdown(text, [
      {
        type: "person",
        userId: adaId,
        connectorType: null,
        startOffset: 4,
        endOffset: 17,
      },
      {
        type: "person",
        userId: graceId,
        connectorType: null,
        startOffset: 22,
        endOffset: 35,
      },
    ], new Map([
      [adaId, { id: adaId, name: "Ada Lovelace", avatarUrl: "https://example.com/ada.png" }],
      [graceId, { id: graceId, name: "Grace Hopper", avatarUrl: null }],
    ]));

    expect(prepared.text).toBe(
      `Ask [@Ada Lovelace](person://${adaId}) and [@Grace Hopper](person://${graceId}).`,
    );
    expect(prepared.mentions).toHaveLength(2);
    expect(prepared.mentions[0]).toMatchObject({
      userId: adaId,
      displayName: "Ada Lovelace",
      avatarUrl: "https://example.com/ada.png",
      startOffset: 4,
    });
    expect(prepared.text.slice(
      prepared.mentions[1]!.startOffset,
      prepared.mentions[1]!.endOffset,
    )).toBe(`[@Grace Hopper](person://${graceId})`);
    expect(isCanonicalPersonMention(prepared.text, prepared.mentions[1]!)).toBe(true);
  });

  it("still recognizes a stored bare person: link as canonical", () => {
    const text = `Ask [@Ada Lovelace](person:${adaId}).`;
    expect(isCanonicalPersonMention(text, {
      type: "person",
      userId: adaId,
      startOffset: 4,
      endOffset: text.length - 1,
    })).toBe(true);
  });

  it("drops spoofed, missing, and duplicate identities without changing visible text", () => {
    const text = "Ask @Ada Lovelace.";
    const mention = {
      type: "person" as const,
      userId: graceId,
      connectorType: null,
      startOffset: 4,
      endOffset: 17,
    };
    const prepared = prepareMentionMarkdown(text, [mention, mention], new Map([
      [graceId, { id: graceId, name: "Grace Hopper", avatarUrl: null }],
    ]));

    expect(prepared).toEqual({ text, mentions: [] });
  });

  it("keeps the longest name when one member's name prefixes another's", () => {
    // A workspace holding both "Ada" and "Ada Lovelace" emits a range for each
    // against "@Ada Lovelace"; the writer meant the person they spelled out.
    const text = "Ask @Ada Lovelace.";
    const prepared = prepareMentionMarkdown(text, [
      { type: "person", userId: graceId, connectorType: null, startOffset: 4, endOffset: 8 },
      { type: "person", userId: adaId, connectorType: null, startOffset: 4, endOffset: 17 },
    ], new Map([
      [graceId, { id: graceId, name: "Ada", avatarUrl: null }],
      [adaId, { id: adaId, name: "Ada Lovelace", avatarUrl: null }],
    ]));

    expect(prepared.text).toBe(`Ask [@Ada Lovelace](person://${adaId}).`);
    expect(prepared.mentions.map((mention) => mention.userId)).toEqual([adaId]);
  });

  it("escapes labels in the Markdown link slot", () => {
    expect(renderPersonMentionMarkdown({
      id: adaId,
      name: "Ada \\] Lovelace",
      avatarUrl: null,
    })).toBe(`[@Ada ${"\\".repeat(3)}] Lovelace](person://${adaId})`);

    expect(renderPersonMentionMarkdown({
      id: graceId,
      name: "Grace [Compiler] Hopper",
      avatarUrl: null,
    })).toBe(`[@Grace \\[Compiler\\] Hopper](person://${graceId})`);
  });
});
