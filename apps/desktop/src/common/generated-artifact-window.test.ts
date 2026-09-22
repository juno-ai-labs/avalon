import { describe, expect, it } from 'vitest';

import { generatedArtifactWindowDocument } from './generated-artifact-window';

describe('generated artifact pop-out document', () => {
  it('renders text as escaped prose under a script-free policy', () => {
    const document = generatedArtifactWindowDocument({
      kind: 'generated',
      resourceId: 'resource-1',
      version: 1,
      content: new TextEncoder().encode('<script>alert(1)</script>'),
      mimeType: 'text/html',
      title: '<Quarterly plan>',
    });

    expect(document).toContain("default-src 'none'");
    expect(document).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(document).toContain('<title>&lt;Quarterly plan&gt;</title>');
    expect(document).not.toContain('<script>');
  });

  it.each([
    ['image/png', 'img', 'alt'],
    ['audio/mpeg', 'audio', 'aria-label'],
    ['video/mp4', 'video', 'aria-label'],
  ])('embeds %s without interpreting it as markup', (mimeType, element, labelAttribute) => {
    const document = generatedArtifactWindowDocument({
      kind: 'generated',
      resourceId: 'resource-2',
      version: 1,
      content: new Uint8Array([0, 1, 2, 3]),
      mimeType,
      title: 'Chart',
    });

    expect(document).toContain(`<${element} ${labelAttribute}="Chart"`);
    expect(document).toContain(`src="data:${mimeType};base64,AAECAw=="`);
  });

  it('falls back to an inert MIME type when the supplied value is malformed', () => {
    const document = generatedArtifactWindowDocument({
      kind: 'generated',
      resourceId: 'resource-3',
      version: 1,
      content: new TextEncoder().encode('safe text'),
      mimeType: 'image/png" onerror="alert(1)',
      title: 'Chart',
    });

    expect(document).toContain('<pre>safe text</pre>');
    expect(document).not.toContain('onerror=');
  });
});
