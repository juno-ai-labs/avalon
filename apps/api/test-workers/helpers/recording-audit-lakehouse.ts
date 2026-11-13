import type { Pipeline } from "cloudflare:pipelines";

/**
 * Stands in for the engineering MCP's audit Pipeline, which cannot run here:
 * a stream only exists in Cloudflare's account. It keeps every row it is sent,
 * in order, and is one module-level instance so the MCP handler and the
 * EngineeringTaskDO it creates (same isolate) record into the same list.
 */
export const recordedAuditRows: Record<string, unknown>[] = [];

export const recordingAuditLakehouse: Pipeline = {
  async send(records) {
    recordedAuditRows.push(...records);
  },
};
