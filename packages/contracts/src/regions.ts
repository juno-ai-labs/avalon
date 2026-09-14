import { z } from 'zod';
import configuration from '../../../config/regions.json';

/** Deployment identity, independent of geographical placement. */
export const RegionSchema = z.string().regex(/^[a-z][a-z0-9-]*$/u);
export type Region = z.infer<typeof RegionSchema>;
export interface RegionConfiguration {
  workerName: string;
  artifactSuffix: string;
  searchRegion: string;
  apiUrl: string;
  localApiUrl: string;
  bindingPrefix: string;
  jurisdiction: 'us' | 'eu';
  affinities: string[];
  longitudeSplit: number;
}
export const regions: Readonly<Record<Region, RegionConfiguration>> = configuration as Record<Region, RegionConfiguration>;
export const configuredRegions = Object.keys(regions);
export function regionConfiguration(region: Region): RegionConfiguration {
  const configuration = regions[region];
  if (!configuration) throw new Error(`Region is not configured: ${region}`);
  return configuration;
}
export function isConfiguredRegion(value: unknown): value is Region {
  return typeof value === 'string' && Object.hasOwn(regions, value);
}
