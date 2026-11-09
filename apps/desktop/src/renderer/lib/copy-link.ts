import { linkCanonicalUrl, type LinkTarget } from '@rally/contracts/links';
import { desktopBridge } from './platform';

/** Copies a Canvas's or a Sidekick's canonical link. Callers own error presentation. */
export async function copyLink(target: LinkTarget): Promise<void> {
  const bridge = desktopBridge();
  const { webBaseUrl } = await bridge.getRuntimeConfig();
  await bridge.copyText(linkCanonicalUrl(webBaseUrl, target));
}
