import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const aceDirectory = fileURLToPath(new URL('..', import.meta.url));
const repositoryDirectory = fileURLToPath(new URL('../../..', import.meta.url));

function pushPaths(workflow: string): string[] {
  const section = workflow.match(/^ {4}paths:\n([\s\S]*?)^ {2}workflow_dispatch:/mu)?.[1];
  if (!section) throw new Error('Ace deployment workflow has no push path filter');
  return section.split('\n')
    .filter((line) => /^\s+-\s+".+"$/u.test(line))
    .map((line) => line.replace(/^\s*-\s+"?|"?$/gu, ''));
}

describe('Ace deployment contract', () => {
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
    expect(pushPaths(workflow)).toEqual([
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
  });

  it('provisions the Access application and every enabled-named flag', async () => {
    const deploy = await readFile(`${aceDirectory}/scripts/deploy.mjs`, 'utf8');

    expect(deploy).toContain("const migrationDomain = 'migrations.internal.rallywith.ai'");
    expect(deploy).toContain("const aceDomain = 'ace.internal.rallywith.ai'");
    expect(deploy).toContain("ensureFlag('hypersight-enabled'");
    expect(deploy).toContain("ensureFlag('meeting-recording-enabled'");
    expect(deploy).toContain("ensureFlag('suggested-work-enabled'");
    expect(deploy).toContain("ensureFlag('automation-workspace-templates-enabled'");
    expect(deploy).toContain('variations: { off: false, on: true }');
  });
});
