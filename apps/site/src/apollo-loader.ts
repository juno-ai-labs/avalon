/** Only the homepage and its landing-page variants run Apollo. */
export function runsApollo(environment: 'development' | 'staging' | 'production', pathname: string): boolean {
  const path = pathname.replace(/\/index\.html$/u, '/').replace(/\/$/u, '');
  return environment === 'production' && ['', '/start-fast', '/concepts', '/concepts/horizon', '/concepts/hero'].includes(path);
}

export function loadApollo(): void {
  const script = document.createElement('script');
  const nonce = Math.random().toString(36).substring(7);
  script.src = `https://assets.apollo.io/micro/website-tracker/tracker.iife.js?nocache=${nonce}`;
  script.async = true;
  script.defer = true;
  script.onload = () => {
    const tracking = (window as Window & {
      trackingFunctions?: { onLoad: (options: { appId: string }) => Promise<void> };
    }).trackingFunctions;
    void tracking?.onLoad({ appId: '6ad67a1c7cdf770018b4f9bc' }).catch(() => {});
  };
  document.head.append(script);
}
