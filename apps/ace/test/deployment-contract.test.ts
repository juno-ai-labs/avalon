import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MANAGED_FLAGS } from '../src/protocol';

const aceDirectory = fileURLToPath(new URL('..', import.meta.url));
const repositoryDirectory = fileURLToPath(new URL('../../..', import.meta.url));

function pushPaths(workflow: string): string[] {
  const section = workflow.match(/^ {4}paths:\n([\s\S]*?)(?=^ {2}\S)/mu)?.[1];
  if (!section) throw new Error('Ace deployment workflow has no push path filter');
  return section.split('\n').flatMap((line) => {
    if (!/^ {6}-\s+/u.test(line)) return [];
    const path = line.match(/^ {6}- "([^"]+)"$/u)?.[1];
    if (!path) throw new Error(`Ace deployment path must be one double-quoted YAML scalar: ${line.trim()}`);
    return [path];
  });
}

// GitHub applies matching patterns in order, so a later negative pattern
// removes a path admitted by an earlier positive one. These are the only glob
// shapes in Ace's pinned list.
function matchesPushFilter(patterns: string[], path: string): boolean {
  let included = false;
  for (const pattern of patterns) {
    const negative = pattern.startsWith('!');
    const glob = negative ? pattern.slice(1) : pattern;
    const testSuffix = '**/*.test.ts';
    const matches = glob.endsWith(testSuffix)
      ? path.startsWith(glob.slice(0, -testSuffix.length)) && path.endsWith('.test.ts')
      : glob.endsWith('/**')
        ? path.startsWith(glob.slice(0, -2))
        : path === glob;
    if (matches) included = !negative;
  }
  return included;
}

describe('Ace deployment contract', () => {
  it.each([
    '      - docs/**',
    '      - "docs/**" # documentation',
  ])('rejects a path entry that the exact contract cannot parse: %s', (entry) => {
    expect(() => pushPaths(`on:\n  push:\n    paths:\n      - "apps/ace/**"\n${entry}\n  workflow_dispatch:\n`))
      .toThrow('Ace deployment path');
  });

  it('deploys on merges to main with separate deployment and Flagship credentials', async () => {
    const workflow = await readFile(`${repositoryDirectory}/.github/workflows/deploy-ace.yml`, 'utf8');

    expect(workflow).toContain('branches: [main]');
    expect(workflow).toContain('pnpm --filter @rally/ace run deploy');
    expect(workflow).toContain(
      "curl --silent --show-error --output /dev/null --write-out '%{http_code}' https://ace.internal.rallywith.ai/ || true",
    );
    expect(workflow).toContain('secrets.CLOUDFLARE_API_TOKEN');
    expect(workflow).toContain('secrets.ACE_FLAGSHIP_API_TOKEN');
    expect(workflow).toContain('https://ace.internal.rallywith.ai/');
  });

  it('deploys only for runtime and deployment-time inputs', async () => {
    const workflow = await readFile(`${repositoryDirectory}/.github/workflows/deploy-ace.yml`, 'utf8');
    const paths = pushPaths(workflow);

    expect(paths).toEqual([
      'apps/ace/**',
      '!apps/ace/test/**',
      'apps/migration-tracker/src/access.ts',
      'packages/contracts/**',
      '!packages/contracts/src/**/*.test.ts',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'tsconfig.base.json',
      'scripts/ensure-cloudflare-queues.mjs',
      'scripts/entry-point.mjs',
      'scripts/wrangler-config.mjs',
      '.github/workflows/deploy-ace.yml',
    ]);

    for (const path of [
      'apps/ace/src/index.ts',
      'apps/ace/package.json',
      'apps/migration-tracker/src/access.ts',
      'packages/contracts/src/index.ts',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'tsconfig.base.json',
      'scripts/ensure-cloudflare-queues.mjs',
      'scripts/entry-point.mjs',
      'scripts/wrangler-config.mjs',
      '.github/workflows/deploy-ace.yml',
    ]) {
      expect(matchesPushFilter(paths, path), `${path} changes the Ace release`).toBe(true);
    }

    for (const path of [
      'apps/ace/test/app.test.ts',
      'packages/contracts/src/index.test.ts',
      'scripts/ensure-cloudflare-queues.test.mjs',
      'apps/api/src/index.ts',
      'docs/ace.md',
    ]) {
      expect(matchesPushFilter(paths, path), `${path} must stay CI-only`).toBe(false);
    }
  });

  it('provisions Access and flags, then validates the runtime Queue permission', async () => {
    const deploy = await readFile(`${aceDirectory}/scripts/deploy.mjs`, 'utf8');

    expect(deploy).toContain("const migrationDomain = 'migrations.internal.rallywith.ai'");
    expect(deploy).toContain("const aceDomain = 'ace.internal.rallywith.ai'");
    expect(deploy).toContain("ensureFlag('hypersight-enabled'");
    expect(deploy).toContain("ensureFlag('meeting-recording-enabled'");
    expect(deploy).toContain("ensureFlag('suggested-work-enabled'");
    expect(deploy).toContain("ensureFlag('automation-workspace-templates-enabled'");
    expect(deploy).toContain('variations: { off: false, on: true }');
    expect(deploy).toContain('await verifyRuntimeQueuePermissions({ accountId, token: aceRuntimeToken })');
  });

  it("provisions every managed flag with the default variation its own catalog entry declares", async () => {
    const deploy = await readFile(`${aceDirectory}/scripts/deploy.mjs`, 'utf8');

    // `deploy.mjs` runs under plain Node, not through Vite, so it cannot
    // import `MANAGED_FLAGS` and read it at runtime the way this test can —
    // `ensureFlag`'s third argument is the only place the fact lives at
    // deploy time. Asserting against the catalog, one flag at a time, is what
    // stops the two from silently disagreeing: `digests-enabled` defaults on
    // precisely because a digest already sends by default for every existing
    // person, and `ensureFlag`'s own default is 'off' for everything else, so
    // a call site that drifted from its catalog entry would provision the
    // wrong default rather than merely fail a targeted regex.
    for (const flag of MANAGED_FLAGS) {
      const call = deploy.match(new RegExp(`ensureFlag\\('${flag.key}'[\\s\\S]*?\\)(?=[,;\\n])`, 'u'))?.[0];
      expect(call, `no ensureFlag('${flag.key}', ...) call found in deploy.mjs`).toBeDefined();
      const servesOn = /,\s*'on'\)$/u.test(call!);
      expect(servesOn ? 'on' : 'off', `${flag.key} provisions '${servesOn ? 'on' : 'off'}' but its MANAGED_FLAGS entry declares '${flag.defaultVariation}'`)
        .toBe(flag.defaultVariation);
    }
  });

  it("provisions every managed flag with the description its own catalog entry declares", async () => {
    const deploy = await readFile(`${aceDirectory}/scripts/deploy.mjs`, 'utf8');

    // Same reason as the variation check above: `deploy.mjs` is the only place
    // this string is live at deploy time, so nothing stops it from drifting
    // from the catalog's copy except reading both back and comparing them.
    // The capture assumes no apostrophe inside the quoted description — true
    // of every description today — because that would close the quote early.
    for (const flag of MANAGED_FLAGS) {
      const call = deploy.match(new RegExp(`ensureFlag\\('${flag.key}',\\s*'([^']*)'`, 'u'));
      expect(call, `no ensureFlag('${flag.key}', ...) call found in deploy.mjs`).not.toBeNull();
      expect(call![1], `${flag.key}'s deploy.mjs description drifted from its MANAGED_FLAGS entry`).toBe(flag.description);
    }
  });
});
