import { asProjectId, asUserId, asWorkspaceId, ProjectSummarySchema } from "@rally/contracts";
import { describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { ProjectService } from "../src/services/project-service";
import {
  createCloudflareTestBinding,
  createTestD1Database,
  createTestD1PreparedStatement,
  createTestDurableObjectId,
  createTestEnv,
} from "./helpers/cloudflare-test";

const workspaceId = asWorkspaceId("00000000-0000-7000-8000-000000000001");
const userId = asUserId("00000000-0000-7000-8000-000000000002");
const projectId = asProjectId("019d3c99-63cc-7a88-8eb4-bf54b091be06");
const resourceId = "00000000-0000-7000-8000-000000000003";

const project = ProjectSummarySchema.parse({
  id: projectId,
  name: "Brand Refresh",
  iconKey: "palette",
  colorKey: "purple",
  scope: "personal",
  status: "active",
  presentationRevision: 1,
  audienceGeneration: 1,
  lifecycleGeneration: 1,
  participants: [{ userId, state: "active", generation: 1 }],
  defaultResourceIds: [],
  workstreamIds: [],
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:00.000Z",
});

function environment(regionalSql: string[]): Env {
  const stub = {
    listProjects: async () => ({ ok: true, directory: { items: [project], waterline: 1 } }),
    addProjectDefaultResource: async () => ({
      ok: true,
      project: { ...project, defaultResourceIds: [resourceId] },
      targets: [],
    }),
    executeRuntimeSql: async () => ({
      status: 200,
      bodyJson: JSON.stringify({
        results: [{
          columns: ["id", "workspace_id", "connection_id", "resource_type", "provider", "provider_resource_id", "title", "mime_type", "canonical_url", "watch_enabled", "last_hydrated_at", "created_at", "updated_at", "content_ref", "metadata_json"],
          rows: [{
            id: resourceId,
            workspace_id: workspaceId,
            connection_id: null,
            resource_type: "document",
            provider: "avalon",
            provider_resource_id: null,
            title: "Brand guide",
            mime_type: null,
            canonical_url: null,
            watch_enabled: 0,
            last_hydrated_at: null,
            created_at: "2026-08-27T00:00:00.000Z",
            updated_at: "2026-08-27T00:00:00.000Z",
            content_ref: null,
            metadata_json: "{}",
          }],
          changes: 0,
        }],
      }),
    }),
  };
  const namespace = createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
    idFromName: (name: string) => createTestDurableObjectId(name),
    get: () => stub,
  });
  const database = createTestD1Database({
    prepare: (sql: string) => {
      regionalSql.push(sql);
      return createTestD1PreparedStatement({
        bind: () => createTestD1PreparedStatement({
          first: async () => ({ placement_affinity: "wnam" }),
        }),
      });
    },
  });
  return createTestEnv({
    ACTIVITY_QUEUE: createCloudflareTestBinding<Queue>({ sendBatch: vi.fn() }),
    APP_ENV: "test",
    AVALON_REGION: "global",
    DB: database,
    WORKSPACE_DOS: namespace,
  });
}

describe("project default resource audience", () => {
  it("given post-retirement storage, when a readable resource becomes a default, then its audience is checked through WorkspaceDO", async () => {
    const regionalSql: string[] = [];
    const service = new ProjectService(environment(regionalSql), {
      sessionId: "session",
      userId,
      workspaceId,
      region: "global",
      role: "owner",
    });

    const updated = await service.addDefaultResource(projectId, resourceId);

    expect(updated.defaultResourceIds).toEqual([resourceId]);
    expect(regionalSql.some((sql) => /\b(resources|notes|connector_connections)\b/iu.test(sql))).toBe(false);
  });
});
