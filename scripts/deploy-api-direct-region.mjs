import { configuredRegions } from "./regions.mjs";
import { spawnSync } from 'node:child_process';
import { isEntryPoint } from './entry-point.mjs';

// Shared by the ordinary direct release and the first Ashby Global bootstrap.
// Readers stay ahead of the API writer, just as in versioned promotion.
const configs = Object.fromEntries(configuredRegions.map((region) => [region, [
  `wrangler.artifacts.${region}.jsonc`, `wrangler.documents.${region}.jsonc`, `wrangler.terminal.${region}.jsonc`,
  ...(region === 'global' ? ['wrangler.telemetry.global.jsonc', 'wrangler.pricing.global.jsonc'] : []),
  `.wrangler.lakehouses.${region}.json`,
]]));

export function deployDirectRegion(region, sha, run = spawnSync) {
  if (!Object.hasOwn(configs, region) || !sha) throw new Error('A configured region and verified deployment SHA are required');
  for (const config of configs[region]) {
    const result = run('pnpm', ['--filter', '@rally/api', 'exec', 'wrangler', 'deploy',
      '--config', config, '--tag', sha, '--message', `Verified GitHub deployment ${sha}`], { stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error(`Deployment failed for ${config}`);
  }
}

if (isEntryPoint(import.meta.url)) {
  try {
    deployDirectRegion(process.argv[2], process.env.DEPLOY_SHA);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
