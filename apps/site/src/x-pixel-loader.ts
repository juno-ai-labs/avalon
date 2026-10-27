import { allowsThirdPartyScripts } from './posthog-loader';

const X_PIXEL_ID = 'rg7j5';
/** "Rally | Mac download intent" in X Events Manager. */
const X_DOWNLOAD_INTENT_EVENT = 'tw-rg7j5-rg7j6';

type Twq = ((...args: unknown[]) => void) & { exe?: (...args: unknown[]) => void; queue: unknown[]; version: string };

/**
 * The X (Twitter) conversion pixel runs on the same pages as PostHog: every
 * production page except the ones whose URL carries a credential, because the
 * pixel reports the full page URL to X. A browser sending Global Privacy
 * Control never loads it: the Cookie & Tracking Notice promises to honor that
 * signal, and an advertising pixel is what it opts out of.
 */
export function runsXPixel(environment: 'development' | 'staging' | 'production', pathname: string, notFound: boolean, globalPrivacyControl: boolean): boolean {
  return environment === 'production' && !notFound && !globalPrivacyControl && allowsThirdPartyScripts(pathname);
}

/**
 * X's base code, bundled because the site's CSP forbids inline scripts.
 *
 * `twclid` is the X ad click id from the landing URL. `takeAdClickId` strips
 * it from the address bar before the pixel's script has loaded, so it is handed
 * over in the `_twclid` cookie the pixel reads when the URL has none. The value
 * is X's own cookie format (`{"twclid": ...}`, JSON then URI-encoded) and
 * lifetime (390 days), on the site's registrable domain.
 */
export function loadXPixel(twclid: string | null): void {
  if (twclid) {
    const domain = location.hostname.split('.').slice(-2).join('.');
    const value = encodeURIComponent(JSON.stringify({ twclid, timestamp: Date.now().toString(), source: 1 }));
    document.cookie = `_twclid=${value}; domain=.${domain}; path=/; max-age=33696000; secure; samesite=strict`;
  }
  const w = window as Window & { twq?: Twq };
  if (!w.twq) {
    const twq = ((...args: unknown[]) => {
      if (twq.exe) twq.exe(...args);
      else twq.queue.push(args);
    }) as Twq;
    twq.version = '1.1';
    twq.queue = [];
    w.twq = twq;
    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://static.ads-twitter.com/uwt.js';
    document.head.append(script);
  }
  w.twq('config', X_PIXEL_ID);
}

/** Reports a download-button click to X. Does nothing where the pixel did not load. */
export function reportXDownloadIntent(): void {
  (window as Window & { twq?: Twq }).twq?.('event', X_DOWNLOAD_INTENT_EVENT, {});
}
