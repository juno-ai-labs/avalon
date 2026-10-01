import { describe, expect, it } from 'vitest';
import { assemblePreview } from './session-import-run';
import { DesktopActionStore } from './desktop-actions/store';

const source = { provider: 'claude' as const, url: 'https://claude.ai/chat/4f2b7c1e-9a3d-4e8b-b1c2-0d9e8f7a6b5c', sessionId: '4f2b7c1e-9a3d-4e8b-b1c2-0d9e8f7a6b5c' };

function stored(messages: unknown) {
  const store = new DesktopActionStore();
  store.add({ ref: { handle: 'messages', kind: 'json', name: 'messages', mimeType: 'application/json', size: 0 }, data: JSON.stringify(messages) });
  store.add({ ref: { handle: 'chart', kind: 'file', name: 'chart', mimeType: 'image/png', size: 3 }, data: btoa('png') });
  return store;
}

describe('assembling an import from what the agent stored', () => {
  it('turns handles into inline files, named for their type, kinded by who added them', () => {
    const preview = assemblePreview(stored([
      { role: 'user', text: 'Plot it', sourceMessageId: 'u1', files: [{ unavailable: { name: 'data.xlsx', reason: 'Expired' } }] },
      { role: 'assistant', text: 'Here.', sourceMessageId: 'a1', files: [{ handle: 'chart' }] },
    ]), { title: 'Charts', messagesHandle: 'messages', source });
    expect(preview).toEqual({ title: 'Charts', source, content: { messages: [
      { role: 'user', text: 'Plot it', sourceMessageId: 'u1', files: [{ name: 'data.xlsx', mimeType: 'application/octet-stream', kind: 'attachment',
        source: { kind: 'unavailable', reference: 'data.xlsx', reason: 'Expired' } }] },
      { role: 'assistant', text: 'Here.', sourceMessageId: 'a1', files: [{ name: 'chart.png', mimeType: 'image/png', kind: 'artifact',
        source: { kind: 'inline', encoding: 'base64', data: btoa('png') } }] },
    ] } });
  });

  it('names what is wrong, so the agent can fix it', () => {
    const at = (messages: unknown, handle = 'messages') => () => assemblePreview(stored(messages), { title: 't', messagesHandle: handle, source });
    expect(at([], 'missing')).toThrow('No stored value has the handle missing.');
    expect(at([], 'chart')).toThrow('chart is a file');
    expect(at([{ role: 'user', text: 'x' }])).toThrow('sourceMessageId');
    expect(at([{ role: 'user', text: 'a', sourceMessageId: 'm' }, { role: 'assistant', text: 'b', sourceMessageId: 'm' }]))
      .toThrow('sourceMessageId m appears more than once.');
    expect(at([{ role: 'user', text: 'a', sourceMessageId: 'm', files: [{ handle: 'gone' }] }])).toThrow('file handle gone');
    expect(at([{ role: 'user', text: ' ', sourceMessageId: 'm' }])).toThrow('Message 1 has no text and no files.');
  });
});
