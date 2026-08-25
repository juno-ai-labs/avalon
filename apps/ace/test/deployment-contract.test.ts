import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const aceDirectory = fileURLToPath(new URL('..', import.meta.url));
const repositoryDirectory = fileURLToPath(new URL('../../..', import.meta.url));

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
    expect(workflow).toContain('apps/migration-tracker/src/access.ts');
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
