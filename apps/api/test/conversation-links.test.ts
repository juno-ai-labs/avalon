import { describe, expect, it } from 'vitest';
import type { TranscriptTurn } from '@rally/contracts';
import { AVALON_WEB_PLUGIN_ID } from '@rally/agent-harness';
import { conversationLinks } from '../src/durable-objects/conversation-link-search';
import { resourceSearchCategory } from '../src/services/resource-search-text';

function turn(blocks: TranscriptTurn['blocks']): TranscriptTurn {
  return { turnId: 'links', transcriptSequence: 1, entryKind: 'conversation', actor: 'human',
    authorUserId: null, authorSnapshot: null, attentionOrdinal: 1,
    createdAtUtc: '2026-09-05T00:00:00Z', revision: 1, activityId: null, blocks };
}

describe('conversation link discovery', () => {
  it('retains balanced URL parentheses, Markdown labels, and literal URL text', () => {
    const links = conversationLinks(turn([{ type: 'text', blockId: 'text', blockIndex: 0, streaming: false,
      text: '[A page](https://example.com/Topic_(example)) and (https://example.org/path).',
    }]));
    expect([...links]).toEqual([
      ['https://example.com/Topic_(example)', 'A page'],
      ['https://example.org/path', 'https://example.org/path'],
    ]);
  });

  it('recognizes the built-in web fetch without treating another plugin fetch as web access', () => {
    const tool = { type: 'tool', blockId: 'fetch', blockIndex: 0, toolCallId: 'call', pluginId: AVALON_WEB_PLUGIN_ID,
      toolName: 'fetch', callIndex: 0, status: 'completed', participantSafeInput: { url: 'https://example.com' },
      participantSafeResult: null, error: null, activityId: null } satisfies TranscriptTurn['blocks'][number];
    expect([...conversationLinks(turn([tool])).keys()]).toEqual(['https://example.com/']);
    expect(conversationLinks(turn([{ ...tool, pluginId: 'another:plugin' }])).size).toBe(0);
    expect(conversationLinks(turn([{ ...tool, status: 'failed' }])).size).toBe(0);
    for (const toolName of ['web_fetch', 'web.fetch']) {
      expect(conversationLinks(turn([{ ...tool, toolName }])).size).toBe(1);
      expect(conversationLinks(turn([{ ...tool, toolName, pluginId: 'another:plugin' }])).size).toBe(0);
    }
  });
});

describe('resource search categories', () => {
  it('separates uploads, generated artifacts, and URL-backed resources', () => {
    expect(resourceSearchCategory('avalon_upload', null)).toBe('files');
    expect(resourceSearchCategory('avalon_generated', 'https://example.com')).toBe('artifacts');
    expect(resourceSearchCategory('connector', 'https://example.com')).toBe('links');
    expect(resourceSearchCategory('avalon_note', null)).toBeNull();
  });
});
