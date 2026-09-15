import { describe, expect, it, vi } from 'vitest';
import type { SessionImportPreview } from '@rally/contracts';
import { createTestEnv } from './helpers/cloudflare-test';
import { importFileUrlAllowed, resolveSessionImportFiles } from '../src/services/session-import-files';

const preview: SessionImportPreview = { title: 'Files', source: { provider: 'chatgpt', url: null }, content: { messages: [{ role: 'assistant', text: 'Here', files: [
  { name: 'report.txt', mimeType: 'text/plain', kind: 'artifact', source: { kind: 'remote', url: 'https://files.oaiusercontent.com/report' } },
] }] } };

describe('import file retrieval', () => {
  it('does not retrieve arbitrary destinations or follow redirects', async () => {
    expect(importFileUrlAllowed('https://localhost/file', 'chatgpt')).toBe(false);
    expect(importFileUrlAllowed('https://files.oaiusercontent.com.evil.test/file', 'chatgpt')).toBe(false);
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://localhost/' } }));
    const result = await resolveSessionImportFiles(createTestEnv({ MAX_ATTACHMENT_BYTES: '100' }), preview, fetcher);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]).toEqual(['https://files.oaiusercontent.com/report', { redirect: 'manual' }]);
    expect(result.content.messages[0]?.files?.[0]?.source.kind).toBe('unavailable');
  });
  it('marks successful HTTP challenge responses unavailable while preserving real HTML artifacts', async () => {
    const testEnv = createTestEnv({ MAX_ATTACHMENT_BYTES: '1000' });
    const challenge = await resolveSessionImportFiles(testEnv, preview, async () => new Response('<html><title>Just a moment...</title></html>'));
    expect(challenge.content.messages[0]?.files?.[0]?.source).toMatchObject({ kind: 'unavailable', reason: expect.stringContaining('challenge page') });
    const html = '<html><title>Report</title><h1>Results</h1></html>';
    const report = await resolveSessionImportFiles(testEnv, preview, async () => new Response(html));
    expect(report.content.messages[0]?.files?.[0]?.source).toEqual({ kind: 'inline', encoding: 'base64', data: btoa(html) });
  });
  it('freezes successful bytes in the preview and enforces the existing workspace file size policy', async () => {
    const success = await resolveSessionImportFiles(createTestEnv({ MAX_ATTACHMENT_BYTES: '100' }), preview, async () => new Response('report'));
    expect(success.content.messages[0]?.files?.[0]?.source).toEqual({ kind: 'inline', encoding: 'base64', data: btoa('report') });
    const rejected = await resolveSessionImportFiles(createTestEnv({ MAX_ATTACHMENT_BYTES: '3' }), preview, async () => new Response('report'));
    expect(rejected.content.messages[0]?.files?.[0]?.source).toMatchObject({ kind: 'unavailable', reason: 'The file exceeds the workspace attachment size limit.' });
  });
});
