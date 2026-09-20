import { configuredRegions, regions } from "./regions.mjs";
export const localAuthorityRegions = configuredRegions;

export function localAuthorityTarget(region) {
  if (!localAuthorityRegions.includes(region)) throw new TypeError("region must be configured");
  return {
    baseUrl: process.env[`PUBLIC_API_BASE_URL_${regions[region].bindingPrefix}`] || regions[region].localApiUrl,
    config: `wrangler.${region}.jsonc`,
    state: `.wrangler/state/${region}`,
  };
}
