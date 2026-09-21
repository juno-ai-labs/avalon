import type { DesktopGeneratedArtifactWindowRequest } from './desktop';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function dataUrl(content: Uint8Array, mimeType: string): string {
  let binary = '';
  for (let offset = 0; offset < content.length; offset += 0x8000) {
    binary += String.fromCharCode(...content.subarray(offset, offset + 0x8000));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

/**
 * A script-free document for a generated file's authorized preview bytes.
 *
 * The preview route has already reduced Office documents and PDFs to readable
 * text. Images, audio and video keep their browser-readable bytes; everything
 * else is escaped into prose rather than interpreted as authored HTML.
 */
export function generatedArtifactWindowDocument(
  request: DesktopGeneratedArtifactWindowRequest,
): string {
  const mimeType = request.mimeType.split(';', 1)[0]?.trim().toLowerCase() || 'text/plain';
  const title = escapeHtml(request.title);
  let body: string;
  if (mimeType.startsWith('image/')) {
    body = `<main class="media"><img alt="${title}" src="${dataUrl(request.content, mimeType)}"></main>`;
  } else if (mimeType.startsWith('audio/')) {
    body = `<main class="audio"><audio aria-label="${title}" controls src="${dataUrl(request.content, mimeType)}"></audio></main>`;
  } else if (mimeType.startsWith('video/')) {
    body = `<main class="media"><video aria-label="${title}" controls src="${dataUrl(request.content, mimeType)}"></video></main>`;
  } else {
    body = `<main class="document"><pre>${escapeHtml(new TextDecoder().decode(request.content))}</pre></main>`;
  }
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { background: Canvas; color: CanvasText; margin: 0; min-height: 100vh; }
    main { min-height: 100vh; }
    .document { margin: 0 auto; max-width: 960px; padding: 44px 36px 96px; }
    pre { font: 14px/1.65 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
    .media { align-items: center; display: flex; justify-content: center; padding: 24px; }
    .media img, .media video { max-height: calc(100vh - 48px); max-width: 100%; object-fit: contain; }
    .audio { align-items: center; display: flex; justify-content: center; padding: 36px; }
    audio { width: min(680px, 100%); }
  </style>
</head>
<body>${body}</body>
</html>`;
}
