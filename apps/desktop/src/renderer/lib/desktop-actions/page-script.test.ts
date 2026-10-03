import { afterEach, describe, expect, it, vi } from 'vitest';
import { pageScript, type PageScriptOutcome } from '../../../common/desktop-actions/page-script';

/** Run the expression as the page would, with the page globals it reads. */
async function run(body: string): Promise<PageScriptOutcome> {
  const evaluate = new Function('location', 'document', `return ${pageScript(body)}`) as
    (location: { href: string }, document: { title: string }) => Promise<PageScriptOutcome>;
  return evaluate({ href: 'https://claude.ai/chat/1' }, { title: 'Chat' });
}

describe('page script', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('downloads files concurrently, preserves source order, and accounts for rejected originals', async () => {
    const replies = new Map<string, (response: Response) => void>();
    vi.stubGlobal('fetch', (url: string) => new Promise<Response>(resolve => replies.set(url, resolve)));
    const answer = run(`return await rally.downloadFiles([
      { url: 'first', name: 'first.txt', expectedSize: 1 },
      { url: 'second', name: 'second.txt', expectedSize: 1 },
      { url: 'preview', name: 'original.png', expectedSize: 100 },
      { url: 'expired', name: 'expired.txt' },
    ]);`);
    expect([...replies.keys()]).toEqual(['first', 'second', 'preview', 'expired']);
    replies.get('second')!(new Response('b'));
    replies.get('preview')!(new Response('tiny'));
    replies.get('expired')!(new Response('', { status: 403 }));
    replies.get('first')!(new Response('a'));
    const result = await answer;
    expect(result).toMatchObject({ ok: true, value: [
      { name: 'first.txt', kind: 'file', size: 1 },
      { name: 'second.txt', kind: 'file', size: 1 },
      { unavailable: { name: 'original.png', reason: 'File size mismatch: expected 100 bytes, received 4. Retrieve the original file.' } },
      { unavailable: { name: 'expired.txt', reason: 'File download returned HTTP 403.' } },
    ] });
    if (!result.ok) throw new Error(result.message);
    expect(result.stored.map(file => ({ name: file.name, data: file.data })).sort((a, b) => a.name.localeCompare(b.name)))
      .toEqual([{ name: 'first.txt', data: 'YQ==' }, { name: 'second.txt', data: 'Yg==' }]);
  });
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
      messages: { handle: result.stored[0]!.handle, kind: 'json', name: 'messages', mimeType: 'application/json', size: 52 },
      note: { handle: result.stored[1]!.handle, kind: 'file', name: 'notes.md', mimeType: 'text/markdown', size: 7 },
    });
  });

  it('answers a thrown error with its own message, and an oversized download as too large', async () => {
    await expect(run("throw new Error('no conversation here');")).resolves.toMatchObject({
      ok: false, code: 'script_error', message: expect.stringContaining('no conversation here'),
    });
    await expect(run("return rally.store(new Response('x', { headers: { 'content-length': '999999999' } }), { name: 'video.mp4' });"))
      .resolves.toMatchObject({ ok: false, code: 'file_too_large', message: expect.stringContaining('video.mp4') });
    // Bytes, not characters: 9 million three-byte characters are 27 MB of JSON.
    await expect(run("return rally.store({ text: '漢'.repeat(9_000_000) }, { name: 'messages' });"))
      .resolves.toMatchObject({ ok: false, code: 'file_too_large', message: expect.stringContaining('messages') });
    await expect(run('const value = {}; value.self = value; return value;'))
      .resolves.toMatchObject({ ok: false, code: 'value_not_serializable' });
  });

  it('names the missing await instead of returning a Promise as a file reference', async () => {
    await expect(run(`
      const file = rally.store('draft', { name: 'draft.md', mimeType: 'text/markdown' });
      return { handle: file.handle };
    `)).resolves.toMatchObject({ ok: false, code: 'script_error', message: expect.stringContaining('Use await rally.store') });
    await expect(run(`return { stored: rally.store([]) };`))
      .resolves.toMatchObject({ ok: false, code: 'value_not_serializable', message: expect.stringContaining('Use await rally.store') });
  });

  it('drains file stores before returning, even when the script does not use their references', async () => {
    const result = await run(`rally.store('draft', { name: 'draft.md', mimeType: 'text/markdown' }); return { count: 1 };`);
    expect(result).toMatchObject({ ok: true, value: { count: 1 }, stored: [{ name: 'draft.md', kind: 'file', data: 'ZHJhZnQ=' }] });
    await expect(run(`rally.store(new Response('x', { headers: { 'content-length': '999999999' } })); return 1;`))
      .resolves.toMatchObject({ ok: false, code: 'file_too_large' });
  });

  it('normalizes citations without deleting spaces, paragraphs or code indentation', async () => {
    await expect(run(`
      const text = 'Welcome to Rally\\n\\n\\tCode\\r\\nSource: \\uE200cite\\uE202ref\\uE201\\u0000\\uE000\\uE200cite\\uE202unmapped\\uE201';
      const cleaned = rally.normalizeText(text, [
        { marker: ' ', text: '' },
        { marker: 'Welcome to Rally', text: 'changed prose' },
        { marker: '\\uE200cite\\uE202ref\\uE201', text: '[Source](https://example.com)' },
      ]);
      return { cleaned, stable: rally.normalizeText(cleaned) === cleaned };
    `)).resolves.toMatchObject({ ok: true, value: {
      cleaned: 'Welcome to Rally\n\n\tCode\r\nSource: [Source](https://example.com)', stable: true,
    } });
  });
});
