import { describe, expect, it } from 'vitest';
import { pageScript, type PageScriptOutcome } from './page-script';

/** Run the expression as the page would, with the page globals it reads. */
async function run(body: string): Promise<PageScriptOutcome> {
  const evaluate = new Function('location', 'document', `return ${pageScript(body)}`) as
    (location: { href: string }, document: { title: string }) => Promise<PageScriptOutcome>;
  return evaluate({ href: 'https://claude.ai/chat/1' }, { title: 'Chat' });
}

describe('page script', () => {
  it('returns the script’s JSON value with the page it ran on', async () => {
    await expect(run('return { turns: [1, 2] };')).resolves.toEqual({
      ok: true, value: { turns: [1, 2] }, stored: [], url: 'https://claude.ai/chat/1', title: 'Chat',
    });
    await expect(run('return undefined;')).resolves.toMatchObject({ ok: true, value: null });
  });

  it('keeps stored values with the answer and gives the script only their description', async () => {
    const result = await run(`
      const messages = await rally.store([{ role: 'user', text: 'Hi', sourceMessageId: 'm1' }], { name: 'messages' });
      const note = await rally.store('# Notes', { name: 'notes.md', mimeType: 'text/markdown' });
      return { messages, note };
    `);
    if (!result.ok) throw new Error(result.message);
    expect(result.stored).toHaveLength(2);
    expect(result.stored[0]).toMatchObject({ kind: 'json', name: 'messages', data: '[{"role":"user","text":"Hi","sourceMessageId":"m1"}]' });
    expect(result.stored[1]).toMatchObject({ kind: 'file', name: 'notes.md', mimeType: 'text/markdown', data: btoa('# Notes') });
    expect(result.value).toEqual({
      messages: { handle: result.stored[0]!.handle, kind: 'json', name: 'messages', mimeType: 'application/json', size: result.stored[0]!.data.length },
      note: { handle: result.stored[1]!.handle, kind: 'file', name: 'notes.md', mimeType: 'text/markdown', size: 7 },
    });
  });

  it('answers a thrown error with its own message, and an oversized download as too large', async () => {
    await expect(run("throw new Error('no conversation here');")).resolves.toMatchObject({
      ok: false, code: 'script_error', message: expect.stringContaining('no conversation here'),
    });
    await expect(run("return rally.store(new Response('x', { headers: { 'content-length': '999999999' } }), { name: 'video.mp4' });"))
      .resolves.toMatchObject({ ok: false, code: 'file_too_large', message: expect.stringContaining('video.mp4') });
    await expect(run('const value = {}; value.self = value; return value;'))
      .resolves.toMatchObject({ ok: false, code: 'value_not_serializable' });
  });
});
