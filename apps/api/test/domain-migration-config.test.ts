import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The deployed shape of the Rally/Avalon dual serving, asserted against the
 * Wrangler configs themselves.
 *
 * These are the invariants nothing else can catch. A request test proves the
 * origin allowlist *works*; only reading the config proves the deployment
 * actually lists the origins real clients send. Dropping one is silent here and
 * total in production — every installed desktop rejected at the CORS
 * preflight, every indexed link 404ing — so it is worth a test that fails on
 * the edit rather than on the deploy.
 *
 * See `docs/domain-migration.md`.
 */

interface WorkerConfig {
  vars?: Record<string, string>;
  routes?: Array<{ pattern?: string; custom_domain?: boolean }>;
}

function config(fileName: string): WorkerConfig {
  const raw = readFileSync(new URL(`../${fileName}`, import.meta.url), 'utf8');
  return JSON.parse(raw.replace(/^\s*\/\/.*$/gmu, '')) as WorkerConfig;
}

function origins(fileName: string): string[] {
  return (config(fileName).vars?.['ALLOWED_ORIGINS'] ?? '').split(',').map((value) => value.trim());
}

function patterns(fileName: string): string[] {
  return (config(fileName).routes ?? []).map((route) => route.pattern ?? '');
}

const REGIONS = ['wrangler.global.jsonc', 'wrangler.eu.jsonc'] as const;

describe('dual-domain deployment', () => {
  it.each(REGIONS)('%s admits both renderer origins', (fileName) => {
    // A desktop build shipped before the rename sends `app://avalon` and cannot
    // be made to send anything else. Removing it rejects every installed client
    // at once, before any route code runs.
    expect(origins(fileName)).toEqual(expect.arrayContaining(['app://rallywithai', 'app://avalon']));
  });

  it('admits every served public-site origin on Global', () => {
    // The site answers on four hostnames; the browser sends whichever one it is
    // on, and an unlisted origin fails as a transport error with no request log.
    expect(origins('wrangler.global.jsonc')).toEqual(expect.arrayContaining([
      'https://rallywith.ai',
      'https://www.rallywith.ai',
      'https://with-avalon.com',
      'https://www.with-avalon.com',
    ]));
  });

  it('keeps every Avalon API and ingress hostname routed alongside its Rally host', () => {
    expect(patterns('wrangler.global.jsonc')).toEqual(expect.arrayContaining([
      'api.rallywith.ai', 'github.rallywith.ai', 'linear.rallywith.ai',
      'notion.rallywith.ai', 'slack.rallywith.ai',
      'api.with-avalon.com', 'github.with-avalon.com', 'linear.with-avalon.com',
      'notion.with-avalon.com', 'slack.with-avalon.com',
    ]));
    expect(patterns('wrangler.eu.jsonc')).toEqual(expect.arrayContaining([
      'eu.api.rallywith.ai',
      'eu.api.with-avalon.com',
    ]));
  });

  it.each(REGIONS)('%s mints only canonical Rally URLs', (fileName) => {
    // The asymmetry the migration rests on: reading is widened, writing is
    // switched. Every var here is a URL handed to somebody else, so a superseded
    // host in one would keep putting the old brand into links, redirects, and
    // registrations — which serving both domains would hide rather than surface.
    const vars = config(fileName).vars ?? {};
    for (const name of [
      'PUBLIC_API_BASE_URL', 'EU_PUBLIC_API_BASE_URL', 'PUBLIC_WEB_BASE_URL',
      'GITHUB_INGRESS_BASE_URL', 'LINEAR_INGRESS_BASE_URL',
      'NOTION_INGRESS_BASE_URL', 'SLACK_INGRESS_BASE_URL',
      'RESEND_FROM_EMAIL', 'RESEND_NOTIFICATION_FROM_EMAIL',
      'WORKSTREAM_EMAIL_DOMAIN', 'DESKTOP_DEEP_LINK_URI',
    ]) {
      const value = vars[name];
      if (value === undefined) continue;
      expect(`${name}=${value}`).not.toContain('with-avalon.com');
      expect(`${name}=${value}`).not.toContain('avalon://');
    }
  });
});
