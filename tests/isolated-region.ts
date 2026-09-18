/** Existing cross-deployment tests use a non-geographical, test-only deployment. */
import { configuredRegions, regionConfiguration, regions } from '../packages/contracts/src/regions';
Object.assign(regions, {
  enterprise: {
    ...regionConfiguration('global'),
    apiUrl: 'https://enterprise.api.with-avalon.com',
    localApiUrl: 'https://enterprise.api.with-avalon.com',
    bindingPrefix: 'ENTERPRISE',
    jurisdiction: 'eu',
    affinities: ['weur', 'eeur'],
    longitudeSplit: 15,
    workerName: 'avalon-api-enterprise',
    artifactSuffix: 'enterprise',
  },
});
if (!configuredRegions.includes('enterprise')) configuredRegions.push('enterprise');
