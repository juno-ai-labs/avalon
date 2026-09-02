import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDesktopTarget } from '../src/auth-handoff';
import { parseSlackLinkFragment, slackDesktopTarget } from '../src/slack-link';
import { classifyDesktopHandoffTarget } from '../src/desktop-open';
import {
  desktopDmgUrl,
  discoverDesktopRelease,
  parseDesktopReleaseConfig,
  renderDesktopRelease,
} from '../src/release-config';
import { normalizedTelemetryPathname, sitePageForPath } from '../src/telemetry';

const readProjectFile = (path: string): string =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const supportPagePaths = [
  'support/index.html',
  'support/getting-started/index.html',
  'support/connectors/index.html',
  'support/connectors/google/index.html',
  'support/connectors/github/index.html',
  'support/connectors/granola/index.html',
  'support/connectors/linear/index.html',
  'support/connectors/notion/index.html',
  'support/connectors/slack/index.html',
  'support/connectors/inbound-webhook/index.html',
  'support/connectors/x/index.html',
  'support/contact/index.html',
] as const;

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

    expect(page).toContain('Live private preview');
    expect(page).toContain('Apple silicon');
    expect(page).not.toMatch(/<form\b/i);
    expect(page).not.toMatch(/sign[ -]?in/i);
    expect(page).toContain('<script type="module" src="/src/landing.ts"></script>');
  });

  it('ships the convergence hero with the multiplayer thesis on the Rally palette', () => {
    const page = readProjectFile('index.html');
    const styles = readProjectFile('src/styles.css');
    expect(page).toContain('Docs went multiplayer.<br />Design went multiplayer.<br /><em>AI is next.</em>');
    expect(page).toContain('class="rally-merge reveal"');
    expect(styles).toContain('--paper:#f0efe8');
    expect(styles).toContain('--blue:#47c7fc');
    expect(styles).toContain('--volt:#ccff00');
    expect(styles).toContain('--orange:#ff6337');
    expect(page).not.toContain('data-theme-select');
  });

  it('keeps content visible without scripts and hides the decorative workspace mock', () => {
    const page = readProjectFile('index.html');
    const styles = readProjectFile('src/styles.css');

    expect(styles).toContain('.reveal { opacity: 1; transform: none; }');
    expect(styles).toContain('html.js .reveal { opacity: 0;');
    expect(styles).toContain('html.js .reveal.is-visible { opacity: 1;');
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
      'trust/terms/index.html',
      'trust/privacy/index.html',
      'trust/acceptable-use/index.html',
      'trust/dpa/index.html',
      'trust/subprocessors/index.html',
      'trust/cookies/index.html',
      'trust/index.html',
      'trust/security/index.html',
      ...supportPagePaths,
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
      readProjectFile('trust/terms/index.html'),
      readProjectFile('trust/privacy/index.html'),
      readProjectFile('trust/acceptable-use/index.html'),
      readProjectFile('trust/dpa/index.html'),
      readProjectFile('trust/subprocessors/index.html'),
      readProjectFile('trust/cookies/index.html'),
      readProjectFile('trust/index.html'),
      readProjectFile('trust/security/index.html'),
      ...supportPagePaths.map((path) => readProjectFile(path)),
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
    expect(pages[0]).toContain('/brand/rally-mark.svg');
    expect(pages[0]).toContain('/brand/rally-mark-small.svg');
    // The lime cut at header size belongs to the dark homepage alone; every
    // light-surfaced page renders the ink cut so the mark keeps its contrast.
    for (const page of pages.slice(1)) {
      expect(page).toContain('/brand/rally-mark-ink.svg');
      expect(page).not.toContain('/brand/rally-mark.svg"');
    }
    for (const page of pages) {
      expect(page).not.toMatch(/Avalon|with-avalon|avalon-mark/iu);
      // Pages render the vector mark; the PNG stays on disk only because
      // provider manifests hotlink it by URL.
      expect(page).not.toContain('/brand/rally-mark.png');
      expect(page).toContain('/favicon.png');
      expect(page).not.toContain('✣');
      expect(page).not.toContain('/favicon.svg');
    }
    expect(styles).toContain('--brand-primary: #ccff00');
    expect(styles).toContain('--brand-secondary: #47c7fc');
    expect(styles).toContain('--orange:#ff6337');
    expect(manifest.theme_color).toBe('#111210');
    expect(manifest.background_color).toBe('#111210');
    expect(manifest.icons.map(({ src }) => src)).toEqual(['/favicon.png', '/apple-touch-icon.png']);
    expect(existsSync(new URL('../public/brand/rally-mark.png', import.meta.url))).toBe(true);
    expect(existsSync(new URL('../public/brand/rally-mark.svg', import.meta.url))).toBe(true);
    expect(existsSync(new URL('../public/brand/rally-mark-small.svg', import.meta.url))).toBe(true);
    expect(existsSync(new URL('../public/brand/rally-mark-ink.svg', import.meta.url))).toBe(true);
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
    expect(migrationGuide).toContain('/brand/rally-mark.svg');
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
    const token = 'a'.repeat(43);
    expect(parseSlackLinkFragment(`#token=${token}&region=eu&workspace=00000000-0000-7000-8000-000000000009`))
      .toEqual({
        token,
        workspaceTarget: { region: 'eu', workspaceId: '00000000-0000-7000-8000-000000000009' },
      });
    expect(slackDesktopTarget({
      token,
      workspaceTarget: { region: 'eu', workspaceId: '00000000-0000-7000-8000-000000000009' },
    })).toBe(
      `rallywithai://workspace/eu/00000000-0000-7000-8000-000000000009/slack/link?token=${token}`,
    );
    expect(parseSlackLinkFragment(`#token=${token}`)).toEqual({ token, workspaceTarget: null });
    expect(parseSlackLinkFragment(`#token=${token}&region=eu`)).toBeNull();
  });

  it('ships working Marketplace landing, privacy, support, and exact desktop handoff surfaces', () => {
    const landing = readProjectFile('slack/index.html');
    const privacy = readProjectFile('trust/privacy/index.html');
    const support = readProjectFile('support/index.html');
    const slackSupport = readProjectFile('support/connectors/slack/index.html');
    const granolaSupport = readProjectFile('support/connectors/granola/index.html');
    const handoff = readProjectFile('src/desktop-open.ts');

    expect(landing).toContain('Optional personal authorization');
    expect(landing).toContain('/trust/privacy');
    expect(privacy).toContain('does not scrape, mirror');
    expect(support).toContain('<title>Support Center · Rally</title>');
    expect(support).toContain('rel="canonical" href="https://rallywith.ai/support"');
    expect(support).toContain('within two business days');
    expect(support).toContain('Rally for Slack');
    expect(slackSupport).toContain('Slack App Management');
    expect(granolaSupport).toContain('Generate a Granola Workspace API key');
    expect(granolaSupport).toContain('Settings → Connectors → Workspace API keys');
    expect(granolaSupport).toContain('Create new key');
    expect(granolaSupport).toContain('Personal connections use Granola’s browser sign-in and do not require an API key.');
    expect(granolaSupport).toContain('https://docs.granola.ai/help-center/sharing/integrations/granola-api');
    expect(handoff).toContain('parseDesktopDeepLinkIntent');
    expect(handoff).toContain('parseWorkspaceAddressedDeepLink');
    expect(handoff).toContain('window.location.hash');
    expect(handoff).toContain('window.history.replaceState');
    expect(handoff).not.toContain('window.location.search');
  });

  it('publishes a multi-page Support Center for every product connector', () => {
    const hub = readProjectFile('support/index.html');
    const connectorHub = readProjectFile('support/connectors/index.html');
    const sitemap = readProjectFile('public/sitemap.xml');
    const connectorPages = [
      ['google', 'Google'],
      ['github', 'GitHub'],
      ['granola', 'Granola'],
      ['linear', 'Linear'],
      ['notion', 'Notion'],
      ['slack', 'Slack'],
      ['inbound-webhook', 'Inbound webhook'],
      ['x', 'Public X'],
    ] as const;

    expect(hub).toContain('href="/support/getting-started/"');
    expect(hub).toContain('href="/support/connectors/"');
    expect(hub).toContain('href="/support/contact/"');

    for (const [slug, title] of connectorPages) {
      const route = `/support/connectors/${slug}/`;
      const page = readProjectFile(`support/connectors/${slug}/index.html`);
      expect(hub, slug).toContain(`href="${route}"`);
      expect(connectorHub, slug).toContain(`href="${route}"`);
      expect(sitemap, slug).toContain(`https://rallywith.ai${route}`);
      expect(page, slug).toContain(`<title>${title} connector · Rally Support</title>`);
      expect(page, slug).toContain(`rel="canonical" href="https://rallywith.ai${route}"`);
      expect(page, slug).toContain('href="/support/connectors/"');
      expect(page, slug).toContain('href="/support/contact/"');
    }

    expect(readProjectFile('support/contact/index.html')).toContain('Safe details to send');
    expect(readProjectFile('support/contact/index.html')).toContain('Never send');
  });

  it('publishes a complete, cross-linked Rally Trust Center', () => {
    const landing = readProjectFile('index.html');
    const redirects = readProjectFile('public/_redirects');
    const sitemap = readProjectFile('public/sitemap.xml');
    const policies = [
      ['trust/index.html', '/trust', 'Trust Center'],
      ['trust/security/index.html', '/trust/security', 'Security'],
      ['trust/terms/index.html', '/trust/terms', 'Terms of Service'],
      ['trust/privacy/index.html', '/trust/privacy', 'Privacy Policy'],
      ['trust/acceptable-use/index.html', '/trust/acceptable-use', 'Acceptable Use Policy'],
      ['trust/dpa/index.html', '/trust/dpa', 'Data Processing Addendum'],
      ['trust/subprocessors/index.html', '/trust/subprocessors', 'Sub-processors'],
      ['trust/cookies/index.html', '/trust/cookies', 'Cookie &amp; Tracking Notice'],
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
      expect(page).toContain(`rel="canonical" href="https://rallywith.ai${route}/"`);
      for (const [, linkedRoute] of policies) {
        expect(page).toContain(`href="${linkedRoute}/"`);
      }
    }

    const privacy = readProjectFile('trust/privacy/index.html');
    expect(privacy).toContain('Effective August 25, 2026');
    expect(privacy).toContain('does not scrape, mirror');
    expect(privacy).toContain('do not sell personal information');
    expect(privacy).toContain('accepted product-event and delivery records expire within 90 days');
    expect(readProjectFile('trust/dpa/index.html')).toContain('without undue delay');
    expect(readProjectFile('trust/dpa/index.html')).toContain('Annex B · Technical and organizational measures');
    expect(readProjectFile('trust/subprocessors/index.html')).toContain('Cloudflare, Inc.');
    expect(readProjectFile('trust/cookies/index.html')).toContain('uses bounded first-party product analytics');
    expect(readProjectFile('trust/cookies/index.html')).toContain('uses no persistent browser analytics identifier');
    expect(readProjectFile('trust/cookies/index.html')).toContain("does not load PostHog's browser SDK");
    expect(readProjectFile('trust/security/index.html')).toContain('context isolation');
    expect(readProjectFile('trust/security/index.html')).not.toContain('Request access');
    expect(readProjectFile('trust/security/index.html')).not.toContain('SOC 2');
    expect(readProjectFile('trust/security/index.html')).not.toContain('<i aria-label="Implemented">');
    expect(readProjectFile('trust/security/index.html').match(/role="img" aria-label="Implemented"/gu)).toHaveLength(7);
    const [landingContent, landingFooter] = landing.split('<footer class="rally-footer">');
    expect(landingContent).not.toContain('/security/');
    expect(landingFooter).toContain('<a href="/trust/">Trust Center</a>');
    expect(redirects).toContain('/security  /trust/security/  301');
    expect(redirects).toContain('/privacy  /trust/privacy/  301');
    expect(redirects).toContain('/terms  /trust/terms/  301');
    expect(redirects).toContain('/dpa  /trust/dpa/  301');
  });

  it('uses Rally grammar and Trust Center naming on every public page', () => {
    const pages = [
      'index.html', 'invite/index.html', 'slack/index.html', 'trust/terms/index.html',
      'trust/privacy/index.html', 'trust/acceptable-use/index.html', 'trust/dpa/index.html',
      'trust/subprocessors/index.html', 'trust/cookies/index.html', 'trust/index.html',
      'trust/security/index.html',
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
    expect(normalizedTelemetryPathname(
      '/app/workspaces/eu/00000000-0000-7000-8000-000000000009/workstreams/2f1d3c4b-5a69-4f2e-8c11-9d7b6a5e4f30',
    )).toBe('/app/workspaces/:region/:workspace/workstreams/:id');
    expect(normalizedTelemetryPathname('/app/workstreams/2f1d3c4b-5a69-4f2e-8c11-9d7b6a5e4f30'))
      .toBe('/app/workstreams/:id');
    expect(normalizedTelemetryPathname(
      '/app/workspaces/eu/private-workspace/workstreams/private-workstream/extra',
    )).toBe('/app/workspaces/:region/:workspace/workstreams/:id');
    expect(normalizedTelemetryPathname('/app/workspaces/eu/private-workspace'))
      .toBe('/app/workspaces/:region/:workspace/workstreams/:id');
    expect(normalizedTelemetryPathname('/trust/privacy/')).toBe('/trust/privacy/');
    expect(sitePageForPath('/trust/privacy/')).toBe('legal');
    expect(classifyDesktopHandoffTarget('avalon://workstreams/not-a-uuid')).toEqual({
      handoffType: 'workstream', validity: 'invalid',
    });
    expect(classifyDesktopHandoffTarget(null)).toEqual({
      handoffType: 'unknown', validity: 'invalid',
    });

    expect(sitePageForPath('/app/workspaces/:region/:workspace/workstreams/:id'))
      .toBe('workstream_handoff');
  });

  it('explains that an addressed Slack handoff opens its installing workspace', () => {
    const page = readProjectFile('slack/link/index.html');

    expect(page).toContain('Rally will open the workspace that installed this Slack app');
    expect(page).not.toContain('Sign in to the Rally workspace that installed this Slack app');
  });

  it('validates and launches only exact desktop OAuth handoff targets', () => {
    const ticket = 'single-use-ticket_long-enough-1234567890';
    const attempt = 'a'.repeat(43);
    const successTarget = `avalon://auth/complete?ticket=${ticket}&region=global&attempt=${attempt}`;
    const errorTarget = `avalon://auth/complete?error=google_oauth_denied&region=global&attempt=${attempt}`;
    const connectorSuccessTarget = `avalon://auth/complete?connection=00000000-0000-7000-8000-000000000004&status=connected&region=eu&attempt=${attempt}&provider=linear`;
    const targetedConnectorSuccess = `avalon://workspace/eu/00000000-0000-7000-8000-000000000009/auth/complete?connection=00000000-0000-7000-8000-000000000004&status=connected&attempt=${attempt}&provider=linear`;
    const connectorErrorTarget = `avalon://auth/complete?provider=linear&region=eu&attempt=${attempt}&status=denied&error=oauth_denied`;
    const granolaSuccessTarget = `avalon://auth/complete?connection=00000000-0000-7000-8000-000000000005&status=connected&region=global&attempt=${attempt}&provider=granola`;
    const granolaErrorTarget = `avalon://auth/complete?provider=granola&region=global&attempt=${attempt}&status=failed&error=connector_oauth_failed`;
    const asFragment = (target: string): string => `#${new URLSearchParams({ target }).toString()}`;

    expect(parseDesktopTarget(asFragment(successTarget))).toBe(successTarget);
    expect(parseDesktopTarget(asFragment(errorTarget))).toBe(errorTarget);
    expect(parseDesktopTarget(asFragment(connectorSuccessTarget))).toBe(connectorSuccessTarget);
    expect(parseDesktopTarget(asFragment(targetedConnectorSuccess))).toBe(targetedConnectorSuccess);
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
    expect(redirects).toContain('/app/workspaces/*  /app/workstreams/  200');
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
