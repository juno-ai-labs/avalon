import { webBuildFromHtml } from './protocol';

/** The web build the host serves now, or null when it cannot be read. Home's
 * WebView keeps the build it loaded until it reloads, and the host ships many
 * times a day; comparing the two lets the shell reload Home while it is hidden. */
export async function deployedWebBuild(appUrl: string): Promise<string | null> {
  try {
    const response = await fetch(new URL('/', appUrl).href, { headers: { accept: 'text/html' } });
    return response.ok ? webBuildFromHtml(await response.text()) : null;
  } catch { return null; }
}
