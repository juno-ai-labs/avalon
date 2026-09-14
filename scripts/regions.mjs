import regions from '../config/regions.json' with { type: 'json' };
export { regions };
export const configuredRegions = Object.keys(regions);
