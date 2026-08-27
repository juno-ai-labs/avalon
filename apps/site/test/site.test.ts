import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDesktopTarget } from '../src/auth-handoff';
import { classifyDesktopHandoffTarget } from '../src/desktop-open';
import {
  desktopDmgUrl,
  discoverDesktopRelease,
  parseDesktopReleaseConfig,
  renderDesktopRelease,
} from '../src/release-config';
import { normalizedTelemetryPathname } from '../src/telemetry';

const readProjectFile = (path: string): string =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/**
 * `wrangler.jsonc` is JSON with comments, like the two regional API configs.
 * Reading it with a bare `JSON.parse` made the file's *formatting* part of this
 * assertion: the first explanatory comment anyone added failed a test about
 * route patterns, naming neither the comment nor the file.
 *
 * Deliberately narrow — line comments only, which is all these configs use.
 * `scripts/migrate-d1.mjs` owns the complete stripper for the deploy path,
 * where a mis-parse takes out a migration rather than a test.
 */
const parseJsonc = (source: string): unknown =>
  JSON.parse(source.replace(/^\s*\/\/.*$/gmu, ''));

function unpublishedReleaseFixture(): Record<string, unknown> {
  return {
    ...JSON.parse(readProjectFile('release.config.json')) as Record<string, unknown>,
    published: false,
    sha256: {},
    publishedAt: null,
  };
}

describe('public Rally site', () => {
  it('presents Rally as a desktop product without exposing an app sign-in surface', () => {
    const page = readProjectFile('index.html');

    expect(page).toContain('Desktop preview');
    expect(page).toContain('currently ships as a macOS desktop product');
    expect(page).toContain('not a browser version');
    expect(page).not.toMatch(/<form\b/i);
    expect(page).not.toMatch(/sign[ -]?in/i);
    expect(page).toContain('<script type="module" src="/src/landing.ts"></script>');
  });

  it('ships the convergence hero with the multiplayer thesis on the Rally palette', () => {
    const page = readProjectFile('index.html');
    const styles = readProjectFile('src/styles.css');
    expect(page).toContain('Docs went multiplayer.<br />Design went multiplayer.<br /><em>AI is next.</em>');
    expect(page).toContain('Why multiplayer');
    expect(page).toContain('class="rally-merge reveal"');
    expect(styles).toContain('--paper:#f0efe8');
    expect(styles).toContain('--blue:#47c7fc');
    expect(styles).toContain('--volt:#cedc00');
    expect(styles).toContain('--orange:#ff6337');
    expect(styles).toContain('.rally-home .rally-button-dark:hover{background:var(--volt);border-color:var(--black);color:var(--black)}');
    expect(page).not.toContain('data-theme-select');
  });

  it('keeps content visible without scripts and hides the decorative workspace mock', () => {
    const page = readProjectFile('index.html');
    const styles = readProjectFile('src/styles.css');

    expect(styles).toContain('.reveal { opacity: 1; transform: none; }');
    expect(styles).toContain('html.js .reveal { opacity: 0;');
    expect(styles).toContain('html.js .reveal.is-visible { opacity: 1;');
    expect(page).toContain('<div class="rally-app-body" aria-hidden="true" inert>');
    expect(page.indexOf('<script src="/landing-init.js"></script>')).toBeLessThan(
      page.indexOf('<link rel="stylesheet" href="/src/styles.css" />'),
    );
    expect(readProjectFile('public/landing-init.js')).toContain(
      "document.documentElement.classList.add('js');",
    );
  });

  it('defines responsive behavior for every public surface', () => {
    const publicPages = [
      'index.html',
      'concepts/index.html',
      'concepts/horizon/index.html',
      'concepts/hero/index.html',
      'invite/index.html',
      'slack/link/index.html',
      'open/index.html',
      'app/workstreams/index.html',
      'slack/index.html',
      'terms/index.html',
      'privacy/index.html',
      'acceptable-use/index.html',
      'dpa/index.html',
      'subprocessors/index.html',
      'cookies/index.html',
      'security/index.html',
      'support/index.html',
      'auth/desktop/index.html',
      '404.html',
    ];
    const styles = readProjectFile('src/styles.css');

    for (const path of publicPages) {
      expect(readProjectFile(path), path).toContain(
        '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
      );
    }
    expect(styles).toContain('@media(max-width:1050px)');
    expect(styles).toContain('@media(max-width:720px)');
    expect(styles).toContain('.rally-hero h1{font-size:clamp(2.5rem,10.5vw,3.4rem)}');
    expect(styles).toContain('.legal-nav a{align-items:center;display:flex;min-height:40px}');
  });

  it('keeps Rally inherent instead of presenting it as a removable participant', () => {
    const page = readProjectFile('index.html');

    expect(page).toContain('4 people + Rally');
    expect(page).not.toContain('5 people');
    expect(page).not.toContain('rally-chip');
  });

  it('uses the canonical brand mark and current brand palette on every public surface', () => {
    const pages = [
      readProjectFile('index.html'),
      readProjectFile('invite/index.html'),
      readProjectFile('slack/link/index.html'),
      readProjectFile('open/index.html'),
      readProjectFile('app/workstreams/index.html'),
      readProjectFile('slack/index.html'),
      readProjectFile('terms/index.html'),
      readProjectFile('privacy/index.html'),
      readProjectFile('acceptable-use/index.html'),
      readProjectFile('dpa/index.html'),
      readProjectFile('subprocessors/index.html'),
      readProjectFile('cookies/index.html'),
      readProjectFile('security/index.html'),
      readProjectFile('support/index.html'),
      readProjectFile('auth/desktop/index.html'),
      readProjectFile('404.html'),
    ];
    const styles = readProjectFile('src/styles.css');
    const manifest = JSON.parse(readProjectFile('public/site.webmanifest')) as {
      background_color: string;
      theme_color: string;
      icons: Array<{ src: string }>;
    };

    expect(pages[0]).toContain('class="rally-symbol"');
    expect(pages[0]).toContain('/brand/rally-mark.png');
    for (const page of pages.slice(1)) {
      expect(page).toContain('/brand/rally-mark.png');
    }
    for (const page of pages) {
      expect(page).not.toMatch(/Avalon|with-avalon|avalon-mark/iu);
      expect(page).not.toContain('/brand/rally-mark.svg');
      expect(page).toContain('/favicon.png');
      expect(page).not.toContain('✣');
      expect(page).not.toContain('/favicon.svg');
    }
    expect(styles).toContain('--brand-primary: #cedc00');
    expect(styles).toContain('--brand-secondary: #47c7fc');
    expect(styles).toContain('--orange:#ff6337');
    expect(manifest.theme_color).toBe('#111210');
    expect(manifest.background_color).toBe('#111210');
    expect(manifest.icons.map(({ src }) => src)).toEqual(['/favicon.png', '/apple-touch-icon.png']);
    expect(existsSync(new URL('../public/brand/rally-mark.png', import.meta.url))).toBe(true);
    expect(existsSync(new URL('../public/brand/rally-mark.svg', import.meta.url))).toBe(false);
    expect(existsSync(new URL('../public/brand/avalon-mark.png', import.meta.url))).toBe(false);
    expect(existsSync(new URL('../public/favicon.png', import.meta.url))).toBe(true);
    expect(existsSync(new URL('../public/apple-touch-icon.png', import.meta.url))).toBe(true);
    const socialCard = new URL('../public/rally-social.jpg', import.meta.url);
    expect(existsSync(socialCard)).toBe(true);
    expect(statSync(socialCard).size).toBeLessThan(200_000);
    expect(existsSync(new URL('../public/og.png', import.meta.url))).toBe(false);
    const generator = readFileSync(
      new URL('../../../scripts/generate-brand-assets.py', import.meta.url),
      'utf8',
    );
    expect(generator).toContain('rally-mark-source.png');
    expect(generator).toContain('rally-social.jpg');
    expect(generator).not.toMatch(/Avalon|avalon-mark|avalonTemplate/u);
    const migrationGuide = readFileSync(
      new URL('../../../docs/domain-migration.md', import.meta.url),
      'utf8',
    );
    expect(migrationGuide).toContain('/brand/rally-mark.png');
    expect(migrationGuide).not.toContain('/brand/rally-mark.svg');
  });

  it('keeps the shared invitation, auth handoff, and not-found surfaces styled and functional', () => {
    const styles = readProjectFile('src/styles.css');

    for (const selector of [
      '.button-arrow',
      '.not-found',
      '.invite-page',
      '.invite-shell',
      '.invite-card',
      '.invite-brand',
      '.invite-open',
      '.invite-help',
      '.invite-error',
    ]) {
      expect(styles).toContain(selector);
    }
    expect(styles).toContain(".invite-open[aria-disabled='true']");
    expect(styles).toContain('pointer-events: none');
  });

  it('keeps internal landing-page studies out of search indexes', () => {
    for (const path of ['concepts/index.html', 'concepts/horizon/index.html', 'concepts/hero/index.html']) {
      expect(readProjectFile(path)).toContain('<meta name="robots" content="noindex, nofollow" />');
    }
  });

  it('uses the same attention-first work-stream heading as the desktop sidebar', () => {
    const page = readProjectFile('index.html');

    expect(page).toContain('<p>Waiting for you</p>');
    expect(page).not.toContain('<p>Unread</p>');
  });

  it('uses the official black Apple logo in the primary macOS call to action', () => {
    const page = readProjectFile('index.html');

    expect(page).toContain('src="/brand/apple-logo.svg"');
    expect(page).not.toContain('<span class="apple-mark"');
    expect(existsSync(new URL('../public/brand/apple-logo.svg', import.meta.url))).toBe(true);
    const release = parseDesktopReleaseConfig(JSON.parse(readProjectFile('release.config.json')) as unknown);
    expect(renderDesktopRelease(page, release)).toContain(
      '<img src="/brand/apple-logo.svg" width="14" height="17" alt="" />',
    );
  });

  it('publishes the verified installer while keeping the source template free of stale release links', () => {
    const page = readProjectFile('index.html');
    const release = parseDesktopReleaseConfig(JSON.parse(readProjectFile('release.config.json')) as unknown);

    expect(release.published).toBe(true);
    expect(release.downloadBaseUrl).toBe('https://downloads.rallywith.ai');
    expect(release.bucket).toBe('avalon-desktop-releases');
    expect(release.prefix).toBe('stable/darwin/arm64');
    expect(release.files).toMatchObject({
      dmg: `Rally-${release.version}-mac-arm64.dmg`,
      zip: `Rally-${release.version}-mac-arm64.zip`,
    });
    expect(desktopDmgUrl(release)).toBe(
      'https://downloads.rallywith.ai/stable/darwin/arm64/Rally.dmg',
    );
    expect(page).not.toMatch(/href="[^"]+\.(?:dmg|zip)"/i);
    expect(page).toContain('Downloads opening soon');
    expect(renderDesktopRelease(page, release)).toContain('Download Rally for macOS');
    expect(renderDesktopRelease(page, release)).not.toContain('Preview 0.1.0');
  });

  it('renders the immutable DMG object only after a release is published', () => {
    const page = readProjectFile('index.html');
    const base = unpublishedReleaseFixture();
    const { dmg } = base.files as { dmg: string };
    const release = parseDesktopReleaseConfig({
      ...base,
      published: true,
      sha256: {
        [dmg]: 'a'.repeat(64),
        'Rally.dmg': 'a'.repeat(64),
      },
      publishedAt: '2026-08-02T12:00:00.000Z',
    });

    const rendered = renderDesktopRelease(page, release);

    expect(desktopDmgUrl(release)).toBe(
      'https://downloads.rallywith.ai/stable/darwin/arm64/Rally.dmg',
    );
    expect(rendered).toContain(
      'href="https://downloads.rallywith.ai/stable/darwin/arm64/Rally.dmg"',
    );
    expect(rendered).toContain('Download Rally for macOS');
    expect(rendered).not.toContain('Downloads opening soon');
  });

  it('rediscovers a promoted canonical release during later site deployments', async () => {
    const page = readProjectFile('index.html');
    const release = parseDesktopReleaseConfig(unpublishedReleaseFixture());
    const fetchRelease: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname.endsWith('/latest-mac.yml')) {
        const manifest = 'version: 0.1.0\nfiles:\n  - url: Rally-0.1.0-mac-arm64.zip\n';
        return new Response(manifest, {
          status: 200,
          headers: { 'content-length': String(new TextEncoder().encode(manifest).byteLength) },
        });
      }
      if (init?.method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: {
            'content-length': '42',
            'last-modified': 'Sun, 02 Aug 2026 19:00:00 GMT',
          },
        });
      }
      return new Response(new Uint8Array([0]), {
        status: 206,
        headers: { 'content-range': 'bytes 0-0/42' },
      });
    };

    const publication = await discoverDesktopRelease(release, fetchRelease);

    expect(publication).toEqual({
      published: true,
      version: '0.1.0',
      publishedAt: '2026-08-02T19:00:00.000Z',
    });
    expect(desktopDmgUrl(release, publication)).toBe(
      'https://downloads.rallywith.ai/stable/darwin/arm64/Rally.dmg',
    );
    expect(renderDesktopRelease(page, release, publication)).toContain('Download Rally for macOS');
  });

  it('keeps a genuinely missing release unpublished but rejects inconsistent promotion state', async () => {
    const release = parseDesktopReleaseConfig(unpublishedReleaseFixture());
    const notFound: typeof fetch = async () => new Response(null, { status: 404 });
    const invalidRange: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname.endsWith('/latest-mac.yml')) {
        return new Response(
          `version: ${release.version}\nfiles:\n  - url: Rally-${release.version}-mac-arm64.zip\n`,
        );
      }
      if (init?.method === 'HEAD') {
        return new Response(null, { headers: { 'content-length': '42' } });
      }
      return new Response(new Uint8Array([0]), {
        status: 200,
        headers: { 'content-range': 'bytes 0-0/42' },
      });
    };

    await expect(discoverDesktopRelease(release, notFound)).resolves.toEqual({
      published: false,
      version: release.version,
    });
    await expect(discoverDesktopRelease(release, invalidRange)).rejects.toThrow(/range/u);
  });

  it('refuses to activate a release whose object map or verification data is inconsistent', () => {
    const base = unpublishedReleaseFixture();

    expect(() => parseDesktopReleaseConfig({
      ...base,
      published: true,
      publishedAt: '2026-08-02T12:00:00.000Z',
    })).toThrow(/SHA-256/u);
    expect(() => parseDesktopReleaseConfig({
      ...base,
      objects: {
        ...(base.objects as Record<string, unknown>),
        dmg: 'stable/darwin/arm64/not-the-configured-installer.dmg',
      },
    })).toThrow(/object keys/u);
  });

  it('declares every production custom domain and restrictive static-site headers', () => {
    const wrangler = parseJsonc(readProjectFile('wrangler.jsonc')) as {
      routes: Array<{ pattern: string; custom_domain: boolean }>;
      workers_dev: boolean;
      preview_urls: boolean;
    };
    const headers = readProjectFile('public/_headers');

    // Both zones are served while the rename is in flight. The Avalon pair is
    // asserted, not merely tolerated: dropping it silently 404s every link
    // already indexed, unfurled, or printed in a signature block.
    expect(wrangler.routes).toEqual([
      { pattern: 'rallywith.ai', custom_domain: true },
      { pattern: 'www.rallywith.ai', custom_domain: true },
      { pattern: 'with-avalon.com', custom_domain: true },
      { pattern: 'www.with-avalon.com', custom_domain: true },
    ]);
    expect(wrangler.workers_dev).toBe(false);
    expect(wrangler.preview_urls).toBe(false);
    expect(headers).toContain("script-src 'self'");
    expect(headers).toContain("frame-ancestors 'none'");
    expect(headers).toMatch(/\/rally-social\.jpg\n {2}Cache-Control: public, max-age=86400/u);
    expect(headers).not.toContain('/og.png');
  });

  it('provides a private desktop invitation handoff without sending the token to the server', () => {
    const page = readProjectFile('invite/index.html');
    const script = readProjectFile('src/invite.ts');

    expect(page).toContain('Continue in the Rally app');
    expect(page).toContain('noindex, nofollow');
    expect(script).toContain('window.location.hash');
    expect(script).toContain("new URL('rallywithai://invitations/accept')");
    expect(script).toContain('window.history.replaceState');
    expect(script).not.toContain('window.location.search');
  });

  it('provides a private Slack identity handoff to the signed-in desktop app', () => {
    const page = readProjectFile('slack/link/index.html');
    const script = readProjectFile('src/slack-link.ts');

    expect(page).toContain('Continue in the Rally app');
    expect(page).toContain('noindex, nofollow');
    expect(script).toContain('window.location.hash');
    expect(script).toContain("new URL('rallywithai://slack/link')");
    expect(script).toContain('window.history.replaceState');
    expect(script).not.toContain('window.location.search');
  });

  it('ships working Marketplace landing, privacy, support, and exact desktop handoff surfaces', () => {
    const landing = readProjectFile('slack/index.html');
    const privacy = readProjectFile('privacy/index.html');
    const support = readProjectFile('support/index.html');
    const handoff = readProjectFile('src/desktop-open.ts');

    expect(landing).toContain('Optional personal authorization');
    expect(landing).toContain('/privacy');
    expect(privacy).toContain('does not scrape, mirror');
    expect(support).toContain('within two business days');
    expect(support).toContain('Generate a Granola Workspace API key');
    expect(support).toContain('Settings → Connectors → Workspace API keys');
    expect(support).toContain('Create new key');
    expect(support).toContain('Personal connections use Granola’s browser sign-in and do not require an API key.');
    expect(support).toContain('https://docs.granola.ai/help-center/sharing/integrations/granola-api');
    expect(readProjectFile('index.html')).toContain('href="/support/#granola-key-title">Granola</a>');
    expect(handoff).toContain("url.hostname === 'workstreams'");
    expect(handoff).toContain("url.hostname === 'settings'");
    expect(handoff).toContain("url.hostname === 'automations'");
    expect(handoff).toContain('window.location.hash');
    expect(handoff).toContain('window.history.replaceState');
    expect(handoff).not.toContain('window.location.search');
  });

  it('publishes a complete, cross-linked Rally Trust Center', () => {
    const landing = readProjectFile('index.html');
    const sitemap = readProjectFile('public/sitemap.xml');
    const policies = [
      ['terms/index.html', '/terms', 'Terms of Service'],
      ['privacy/index.html', '/privacy', 'Privacy Policy'],
      ['acceptable-use/index.html', '/acceptable-use', 'Acceptable Use Policy'],
      ['dpa/index.html', '/dpa', 'Data Processing Addendum'],
      ['subprocessors/index.html', '/subprocessors', 'Sub-processors'],
      ['cookies/index.html', '/cookies', 'Cookie &amp; Tracking Notice'],
      ['security/index.html', '/security', 'Trust Center'],
    ] as const;

    for (const [, route] of policies) {
      expect(landing).toContain(`href="${route}/"`);
      expect(sitemap).toContain(`https://rallywith.ai${route}`);
    }

    for (const [path, route, title] of policies) {
      const page = readProjectFile(path);
      expect(page).toContain('<body class="legal-page">');
      expect(page).toContain(title);
      expect(page).toContain('Juno AI Labs');
      expect(page).toContain(`rel="canonical" href="https://rallywith.ai${route}"`);
      for (const [, linkedRoute] of policies) {
        expect(page).toContain(`href="${linkedRoute}/"`);
      }
    }

    const privacy = readProjectFile('privacy/index.html');
    expect(privacy).toContain('Effective August 25, 2026');
    expect(privacy).toContain('does not scrape, mirror');
    expect(privacy).toContain('do not sell personal information');
    expect(privacy).toContain('accepted product-event and delivery records expire within 90 days');
    expect(readProjectFile('dpa/index.html')).toContain('without undue delay');
    expect(readProjectFile('dpa/index.html')).toContain('Annex B · Technical and organizational measures');
    expect(readProjectFile('subprocessors/index.html')).toContain('Cloudflare, Inc.');
    expect(readProjectFile('cookies/index.html')).toContain('uses bounded first-party product analytics');
    expect(readProjectFile('cookies/index.html')).toContain('uses no persistent browser analytics identifier');
    expect(readProjectFile('cookies/index.html')).toContain("does not load PostHog's browser SDK");
    expect(readProjectFile('security/index.html')).toContain('context isolation');
    expect(readProjectFile('security/index.html')).not.toContain('Request access');
    expect(readProjectFile('security/index.html')).not.toContain('SOC 2');
    expect(readProjectFile('security/index.html')).not.toContain('<i aria-label="Implemented">');
    expect(readProjectFile('security/index.html').match(/role="img" aria-label="Implemented"/gu)).toHaveLength(7);
    const [landingContent, landingFooter] = landing.split('<footer class="rally-footer">');
    expect(landingContent).not.toContain('/security/');
    expect(landingFooter).toContain('<a href="/security/">Trust Center</a>');
  });

  it('uses Rally grammar and Trust Center naming on every public page', () => {
    const pages = [
      'index.html', 'invite/index.html', 'slack/index.html', 'terms/index.html',
      'privacy/index.html', 'acceptable-use/index.html', 'dpa/index.html',
      'subprocessors/index.html', 'cookies/index.html', 'security/index.html',
    ];
    for (const path of pages) {
      const page = readProjectFile(path);
      expect(page, path).not.toMatch(/\b[Aa]n Rally\b/u);
      expect(page, path).not.toContain('>Security Policy<');
    }
  });

  it('uses help@rallywith.ai as the only role-based public contact and preserves triage subjects', () => {
    const publicHtmlPaths = readdirSync(new URL('../', import.meta.url), {
      encoding: 'utf8',
      recursive: true,
    }).filter((path) => path.endsWith('.html')
      && !path.startsWith('dist/')
      && !path.startsWith('node_modules/'));
    const publicAddresses = new Set<string>();
    const publicMailtoTargets = new Set<string>();

    for (const path of publicHtmlPaths) {
      const page = readProjectFile(path);
      const addresses = page.match(/[a-z0-9._%+-]+@rallywith\.ai/giu) ?? [];
      for (const address of addresses) {
        const normalizedAddress = address.toLowerCase();
        publicAddresses.add(normalizedAddress);
        expect(normalizedAddress, path).toBe('help@rallywith.ai');
      }
      for (const target of page.match(/mailto:[^"\s]+/gu) ?? []) {
        publicMailtoTargets.add(target);
        expect(target, path).toMatch(/^mailto:help@rallywith\.ai\?subject=[^&"\s]+$/u);
      }
    }

    expect(publicAddresses).toEqual(new Set(['help@rallywith.ai']));
    expect(publicMailtoTargets.size).toBeGreaterThan(0);
  });

  it('routes site telemetry before choosing whether an anonymous browser identifier may persist', () => {
    const telemetry = readProjectFile('src/telemetry.ts');
    const headers = readProjectFile('public/_headers');

    expect(telemetry).toContain("'https://api.rallywith.ai'");
    expect(telemetry).toContain('/telemetry/route');
    expect(telemetry).toContain('/telemetry/bootstrap');
    expect(telemetry).toContain('/telemetry/anonymous');
    expect(telemetry).not.toContain('https://eu.api.rallywith.ai');
    expect(telemetry).toContain("route.route === 'global' ? globalAnonymousEpochId() : transientAnonymousEpochId");
    expect(telemetry).toContain('routeToken: route.routeToken');
    expect(telemetry).not.toContain('sessionStorage');
    expect(telemetry).toContain("report('site_page_viewed'");
    expect(telemetry).toContain("report('site_page_left'");
    expect(headers).toMatch(/^\/\*\n {2}Content-Security-Policy:/u);
    expect(headers).toContain("connect-src https://api.rallywith.ai https://api.with-avalon.com");
    expect(headers).not.toContain("connect-src 'none'");
    expect(headers).not.toContain('https://eu.api.rallywith.ai');
  });

  it('removes resource identity from public handoff paths and classifies invalid targets truthfully', () => {
    expect(normalizedTelemetryPathname('/app/workstreams/2f1d3c4b-5a69-4f2e-8c11-9d7b6a5e4f30'))
      .toBe('/app/workstreams/:id');
    expect(normalizedTelemetryPathname('/privacy/')).toBe('/privacy/');
    expect(classifyDesktopHandoffTarget('avalon://workstreams/not-a-uuid')).toEqual({
      handoffType: 'workstream', validity: 'invalid',
    });
    expect(classifyDesktopHandoffTarget(null)).toEqual({
      handoffType: 'unknown', validity: 'invalid',
    });
  });

  it('validates and launches only exact desktop OAuth handoff targets', () => {
    const ticket = 'single-use-ticket_long-enough-1234567890';
    const attempt = 'a'.repeat(43);
    const successTarget = `avalon://auth/complete?ticket=${ticket}&region=global&attempt=${attempt}`;
    const errorTarget = `avalon://auth/complete?error=google_oauth_denied&region=global&attempt=${attempt}`;
    const connectorSuccessTarget = `avalon://auth/complete?connection=00000000-0000-7000-8000-000000000004&status=connected&region=eu&attempt=${attempt}&provider=linear`;
    const connectorErrorTarget = `avalon://auth/complete?provider=linear&region=eu&attempt=${attempt}&status=denied&error=oauth_denied`;
    const granolaSuccessTarget = `avalon://auth/complete?connection=00000000-0000-7000-8000-000000000005&status=connected&region=global&attempt=${attempt}&provider=granola`;
    const granolaErrorTarget = `avalon://auth/complete?provider=granola&region=global&attempt=${attempt}&status=failed&error=connector_oauth_failed`;
    const asFragment = (target: string): string => `#${new URLSearchParams({ target }).toString()}`;

    expect(parseDesktopTarget(asFragment(successTarget))).toBe(successTarget);
    expect(parseDesktopTarget(asFragment(errorTarget))).toBe(errorTarget);
    expect(parseDesktopTarget(asFragment(connectorSuccessTarget))).toBe(connectorSuccessTarget);
    expect(parseDesktopTarget(asFragment(connectorErrorTarget))).toBe(connectorErrorTarget);
    expect(parseDesktopTarget(asFragment(granolaSuccessTarget))).toBe(granolaSuccessTarget);
    expect(parseDesktopTarget(asFragment(granolaErrorTarget))).toBe(granolaErrorTarget);
    expect(parseDesktopTarget(asFragment('avalon://auth/complete?error=google_oauth_denied')))
      .toBe('avalon://auth/complete?error=google_oauth_denied');
    expect(parseDesktopTarget(`?target=${encodeURIComponent(successTarget)}`)).toBeNull();
    expect(parseDesktopTarget(`${asFragment(successTarget)}&extra=value`)).toBeNull();
    expect(parseDesktopTarget(asFragment(`avalon://auth/complete?ticket=${ticket}&region=global`))).toBeNull();
    expect(parseDesktopTarget(asFragment(`avalon://auth/complete?ticket=${ticket}&region=us&attempt=${attempt}`))).toBeNull();
    expect(parseDesktopTarget(asFragment(`avalon://auth/complete?ticket=${ticket}&region=global&attempt=short`))).toBeNull();
    expect(parseDesktopTarget(asFragment(`avalon://auth/complete?ticket=${ticket}&region=global&attempt=${attempt}&extra=value`))).toBeNull();
    expect(parseDesktopTarget(asFragment('avalon://auth/complete?connection=00000000-0000-7000-8000-000000000004&status=connected&region=eu&provider=linear')))
      .toBe('avalon://auth/complete?connection=00000000-0000-7000-8000-000000000004&status=connected&region=eu&provider=linear');
    expect(parseDesktopTarget(asFragment('avalon://auth/complete?connection=00000000-0000-7000-8000-0000000000-4&status=connected&region=eu&provider=linear')))
      .toBeNull();
    expect(parseDesktopTarget(asFragment(`avalon://auth/complete?connection=00000000-0000-7000-8000-000000000004&status=connected&region=eu&attempt=${attempt}`))).toBeNull();
    expect(parseDesktopTarget(asFragment(`avalon://auth/complete?provider=unknown&region=eu&attempt=${attempt}&status=denied&error=oauth_denied`))).toBeNull();
    expect(parseDesktopTarget(asFragment(`https://with-avalon.com/?ticket=${ticket}&region=global&attempt=${attempt}`))).toBeNull();
    expect(parseDesktopTarget(asFragment(`avalon://auth/complete/?ticket=${ticket}&region=global&attempt=${attempt}`))).toBeNull();

    const page = readProjectFile('auth/desktop/index.html');
    const script = readProjectFile('src/auth-handoff.ts');
    expect(page).toContain('Secure desktop handoff');
    expect(page).toContain('id="open-rally"');
    expect(page).toContain('noindex, nofollow');
    expect(script).toContain('window.location.hash');
    expect(script).toContain('window.history.replaceState');
    expect(script).not.toContain('window.location.search');
    expect(script).not.toMatch(/console\./u);
    expect(script).not.toContain('textContent = target');
  });
});

describe('canonical work-stream links', () => {
  it('serves one handoff page for every work-stream id through a path rewrite', () => {
    const redirects = readProjectFile('public/_redirects');
    const config = readProjectFile('vite.config.ts');
    const page = readProjectFile('app/workstreams/index.html');

    // No asset can exist per id, so the rewrite is what makes the canonical
    // path resolve at all. Losing it turns every shared link into a 404.
    expect(redirects).toContain('/app/workstreams/*  /app/workstreams/  200');
    expect(config).toContain('app/workstreams/index.html');
    expect(page).toContain('id="open-rally"');
    expect(page).toContain('noindex, nofollow');
    expect(page).toContain('<script type="module" src="/src/workstream-link.ts"></script>');
  });

  it('reads the id from the path and hands off without exposing work-stream content', () => {
    const script = readProjectFile('src/workstream-link.ts');

    expect(script).toContain('window.location.pathname');
    expect(script).toContain('parseWorkstreamLinkPath');
    expect(script).toContain('workstreamDeepLink');
    // The page is a handoff, not a viewer: it must never fetch or render the
    // work stream, which would leak content the visitor is not authorized for.
    expect(script).not.toContain('fetch(');
    expect(script).not.toMatch(/console\./u);
    expect(script).not.toContain('innerHTML');
  });

  it('keeps the handoff page out of shared caches', () => {
    const headers = readProjectFile('public/_headers');

    expect(headers).toContain('/app/workstreams/*');
    expect(headers.slice(headers.indexOf('/app/workstreams/*'))).toContain('Cache-Control: no-store');
  });
});
