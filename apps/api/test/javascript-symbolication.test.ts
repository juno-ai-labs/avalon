import { describe, expect, it, vi } from 'vitest';
import { symbolicateJavascriptFrames } from '../src/telemetry/javascript-symbolication';
import { createCloudflareTestBinding } from './helpers/cloudflare-test';

describe('regional JavaScript symbolication', () => {
  it('maps generated coordinates with a private regional artifact and emits no source content or path', async () => {
    const get = vi.fn(async () => ({
      text: async () => JSON.stringify({
        version: 3,
        file: 'index-CX8Z.js',
        sources: ['../../src/main/private-source.ts'],
        sourcesContent: ['const secret = "never emit me";'],
        names: [],
        mappings: 'AAAA;AACA',
      }),
    }));

    await expect(symbolicateJavascriptFrames(createCloudflareTestBinding<R2Bucket>({ get }), {
      release: '1.96.0',
      buildId: '1.96.0',
      process: 'main',
      generatedFrames: ['index-CX8Z.js:2:1'],
    })).resolves.toEqual(['private-source.ts:2:1']);
    expect(get).toHaveBeenCalledWith(
      'telemetry/javascript-symbols/1.96.0/1.96.0/main/index-CX8Z.js.map',
    );
  });

  it('keeps a bounded generated frame when its artifact is unavailable or malformed', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ text: async () => '{bad-json' });
    const bucket = createCloudflareTestBinding<R2Bucket>({ get });

    await expect(symbolicateJavascriptFrames(bucket, {
      release: '1.96.0', buildId: '1.96.0', process: 'renderer',
      generatedFrames: ['one.js:7:3'],
    })).resolves.toEqual(['one.js:7:3']);
    await expect(symbolicateJavascriptFrames(bucket, {
      release: '1.96.0', buildId: '1.96.0', process: 'renderer',
      generatedFrames: ['two.js:8:4'],
    })).resolves.toEqual(['two.js:8:4']);
  });
});
