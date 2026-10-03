import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserImportMessagesSchema } from '@rally/contracts/desktop-actions';
import { pageScript, type PageScriptOutcome } from '../../../common/desktop-actions/page-script';

/** Run the expression as the page would, with the page globals it reads. */
async function run(body: string): Promise<PageScriptOutcome> {
  const evaluate = new Function('location', 'document', `return ${pageScript(body)}`) as
    (location: { href: string }, document: { title: string }) => Promise<PageScriptOutcome>;
  return evaluate({ href: 'https://claude.ai/chat/1' }, { title: 'Chat' });
}

/** Node's fetch Response can return a different Blob realm than the page.
 * Real page fetch returns page-native Blobs; keep the fixture in that realm. */
function pageResponse(body: string, init?: ResponseInit): Response {
  const response = new Response(body, init);
  vi.spyOn(response, 'blob').mockResolvedValue(new Blob([body]));
  return response;
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
    replies.get('second')!(pageResponse('b'));
    replies.get('preview')!(pageResponse('tiny'));
    replies.get('expired')!(pageResponse('', { status: 403 }));
    replies.get('first')!(pageResponse('a'));
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
  it('refuses declared oversized bodies before reading and retains successful sibling references', async () => {
    const oversized = new Response('unread', { headers: { 'content-length': '25000001' } });
    const read = vi.spyOn(oversized, 'blob');
    vi.stubGlobal('fetch', async (url: string) => url === 'large' ? oversized : pageResponse('a'));
    const result = await run(`
      const files = await rally.downloadFiles([{ url: 'valid', name: 'valid.txt' }, { url: 'large', name: 'large.txt' }]);
      return [{ role: 'user', text: 'Files', sourceMessageId: 'm1', files: files.map(file =>
        file.unavailable ? file : { handle: file.handle, name: file.name, mimeType: file.mimeType }) }];
    `);
    expect(read).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, stored: [{ name: 'valid.txt', data: 'YQ==' }] });
    if (!result.ok) throw new Error(result.message);
    expect(BrowserImportMessagesSchema.parse(result.value)[0]?.files).toMatchObject([
      { name: 'valid.txt' }, { unavailable: { name: 'large.txt', reason: 'large.txt is larger than the 25000000-byte file limit.' } },
    ]);
  });

  it('returns handled store failures per file while draining successful siblings', async () => {
    const Reader = FileReader;
    vi.stubGlobal('FileReader', class extends Reader {
      override readAsDataURL(blob: Blob) {
        if (blob.size === 2) { queueMicrotask(() => this.dispatchEvent(new ProgressEvent('error'))); }
        else super.readAsDataURL(blob);
      }
    });
    vi.stubGlobal('fetch', async (url: string) => pageResponse(url === 'broken' ? 'xx' : 'a'));
    await expect(run(`return await rally.downloadFiles([{ url: 'valid', name: 'valid.txt' }, { url: 'broken', name: 'broken.txt' }]);`))
      .resolves.toMatchObject({ ok: true, value: [
        { name: 'valid.txt', size: 1 }, { unavailable: { name: 'broken.txt', reason: 'The file could not be read.' } },
      ], stored: [{ name: 'valid.txt', data: 'YQ==' }] });
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
