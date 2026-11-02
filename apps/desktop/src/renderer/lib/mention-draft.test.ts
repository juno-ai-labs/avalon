import { describe, expect, it } from 'vitest';

import type { MentionIdentity } from './api';
import {
  completeMentionAtCaret,
  mentionsInTrimmedText,
  rebaseMentionIdentities,
  resolveMentionPayload,
  sidekickMentionsAsMarkdown,
  upsertMentionIdentity,
} from './mention-draft';

function person(label: string, userId: string, startOffset?: number): MentionIdentity {
  return {
    type: 'person',
    label,
    userId,
    connectorType: null,
    ...(startOffset === undefined ? {} : {
      startOffset,
      endOffset: startOffset + label.length + 1,
    }),
  };
}

describe('mention drafts', () => {
  it('completes the query and returns the exact visible range', () => {
    expect(completeMentionAtCaret('Ask @sa today', 7, 'Sam Lee')).toEqual({
      text: 'Ask @Sam Lee today',
      caret: 12,
      startOffset: 4,
      endOffset: 12,
    });
  });

  it('replaces the selected suffix when completing a query', () => {
    expect(completeMentionAtCaret('Ask @sa today', 7, 'Sam Lee', 13)).toEqual({
      text: 'Ask @Sam Lee ',
      caret: 13,
      startOffset: 4,
      endOffset: 12,
    });
  });

  it('moves untouched spans and drops only the identity edited through', () => {
    const first = person('Alex', 'alex', 4);
    const second = person('Alex', 'katherine', 14);
    expect(rebaseMentionIdentities('Ask @Alex and @Alex', 'Please Ask @Alex and @Alex', [first, second]))
      .toEqual([person('Alex', 'alex', 11), person('Alex', 'katherine', 21)]);
    expect(rebaseMentionIdentities('Ask @Alex and @Alex', 'Ask @Alec and @Alex', [first, second]))
      .toEqual([person('Alex', 'katherine', 14)]);
  });

  it('keeps offsets aligned with the trimmed wire text', () => {
    expect(mentionsInTrimmedText('  Ask @Alex  ', [person('Alex', 'alex', 6)]))
      .toEqual({ text: 'Ask @Alex', mentions: [person('Alex', 'alex', 4)] });
  });

  it('preserves repeated targets but replaces the identity bound to one range', () => {
    const mentions = upsertMentionIdentity([person('Alex', 'alex', 4)], person('Alex', 'alex', 14));
    expect(mentions).toEqual([person('Alex', 'alex', 4), person('Alex', 'alex', 14)]);
    expect(upsertMentionIdentity(mentions, person('Alex', 'katherine', 14)))
      .toEqual([person('Alex', 'alex', 4), person('Alex', 'katherine', 14)]);
  });

  it('binds same-name selections to their own occurrences', () => {
    const text = 'Ask @Alex then @Alex';
    expect(resolveMentionPayload(
      text,
      [person('Alex', 'alex-one', 4), person('Alex', 'alex-two', 15)],
      [person('Alex', 'alex-one'), person('Alex', 'alex-two')],
    )).toEqual([
      { type: 'person', userId: 'alex-one', connectorType: null, startOffset: 4, endOffset: 9 },
      { type: 'person', userId: 'alex-two', connectorType: null, startOffset: 15, endOffset: 20 },
    ]);
  });

  it('does not guess an identity for an ambiguous hand-typed name', () => {
    expect(resolveMentionPayload(
      'Ask @Alex',
      [],
      [person('Alex', 'alex-one'), person('Alex', 'alex-two')],
    )).toEqual([]);
  });

  it('prefers the longest unambiguous name at a shared start', () => {
    expect(resolveMentionPayload(
      'Ask @Bob Builder',
      [],
      [person('Bob', 'bob'), person('Bob Builder', 'builder')],
    )).toEqual([
      { type: 'person', userId: 'builder', connectorType: null, startOffset: 4, endOffset: 16 },
    ]);
  });
});

const DIGEST_ID = '0b8c3a52-5f0e-4d6a-9a1c-1d2e3f405162';

function sidekick(label: string, startOffset: number): MentionIdentity {
  return {
    type: 'sidekick',
    label,
    userId: null,
    connectorType: null,
    sidekickId: DIGEST_ID,
    startOffset,
    endOffset: startOffset + label.length + 1,
  };
}

describe('Sidekick mentions in a draft', () => {
  it('sends a picked Sidekick as its link and moves the person named after it', () => {
    expect(sidekickMentionsAsMarkdown(
      'Ask @Daily [digest] to brief @Sam Lee',
      [sidekick('Daily [digest]', 4), person('Sam Lee', 'user-sam', 29)],
    )).toEqual({
      text: `Ask [@Daily \\[digest\\]](sidekick://${DIGEST_ID}) to brief @Sam Lee`,
      mentions: [{ ...person('Sam Lee', 'user-sam'), startOffset: 82, endOffset: 90 }],
    });
  });

  it('leaves the text as typed when the picked name was edited away', () => {
    expect(sidekickMentionsAsMarkdown('Ask @Daily dig', [sidekick('Daily digest', 4)]))
      .toEqual({ text: 'Ask @Daily dig', mentions: [] });
  });

  it('does not find a same-named person where a Sidekick was picked', () => {
    expect(resolveMentionPayload('Ask @Sam', [sidekick('Sam', 4)], [person('Sam', 'user-sam')])).toEqual([]);
  });

  it("never reads a Sidekick link's label as a person, but still finds that person elsewhere", () => {
    const text = `Ask [@Sam](sidekick://${DIGEST_ID}) and @Sam`;
    expect(resolveMentionPayload(text, [], [person('Sam', 'user-sam')])).toEqual([{
      type: 'person', userId: 'user-sam', connectorType: null, startOffset: 64, endOffset: 68,
    }]);
  });

  it('never hands a Sidekick selection to the mention payload', () => {
    expect(resolveMentionPayload('Ask @Daily digest', [sidekick('Daily digest', 4)], [])).toEqual([]);
  });
});
