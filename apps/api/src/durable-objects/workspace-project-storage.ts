import type { SqlStorageValue } from "@cloudflare/workers-types";

import {
  ProjectDirectorySchema,
  ProjectSummarySchema,
  type ProjectDirectory,
  type ProjectSummary,
} from "@rally/contracts";

import type {
  WorkspaceProjectCreateRequest,
  WorkspaceProjectUpdateRequest,
} from "./workspace-project-protocol";

interface ProjectRow extends Record<string, SqlStorageValue> {
  project_id: string;
  name: string;
  normalized_name: string;
  icon_key: string;
  icon_color_key: string;
  scope: string;
  status: string;
  creator_user_id: string;
  created_at: number;
  updated_at: number;
  presentation_revision: number;
  audience_generation: number;
  lifecycle_generation: number;
}

interface ParticipantRow extends Record<string, SqlStorageValue> {
  project_id: string;
  user_id: string;
  state: string;
  generation: number;
}

export function normalizeProjectName(name: string): string {
  return name.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

/** Synchronous repository for project state owned by one WorkspaceDO. */
export class WorkspaceProjectStorage {
  constructor(private readonly storage: DurableObjectStorage) {}

  create(
    request: WorkspaceProjectCreateRequest,
    projectId: string,
    now = Date.now(),
  ): ProjectSummary | null {
    return this.storage.transactionSync(() => {
      const normalizedName = normalizeProjectName(request.project.name);
      const conflict = this.storage.sql.exec<{ project_id: string } & Record<string, SqlStorageValue>>(
        "SELECT project_id FROM projects WHERE normalized_name = ?",
        normalizedName,
      ).toArray()[0];
      if (conflict) return null;

      this.storage.sql.exec(
        `INSERT INTO projects (
           project_id, name, normalized_name, icon_key, icon_color_key, scope, status,
           creator_user_id, archived_at, archived_by_user_id, created_at, updated_at,
           presentation_revision, audience_generation, lifecycle_generation
         ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, NULL, NULL, ?, ?, 1, 1, 1)`,
        projectId,
        request.project.name.trim(),
        normalizedName,
        request.project.iconKey,
        request.project.colorKey,
        request.project.scope,
        request.userId,
        now,
        now,
      );
      this.storage.sql.exec(
        `INSERT INTO project_participants
           (project_id, user_id, state, generation, created_at, updated_at)
         VALUES (?, ?, 'active', 1, ?, ?)`,
        projectId,
        request.userId,
        now,
        now,
      );
      this.appendOrder(request.userId, projectId, now);
      this.advanceWaterline(now);
      return this.project(projectId);
    });
  }

  list(userId: string, now = Date.now()): ProjectDirectory {
    return this.storage.transactionSync(() => {
      const visible = this.visibleProjectIds(userId);
      for (const projectId of visible) this.appendOrder(userId, projectId, now);
      return this.directory(userId);
    });
  }

  updatePresentation(request: WorkspaceProjectUpdateRequest, now = Date.now()): ProjectSummary | null | false {
    return this.storage.transactionSync(() => {
      if (!this.visibleProjectIds(request.userId).includes(request.projectId)) return false;
      const normalizedName = normalizeProjectName(request.presentation.name);
      const conflict = this.storage.sql.exec<{ project_id: string } & Record<string, SqlStorageValue>>(
        "SELECT project_id FROM projects WHERE normalized_name = ? AND project_id <> ?",
        normalizedName,
        request.projectId,
      ).toArray()[0];
      if (conflict) return null;
      const updated = this.storage.sql.exec<{ project_id: string } & Record<string, SqlStorageValue>>(
        `UPDATE projects
            SET name = ?, normalized_name = ?, icon_key = ?, icon_color_key = ?,
                presentation_revision = presentation_revision + 1, updated_at = ?
          WHERE project_id = ? AND status = 'active'
          RETURNING project_id`,
        request.presentation.name.trim(),
        normalizedName,
        request.presentation.iconKey,
        request.presentation.colorKey,
        now,
        request.projectId,
      ).toArray()[0];
      if (updated) this.advanceWaterline(now);
      return updated ? this.project(updated.project_id) : false;
    });
  }

  reorder(userId: string, requestedIds: readonly string[], now = Date.now()): ProjectDirectory {
    return this.storage.transactionSync(() => {
      const visible = this.visibleProjectIds(userId);
      for (const projectId of visible) this.appendOrder(userId, projectId, now);
      const visibleSet = new Set(visible);
      const current = this.storage.sql.exec<{ project_id: string } & Record<string, SqlStorageValue>>(
        `SELECT project_id FROM workspace_project_order
          WHERE user_id = ? ORDER BY position, project_id`,
        userId,
      ).toArray().map((row) => row.project_id).filter((id) => visibleSet.has(id));
      const requested = [...new Set(requestedIds)].filter((id) => visibleSet.has(id));
      const requestedSet = new Set(requested);
      const ordered = [...requested, ...current.filter((id) => !requestedSet.has(id))];
      for (const [position, projectId] of ordered.entries()) {
        this.storage.sql.exec(
          `UPDATE workspace_project_order SET position = ?, updated_at = ?
            WHERE user_id = ? AND project_id = ?`,
          position,
          now,
          userId,
          projectId,
        );
      }
      this.advanceWaterline(now);
      return this.directory(userId);
    });
  }

  private visibleProjectIds(userId: string): string[] {
    return this.storage.sql.exec<{ project_id: string } & Record<string, SqlStorageValue>>(
      `SELECT project.project_id
         FROM projects project
         LEFT JOIN project_participants participant
           ON participant.project_id = project.project_id
          AND participant.user_id = ? AND participant.state = 'active'
        WHERE project.status = 'active'
          AND (project.scope = 'workspace' OR participant.user_id IS NOT NULL)
        ORDER BY project.created_at, project.project_id`,
      userId,
    ).toArray().map((row) => row.project_id);
  }

  private appendOrder(userId: string, projectId: string, now: number): void {
    this.storage.sql.exec(
      `INSERT OR IGNORE INTO workspace_project_order
         (user_id, project_id, position, created_at, updated_at)
       VALUES (?, ?, COALESCE((SELECT MAX(position) + 1 FROM workspace_project_order
                                WHERE user_id = ?), 0), ?, ?)`,
      userId,
      projectId,
      userId,
      now,
      now,
    );
  }

  private directory(userId: string): ProjectDirectory {
    const rows = this.storage.sql.exec<ProjectRow>(
      `SELECT project.*
         FROM workspace_project_order ordering
         JOIN projects project ON project.project_id = ordering.project_id
         LEFT JOIN project_participants viewer
           ON viewer.project_id = project.project_id
          AND viewer.user_id = ? AND viewer.state = 'active'
        WHERE ordering.user_id = ? AND project.status = 'active'
          AND (project.scope = 'workspace' OR viewer.user_id IS NOT NULL)
        ORDER BY ordering.position, project.project_id`,
      userId,
      userId,
    ).toArray();
    return ProjectDirectorySchema.parse({
      waterline: this.storage.sql.exec<{ waterline: number } & Record<string, SqlStorageValue>>(
        "SELECT waterline FROM workspace_project_state WHERE id = 1",
      ).one().waterline,
      items: rows.map((row) => this.summary(row)),
    });
  }

  private project(projectId: string): ProjectSummary {
    const row = this.storage.sql.exec<ProjectRow>(
      "SELECT * FROM projects WHERE project_id = ?",
      projectId,
    ).one();
    return this.summary(row);
  }

  private summary(row: ProjectRow): ProjectSummary {
    const participants = this.storage.sql.exec<ParticipantRow>(
      `SELECT project_id, user_id, state, generation FROM project_participants
        WHERE project_id = ? AND state <> 'removed' ORDER BY user_id`,
      row.project_id,
    ).toArray();
    return ProjectSummarySchema.parse({
      id: row.project_id,
      name: row.name,
      iconKey: row.icon_key,
      colorKey: row.icon_color_key,
      scope: row.scope,
      status: row.status,
      presentationRevision: row.presentation_revision,
      audienceGeneration: row.audience_generation,
      lifecycleGeneration: row.lifecycle_generation,
      participants: participants.map((participant) => ({
        userId: participant.user_id,
        state: participant.state,
        generation: participant.generation,
      })),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    });
  }

  private advanceWaterline(now: number): void {
    this.storage.sql.exec(
      `UPDATE workspace_project_state SET waterline = waterline + 1, updated_at = ? WHERE id = 1`,
      now,
    );
  }
}
