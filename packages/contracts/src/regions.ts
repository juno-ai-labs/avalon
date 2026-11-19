import { z } from 'zod';
import configuration from '../../../config/regions.json';
import { deferredZodSchema } from "./deferred-zod-schema";

/** Deployment identity, independent of geographical placement. */
export const RegionSchema = deferredZodSchema(() => z.string().regex(/^[a-z][a-z0-9-]*$/u));
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

/**
 * The deployment that holds sign-in, the platform identity and cross-region
 * discovery. Every other deployment is reached through it.
 */
export const IDENTITY_REGION = 'global';

/** Requests that act on a deployment must name one this build can reach. */
export const ConfiguredRegionSchema = RegionSchema.refine(isConfiguredRegion, 'Region is not configured');
