import { regionConfiguration, type Region } from '@rally/contracts/regions';
import type { Env } from '../env';

export function regionalBindings(env: Env, region: Region) {
  const prefix = regionConfiguration(region).bindingPrefix;
  return {
    identity: env[`REGION_${prefix}_IDENTITY_BRIDGE`],
    github: env[`REGION_${prefix}_GITHUB_BRIDGE`],
    inboundEmail: env[`REGION_${prefix}_INBOUND_EMAIL_BRIDGE`],
    linear: env[`REGION_${prefix}_LINEAR_BRIDGE`],
    notion: env[`REGION_${prefix}_NOTION_BRIDGE`],
    slack: env[`REGION_${prefix}_SLACK_BRIDGE`],
    telemetry: env[`REGION_${prefix}_TELEMETRY_BRIDGE`],
  };
}
