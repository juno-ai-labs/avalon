import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDesktopTarget } from '../src/auth-handoff';
import {
  desktopDmgUrl,
  discoverDesktopRelease,
  parseDesktopReleaseConfig,
  renderDesktopRelease,
} from '../src/release-config';

const readProjectFile = (path: string): string =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function unpublishedReleaseFixture(): Record<string, unknown> {
  return {
    ...JSON.parse(readProjectFile('release.config.json')) as Record<string, unknown>,
    published: false,
    sha256: {},
    publishedAt: null,
  };
}

describe('public Avalon site', () => {
  it('presents Avalon as a desktop product without exposing an app sign-in surface', () => {
    const page = readProjectFile('index.html');

    expect(page).toContain('Desktop preview for macOS');
    expect(page).toContain('currently ships as a macOS desktop product');
    expect(page).toContain('not a browser version');
    expect(page).not.toMatch(/<form\b/i);
    expect(page).not.toMatch(/sign[ -]?in/i);
    expect(page).toContain('<script type="module" src="/src/landing.ts"></script>');
  });

  it('shuffles four complete landing designs while keeping each landscape paired to its theme', () => {
    const page = readProjectFile('index.html');
    const script = readProjectFile('src/landing.ts');
    const styles = readProjectFile('src/styles.css');
    const themes = ['runway', 'valley', 'proof', 'afterlight'];
    const names = ['Warp', 'Mesh', 'Trace', 'Orbit'];

    for (const theme of themes) {
      expect(page).toContain(`data-theme-panel="${theme}"`);
      expect(page).toContain(`data-theme-select="${theme}"`);
      expect(script).toContain(`"${theme}"`);
      expect(styles).toContain(`html[data-theme='${theme}']`);
    }
    expect(page).toContain('data-theme-panel="runway" data-active aria-hidden="false"');
    expect(page).toContain('data-theme-select="runway" aria-label="Use Warp design" aria-pressed="true"');
    expect(script).toContain('root.dataset.themeReady = ""');
    expect(styles).toContain("url('/concepts/biomes/high-desert.webp')");
    expect(styles).toContain("url('/concepts/biomes/boreal-wetland.webp')");
    expect(styles).toContain("url('/concepts/biomes/volcanic-coast.webp')");
    expect(styles).toContain("url('/concepts/biomes/alpine-tundra.webp')");
    for (const name of names) expect(page).toContain(name);
  });

  it('keeps Avalon inherent instead of presenting it as a removable participant', () => {
    const page = readProjectFile('index.html');

    expect(page).toContain('2 participants');
    expect(page).not.toContain('3 participants');
    expect(page).not.toContain('avalon-chip');
    expect(page).not.toMatch(/person-chip[^>]*>[^<]*Avalon/i);
  });

  it('uses the canonical brand mark and current brand palette on every public surface', () => {
    const pages = [
      readProjectFile('index.html'),
      readProjectFile('invite/index.html'),
      readProjectFile('auth/desktop/index.html'),
      readProjectFile('404.html'),
    ];
    const styles = readProjectFile('src/styles.css');
    const manifest = JSON.parse(readProjectFile('public/site.webmanifest')) as {
      background_color: string;
      theme_color: string;
      icons: Array<{ src: string }>;
    };

    for (const page of pages) {
      expect(page).toContain('/brand/avalon-mark.png');
      expect(page).toContain('/favicon.png');
      expect(page).not.toContain('✣');
      expect(page).not.toContain('/favicon.svg');
    }
    expect(styles).toContain('--brand-primary: #cedc00');
    expect(styles).toContain('--brand-secondary: #47c7fc');
    expect(styles).not.toContain('--orange:');
    expect(manifest.theme_color).toBe('#111210');
    expect(manifest.background_color).toBe('#111210');
    expect(manifest.icons.map(({ src }) => src)).toEqual(['/favicon.png', '/apple-touch-icon.png']);
    expect(existsSync(new URL('../public/brand/avalon-mark.png', import.meta.url))).toBe(true);
    expect(existsSync(new URL('../public/favicon.png', import.meta.url))).toBe(true);
    expect(existsSync(new URL('../public/apple-touch-icon.png', import.meta.url))).toBe(true);
    expect(existsSync(new URL('../public/og.png', import.meta.url))).toBe(true);
    const socialCard = new URL('../public/og-2026.jpg', import.meta.url);
    expect(existsSync(socialCard)).toBe(true);
    expect(statSync(socialCard).size).toBeLessThan(200_000);
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
    for (const path of ['concepts/index.html', 'concepts/horizon/index.html']) {
      expect(readProjectFile(path)).toContain('<meta name="robots" content="noindex, nofollow" />');
    }
  });

  it('uses the same recency-only work-stream heading as the desktop sidebar', () => {
    const page = readProjectFile('index.html');

    expect(page).toContain('<p>Last hour</p>');
    expect(page).not.toContain('<p>Today</p>');
  });

  it('uses the official black Apple logo in the primary macOS call to action', () => {
    const page = readProjectFile('index.html');

    expect(page).toContain('src="/brand/apple-logo.svg"');
    expect(page).not.toContain('<span class="apple-mark"');
    expect(existsSync(new URL('../public/brand/apple-logo.svg', import.meta.url))).toBe(true);
  });

  it('publishes the verified installer while keeping the source template free of stale release links', () => {
    const page = readProjectFile('index.html');
    const release = parseDesktopReleaseConfig(JSON.parse(readProjectFile('release.config.json')) as unknown);

    expect(release.published).toBe(true);
    expect(release.downloadBaseUrl).toBe('https://downloads.with-avalon.com');
    expect(release.bucket).toBe('avalon-desktop-releases');
    expect(release.prefix).toBe('stable/darwin/arm64');
    expect(release.files).toMatchObject({
      dmg: `Avalon-${release.version}-mac-arm64.dmg`,
      zip: `Avalon-${release.version}-mac-arm64.zip`,
    });
    expect(desktopDmgUrl(release)).toBe(
      'https://downloads.with-avalon.com/stable/darwin/arm64/Avalon.dmg',
    );
    expect(page).not.toMatch(/href="[^"]+\.(?:dmg|zip)"/i);
    expect(page).toContain('Downloads opening soon');
    expect(renderDesktopRelease(page, release)).toContain('Download Avalon for macOS');
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
        'Avalon.dmg': 'a'.repeat(64),
      },
      publishedAt: '2026-08-02T12:00:00.000Z',
    });

    const rendered = renderDesktopRelease(page, release);

    expect(desktopDmgUrl(release)).toBe(
      'https://downloads.with-avalon.com/stable/darwin/arm64/Avalon.dmg',
    );
    expect(rendered).toContain(
      'href="https://downloads.with-avalon.com/stable/darwin/arm64/Avalon.dmg"',
    );
    expect(rendered).toContain('Download Avalon for macOS');
    expect(rendered).not.toContain('Downloads opening soon');
  });

  it('rediscovers a promoted canonical release during later site deployments', async () => {
    const page = readProjectFile('index.html');
    const release = parseDesktopReleaseConfig(unpublishedReleaseFixture());
    const fetchRelease: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname.endsWith('/latest-mac.yml')) {
        const manifest = 'version: 0.1.0\nfiles:\n  - url: Avalon-0.1.0-mac-arm64.zip\n';
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
      'https://downloads.with-avalon.com/stable/darwin/arm64/Avalon.dmg',
    );
    expect(renderDesktopRelease(page, release, publication)).toContain('Download Avalon for macOS');
  });

  it('keeps a genuinely missing release unpublished but rejects inconsistent promotion state', async () => {
    const release = parseDesktopReleaseConfig(unpublishedReleaseFixture());
    const notFound: typeof fetch = async () => new Response(null, { status: 404 });
    const invalidRange: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname.endsWith('/latest-mac.yml')) {
        return new Response(
          `version: ${release.version}\nfiles:\n  - url: Avalon-${release.version}-mac-arm64.zip\n`,
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

  it('declares both production custom domains and restrictive static-site headers', () => {
    const wrangler = JSON.parse(readProjectFile('wrangler.jsonc')) as {
      routes: Array<{ pattern: string; custom_domain: boolean }>;
      workers_dev: boolean;
      preview_urls: boolean;
    };
    const headers = readProjectFile('public/_headers');

    expect(wrangler.routes).toEqual([
      { pattern: 'with-avalon.com', custom_domain: true },
      { pattern: 'www.with-avalon.com', custom_domain: true },
    ]);
    expect(wrangler.workers_dev).toBe(false);
    expect(wrangler.preview_urls).toBe(false);
    expect(headers).toContain("script-src 'self'");
    expect(headers).toContain("frame-ancestors 'none'");
  });

  it('provides a private desktop invitation handoff without sending the token to the server', () => {
    const page = readProjectFile('invite/index.html');
    const script = readProjectFile('src/invite.ts');

    expect(page).toContain('Continue in the Avalon app');
    expect(page).toContain('noindex, nofollow');
    expect(script).toContain('window.location.hash');
    expect(script).toContain("new URL('avalon://invitations/accept')");
    expect(script).toContain('window.history.replaceState');
    expect(script).not.toContain('window.location.search');
  });

  it('validates and launches only exact desktop OAuth handoff targets', () => {
    const ticket = 'single-use-ticket_long-enough-1234567890';
    const attempt = 'a'.repeat(43);
    const successTarget = `avalon://auth/complete?ticket=${ticket}&region=global&attempt=${attempt}`;
    const errorTarget = `avalon://auth/complete?error=google_oauth_denied&region=global&attempt=${attempt}`;
    const asFragment = (target: string): string => `#${new URLSearchParams({ target }).toString()}`;

    expect(parseDesktopTarget(asFragment(successTarget))).toBe(successTarget);
    expect(parseDesktopTarget(asFragment(errorTarget))).toBe(errorTarget);
    expect(parseDesktopTarget(asFragment('avalon://auth/complete?error=google_oauth_denied')))
      .toBe('avalon://auth/complete?error=google_oauth_denied');
    expect(parseDesktopTarget(`?target=${encodeURIComponent(successTarget)}`)).toBeNull();
    expect(parseDesktopTarget(`${asFragment(successTarget)}&extra=value`)).toBeNull();
    expect(parseDesktopTarget(asFragment(`avalon://auth/complete?ticket=${ticket}&region=global`))).toBeNull();
    expect(parseDesktopTarget(asFragment(`avalon://auth/complete?ticket=${ticket}&region=us&attempt=${attempt}`))).toBeNull();
    expect(parseDesktopTarget(asFragment(`avalon://auth/complete?ticket=${ticket}&region=global&attempt=short`))).toBeNull();
    expect(parseDesktopTarget(asFragment(`avalon://auth/complete?ticket=${ticket}&region=global&attempt=${attempt}&extra=value`))).toBeNull();
    expect(parseDesktopTarget(asFragment(`https://with-avalon.com/?ticket=${ticket}&region=global&attempt=${attempt}`))).toBeNull();
    expect(parseDesktopTarget(asFragment(`avalon://auth/complete/?ticket=${ticket}&region=global&attempt=${attempt}`))).toBeNull();

    const page = readProjectFile('auth/desktop/index.html');
    const script = readProjectFile('src/auth-handoff.ts');
    expect(page).toContain('Secure desktop sign-in');
    expect(page).toContain('id="open-avalon"');
    expect(page).toContain('noindex, nofollow');
    expect(script).toContain('window.location.hash');
    expect(script).toContain('window.history.replaceState');
    expect(script).not.toContain('window.location.search');
    expect(script).not.toMatch(/console\./u);
    expect(script).not.toContain('textContent = target');
  });
});
