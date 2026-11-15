import { artifactInsetScript } from './layout';

const ARTIFACT_READY = 'rally:artifact-presented';
const ARTIFACT_BACKGROUND = 'rally:artifact-background ';

/** A presentation-only message: generated pages receive no application commands. */
export function artifactPresented(data: string, url: string, canonicalUrl: string): boolean {
  if (data !== ARTIFACT_READY) return false;
  try {
    const current = new URL(url), canonical = new URL(canonicalUrl);
    return current.origin === canonical.origin && !current.pathname.startsWith('/__rally/');
  } catch { return false; }
}

/** The page's own background colour, reported with its presentation, or null for any other message. */
export function artifactBackground(data: string, url: string, canonicalUrl: string): string | null {
  if (!data.startsWith(ARTIFACT_BACKGROUND)) return null;
  const color = data.slice(ARTIFACT_BACKGROUND.length);
  return artifactPresented(ARTIFACT_READY, url, canonicalUrl) && /^rgba?\([\d.,\s%]+\)$/u.test(color) ? color : null;
}

/** Status bar text that reads over a background colour: dark over a light page, light over a dark one. */
export function statusBarStyleFor(color: string): 'light' | 'dark' {
  const [r = 255, g = 255, b = 255] = (color.match(/[\d.]+/gu) ?? []).map(Number);
  const linear = (channel: number) => { const c = channel / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const luminance = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  // The luminance at which black and white text have equal contrast.
  return luminance > 0.179 ? 'dark' : 'light';
}

/** Document readiness does not wait for images or other non-blocking subresources. */
export function artifactPresentationScript(top: number): string {
  return `(() => {
    if (location.pathname.startsWith('/__rally/')) return;
    const present = () => {
      if (!document.body) return;
      ${artifactInsetScript(top)}
      requestAnimationFrame(() => requestAnimationFrame(() => {
        window.ReactNativeWebView?.postMessage(${JSON.stringify(ARTIFACT_READY)});
        // The colour the page paints under the status bar, so the shell can pick
        // legible status bar text. A transparent page shows the WebView's white.
        const painted = [document.body, document.documentElement].map((element) => getComputedStyle(element).backgroundColor)
          .find((color) => color && color !== 'transparent' && !/^rgba\\(.*,\\s*0\\)$/u.test(color));
        window.ReactNativeWebView?.postMessage(${JSON.stringify(ARTIFACT_BACKGROUND)} + (painted || 'rgb(255, 255, 255)'));
      }));
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', present, { once: true });
    else present();
  })(); true;`;
}
