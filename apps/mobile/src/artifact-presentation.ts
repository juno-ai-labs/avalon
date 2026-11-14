import { artifactInsetScript } from './layout';

const ARTIFACT_READY = 'rally:artifact-presented';

/** A presentation-only message: generated pages receive no application commands. */
export function artifactPresented(data: string, url: string, canonicalUrl: string): boolean {
  if (data !== ARTIFACT_READY) return false;
  try {
    const current = new URL(url), canonical = new URL(canonicalUrl);
    return current.origin === canonical.origin && !current.pathname.startsWith('/__rally/');
  } catch { return false; }
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
      }));
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', present, { once: true });
    else present();
  })(); true;`;
}
