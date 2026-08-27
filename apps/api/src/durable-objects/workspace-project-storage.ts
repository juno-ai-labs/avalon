import type { SqlStorageValue } from "@cloudflare/workers-types";

import {
  ProjectDirectorySchema,
  ProjectSummarySchema,
  asWorkstreamId,
  asProjectId,
  type ProjectDirectory,
  type ProjectSummary,
} from "@rally/contracts";

import type {
  WorkspaceProjectCreateRequest,
  WorkspaceProjectAudienceRequest,
  WorkspaceProjectDefaultResourceRequest,
  WorkspaceProjectDefaultResult,
  WorkspaceProjectDefaultTarget,
  WorkspaceProjectMembershipPlanResult,
  WorkspaceProjectMembershipPrepareRequest,
  WorkspaceProjectMembershipSettleRequest,
  WorkspaceProjectLifecycleRequest,
  WorkspaceProjectUpdateRequest,
} from "./workspace-project-protocol";

export interface WorkspaceProjectDefaultPublication extends WorkspaceProjectDefaultTarget {
  requestedByUserId: string;
  attempts: number;
}

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
  ): ProjectSummary {
    return this.storage.transactionSync(() => {
      const previousCreatedAt = this.storage.sql.exec<{
        created_at: number | null;
      } & Record<string, SqlStorageValue>>(
        "SELECT MAX(created_at) AS created_at FROM projects",
      ).one().created_at;
      const createdAt = Math.max(now, (previousCreatedAt ?? -1) + 1);
      const normalizedName = normalizeProjectName(request.project.name);
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
        createdAt,
        createdAt,
      );
      this.storage.sql.exec(
        `INSERT INTO project_participants
           (project_id, user_id, state, generation, created_at, updated_at)
         VALUES (?, ?, 'active', 1, ?, ?)`,
        projectId,
        request.userId,
        createdAt,
        createdAt,
      );
      this.appendOrder(request.userId, projectId, createdAt);
      this.advanceWaterline(createdAt);
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

  updatePresentation(request: WorkspaceProjectUpdateRequest, now = Date.now()): ProjectSummary | false {
    return this.storage.transactionSync(() => {
      if (!this.visibleProjectIds(request.userId).includes(request.projectId)
        && !this.listInactive(request.userId).items.some((project) => project.id === request.projectId)) return false;
      const normalizedName = normalizeProjectName(request.presentation.name);
      const updated = this.storage.sql.exec<{ project_id: string } & Record<string, SqlStorageValue>>(
        `UPDATE projects
            SET name = ?, normalized_name = ?, icon_key = ?, icon_color_key = ?,
                presentation_revision = presentation_revision + 1, updated_at = ?
          WHERE project_id = ? AND status IN ('active', 'archived')
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

  updateAudience(request: WorkspaceProjectAudienceRequest, now = Date.now()): ProjectSummary | false {
    return this.storage.transactionSync(() => {
      if (!this.visibleProjectIds(request.userId).includes(request.projectId)) return false;
      const requested = new Set(request.audience.participantUserIds);
      const current = this.storage.sql.exec<ParticipantRow>(
        "SELECT project_id, user_id, state, generation FROM project_participants WHERE project_id = ?",
        request.projectId,
      ).toArray();
      for (const participant of current) {
        const active = requested.has(participant.user_id);
        this.storage.sql.exec(
          `UPDATE project_participants SET state = ?, generation = generation + 1,
               updated_at = ? WHERE project_id = ? AND user_id = ?`,
          active ? "active" : "removed",
          now,
          request.projectId,
          participant.user_id,
        );
        requested.delete(participant.user_id);
      }
      for (const userId of requested) {
        this.storage.sql.exec(
          `INSERT INTO project_participants
             (project_id, user_id, state, generation, created_at, updated_at)
           VALUES (?, ?, 'active', 1, ?, ?)`,
          request.projectId,
          userId,
          now,
          now,
        );
      }
      const updated = this.storage.sql.exec<{ project_id: string } & Record<string, SqlStorageValue>>(
        `UPDATE projects SET scope = ?, audience_generation = audience_generation + 1,
             updated_at = ? WHERE project_id = ? AND status = 'active' RETURNING project_id`,
        request.audience.scope,
        now,
        request.projectId,
      ).toArray()[0];
      if (!updated) return false;
      this.advanceWaterline(now);
      return this.project(request.projectId);
    });
  }

  prepareMembership(
    request: WorkspaceProjectMembershipPrepareRequest,
    now = Date.now(),
  ): WorkspaceProjectMembershipPlanResult {
    return this.storage.transactionSync(() => {
      if (!this.visibleProjectIds(request.userId).includes(request.projectId)) {
        return { ok: false, code: "project_not_found" };
      }
      const existing = this.storage.sql.exec<{
        state: string;
        generation: number;
      } & Record<string, SqlStorageValue>>(
        `SELECT state, generation FROM project_workstream_memberships
          WHERE project_id = ? AND workstream_id = ?`,
        request.projectId,
        request.workstreamId,
      ).toArray()[0];
      if (existing?.state === "active") {
        return {
          ok: true,
          project: this.project(request.projectId),
          sourceProjectId: null,
          sourceDetached: false,
          membershipGeneration: existing.generation,
        };
      }

      const source = this.storage.sql.exec<{
        project_id: string;
        scope: "personal" | "workspace";
      } & Record<string, SqlStorageValue>>(
        `SELECT membership.project_id, project.scope
           FROM project_workstream_memberships membership
           JOIN projects project ON project.project_id = membership.project_id
          WHERE membership.workstream_id = ? AND membership.state = 'active'
            AND project.status = 'active'
            AND membership.project_id <> ?
          ORDER BY membership.project_id LIMIT 1`,
        request.workstreamId,
        request.projectId,
      ).toArray()[0];
      const sourceDetached = source
        ? !this.projectAudienceContains(source.project_id, request.projectId)
        : false;
      if (source && sourceDetached) {
        this.storage.sql.exec(
          `UPDATE project_workstream_memberships
              SET state = 'removed', generation = generation + 1,
                  updated_at = ?, removed_at = ?
            WHERE project_id = ? AND workstream_id = ? AND state = 'active'`,
          now,
          now,
          source.project_id,
          request.workstreamId,
        );
      }
      let membershipGeneration: number;
      if (existing) {
        membershipGeneration = existing.generation + 1;
        this.storage.sql.exec(
          `UPDATE project_workstream_memberships
              SET state = 'joining', generation = ?, joined_at = ?, updated_at = ?, removed_at = NULL
            WHERE project_id = ? AND workstream_id = ?`,
          membershipGeneration,
          now,
          now,
          request.projectId,
          request.workstreamId,
        );
      } else {
        membershipGeneration = 1;
        this.storage.sql.exec(
          `INSERT INTO project_workstream_memberships
             (project_id, workstream_id, state, generation, joined_at, updated_at, removed_at)
           VALUES (?, ?, 'joining', 1, ?, ?, NULL)`,
          request.projectId,
          request.workstreamId,
          now,
          now,
        );
      }
      this.advanceWaterline(now);
      return {
        ok: true,
        project: this.project(request.projectId),
        sourceProjectId: source ? asProjectId(source.project_id) : null,
        sourceDetached,
        membershipGeneration,
      };
    });
  }

  finalizeMembership(request: WorkspaceProjectMembershipSettleRequest, now = Date.now()): ProjectSummary | false {
    return this.storage.transactionSync(() => {
      const activated = this.storage.sql.exec<{ project_id: string } & Record<string, SqlStorageValue>>(
        `UPDATE project_workstream_memberships
            SET state = 'active', updated_at = ?, removed_at = NULL
          WHERE project_id = ? AND workstream_id = ? AND state = 'joining' AND generation = ?
          RETURNING project_id`,
        now,
        request.projectId,
        request.workstreamId,
        request.membershipGeneration,
      ).toArray()[0];
      if (!activated) return false;
      if (request.sourceProjectId && !request.sourceDetached) {
        this.storage.sql.exec(
          `UPDATE project_workstream_memberships
              SET state = 'removed', generation = generation + 1,
                  updated_at = ?, removed_at = ?
            WHERE project_id = ? AND workstream_id = ? AND state = 'active'`,
          now,
          now,
          request.sourceProjectId,
          request.workstreamId,
        );
      }
      this.advanceWaterline(now);
      return this.project(request.projectId);
    });
  }

  cancelMembership(request: WorkspaceProjectMembershipSettleRequest, now = Date.now()): ProjectSummary | false {
    return this.storage.transactionSync(() => {
      const cancelled = this.storage.sql.exec<{ project_id: string } & Record<string, SqlStorageValue>>(
        `UPDATE project_workstream_memberships
            SET state = 'removed', updated_at = ?, removed_at = ?
          WHERE project_id = ? AND workstream_id = ? AND state = 'joining' AND generation = ?
          RETURNING project_id`,
        now,
        now,
        request.projectId,
        request.workstreamId,
        request.membershipGeneration,
      ).toArray()[0];
      if (!cancelled) return false;
      this.advanceWaterline(now);
      return this.project(request.projectId);
    });
  }

  removeMembership(userId: string, projectId: string, workstreamId: string, now = Date.now()): ProjectSummary | false {
    return this.storage.transactionSync(() => {
      if (!this.visibleProjectIds(userId).includes(projectId)
        && !this.listInactive(userId).items.some((project) => project.id === projectId)) return false;
      const removed = this.storage.sql.exec<{ project_id: string } & Record<string, SqlStorageValue>>(
        `UPDATE project_workstream_memberships
            SET state = 'removed', generation = generation + 1,
                updated_at = ?, removed_at = ?
          WHERE project_id = ? AND workstream_id = ? AND state IN ('joining', 'active')
          RETURNING project_id`,
        now,
        now,
        projectId,
        workstreamId,
      ).toArray()[0];
      if (!removed) return false;
      this.advanceWaterline(now);
      return this.project(projectId);
    });
  }

  workstreamConstraints(workstreamId: string): { activeProject: boolean; requiresWorkspaceScope: boolean } {
    const rows = this.storage.sql.exec<{ scope: string } & Record<string, SqlStorageValue>>(
      `SELECT project.scope FROM project_workstream_memberships membership
         JOIN projects project ON project.project_id = membership.project_id
        WHERE membership.workstream_id = ? AND membership.state IN ('joining', 'active')
          AND project.status = 'active'`,
      workstreamId,
    ).toArray();
    return {
      activeProject: rows.length > 0,
      requiresWorkspaceScope: rows.some((row) => row.scope === "workspace"),
    };
  }

  addDefaultResource(
    request: WorkspaceProjectDefaultResourceRequest,
    now = Date.now(),
  ): WorkspaceProjectDefaultResult {
    return this.storage.transactionSync(() => {
      if (!this.visibleProjectIds(request.userId).includes(request.projectId)) {
        return { ok: false, code: "project_not_found" };
      }
      const existing = this.storage.sql.exec<{
        state: string;
        generation: number;
      } & Record<string, SqlStorageValue>>(
        `SELECT state, generation FROM project_default_resources
          WHERE project_id = ? AND resource_id = ?`,
        request.projectId,
        request.resourceId,
      ).toArray()[0];
      if (existing?.state === "active") {
        const targets = this.storage.sql.exec<{
          default_generation: number;
          workstream_id: string;
          membership_generation: number;
        } & Record<string, SqlStorageValue>>(
          `SELECT default_generation, workstream_id, membership_generation
             FROM project_default_resource_targets
            WHERE project_id = ? AND resource_id = ? AND default_generation = ?
              AND state = 'pending' ORDER BY workstream_id`,
          request.projectId,
          request.resourceId,
          existing.generation,
        ).toArray().map((target) => ({
          projectId: request.projectId,
          resourceId: request.resourceId,
          defaultGeneration: target.default_generation,
          workstreamId: asWorkstreamId(target.workstream_id),
          membershipGeneration: target.membership_generation,
        }));
        this.stageDefaultPublications(targets, request.userId, now);
        return { ok: true, project: this.project(request.projectId), targets };
      }
      const defaultGeneration = (existing?.generation ?? 0) + 1;
      if (existing) {
        this.storage.sql.exec(
          `UPDATE project_default_resources
              SET state = 'active', generation = ?, updated_at = ?, removed_at = NULL
            WHERE project_id = ? AND resource_id = ?`,
          defaultGeneration,
          now,
          request.projectId,
          request.resourceId,
        );
      } else {
        this.storage.sql.exec(
          `INSERT INTO project_default_resources
             (project_id, resource_id, state, generation, created_at, updated_at, removed_at)
           VALUES (?, ?, 'active', 1, ?, ?, NULL)`,
          request.projectId,
          request.resourceId,
          now,
          now,
        );
      }
      const memberships = this.storage.sql.exec<{
        workstream_id: string;
        generation: number;
      } & Record<string, SqlStorageValue>>(
        `SELECT workstream_id, generation FROM project_workstream_memberships
          WHERE project_id = ? AND state = 'active' ORDER BY workstream_id`,
        request.projectId,
      ).toArray();
      const targets: WorkspaceProjectDefaultTarget[] = memberships.map((membership) => ({
        projectId: request.projectId,
        resourceId: request.resourceId,
        defaultGeneration,
        workstreamId: asWorkstreamId(membership.workstream_id),
        membershipGeneration: membership.generation,
      }));
      for (const target of targets) {
        this.storage.sql.exec(
          `INSERT INTO project_default_resource_targets
             (project_id, resource_id, default_generation, workstream_id,
              membership_generation, state, attempts, created_at, updated_at,
              applied_at, last_error_code)
           VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, NULL, NULL)`,
          target.projectId,
          target.resourceId,
          target.defaultGeneration,
          target.workstreamId,
          target.membershipGeneration,
          now,
          now,
        );
      }
      this.stageDefaultPublications(targets, request.userId, now);
      this.advanceWaterline(now);
      return { ok: true, project: this.project(request.projectId), targets };
    });
  }

  removeDefaultResource(
    request: WorkspaceProjectDefaultResourceRequest,
    now = Date.now(),
  ): ProjectSummary | false {
    return this.storage.transactionSync(() => {
      if (!this.visibleProjectIds(request.userId).includes(request.projectId)) return false;
      const removed = this.storage.sql.exec<{ resource_id: string } & Record<string, SqlStorageValue>>(
        `UPDATE project_default_resources
            SET state = 'removed', generation = generation + 1, updated_at = ?, removed_at = ?
          WHERE project_id = ? AND resource_id = ? AND state = 'active'
          RETURNING resource_id`,
        now,
        now,
        request.projectId,
        request.resourceId,
      ).toArray()[0];
      if (!removed) return false;
      this.advanceWaterline(now);
      return this.project(request.projectId);
    });
  }

  defaultTargetCurrent(target: WorkspaceProjectDefaultTarget): boolean {
    return this.storage.sql.exec<{ one: number } & Record<string, SqlStorageValue>>(
      `SELECT 1 AS one
         FROM project_default_resource_targets target
         JOIN project_default_resources resource
           ON resource.project_id = target.project_id AND resource.resource_id = target.resource_id
         JOIN project_workstream_memberships membership
           ON membership.project_id = target.project_id AND membership.workstream_id = target.workstream_id
         JOIN projects project ON project.project_id = target.project_id
        WHERE target.project_id = ? AND target.resource_id = ? AND target.default_generation = ?
          AND target.workstream_id = ? AND target.membership_generation = ?
          AND target.state = 'pending' AND resource.state = 'active' AND project.status = 'active'
          AND resource.generation = target.default_generation
          AND membership.state = 'active' AND membership.generation = target.membership_generation`,
      target.projectId,
      target.resourceId,
      target.defaultGeneration,
      target.workstreamId,
      target.membershipGeneration,
    ).toArray().length === 1;
  }

  defaultTargetActors(target: WorkspaceProjectDefaultTarget): string[] {
    if (!this.defaultTargetCurrent(target)) return [];
    return this.storage.sql.exec<{ user_id: string } & Record<string, SqlStorageValue>>(
      `SELECT user_id FROM project_participants
        WHERE project_id = ? AND state = 'active' ORDER BY user_id`,
      target.projectId,
    ).toArray().map((row) => row.user_id);
  }

  completeDefaultTarget(target: WorkspaceProjectDefaultTarget, now = Date.now()): boolean {
    return this.storage.transactionSync(() => {
      if (!this.defaultTargetCurrent(target)) return false;
      return this.storage.sql.exec<{ workstream_id: string } & Record<string, SqlStorageValue>>(
        `UPDATE project_default_resource_targets
            SET state = 'applied', attempts = attempts + 1, updated_at = ?, applied_at = ?
          WHERE project_id = ? AND resource_id = ? AND default_generation = ?
            AND workstream_id = ? AND membership_generation = ? AND state = 'pending'
          RETURNING workstream_id`,
        now,
        now,
        target.projectId,
        target.resourceId,
        target.defaultGeneration,
        target.workstreamId,
        target.membershipGeneration,
      ).toArray().length === 1;
    });
  }

  recordDefaultTargetFailure(
    target: WorkspaceProjectDefaultTarget,
    errorCode: string,
    now = Date.now(),
  ): boolean {
    return this.storage.sql.exec<{ workstream_id: string } & Record<string, SqlStorageValue>>(
      `UPDATE project_default_resource_targets
          SET attempts = attempts + 1, updated_at = ?, last_error_code = ?
        WHERE project_id = ? AND resource_id = ? AND default_generation = ?
          AND workstream_id = ? AND membership_generation = ? AND state = 'pending'
        RETURNING workstream_id`,
      now,
      errorCode,
      target.projectId,
      target.resourceId,
      target.defaultGeneration,
      target.workstreamId,
      target.membershipGeneration,
    ).toArray().length === 1;
  }

  failDefaultTarget(
    target: WorkspaceProjectDefaultTarget,
    errorCode: string,
    now = Date.now(),
  ): boolean {
    return this.storage.sql.exec<{ workstream_id: string } & Record<string, SqlStorageValue>>(
      `UPDATE project_default_resource_targets
          SET state = 'terminal', attempts = attempts + 1, updated_at = ?, last_error_code = ?
        WHERE project_id = ? AND resource_id = ? AND default_generation = ?
          AND workstream_id = ? AND membership_generation = ? AND state = 'pending'
        RETURNING workstream_id`,
      now,
      errorCode,
      target.projectId,
      target.resourceId,
      target.defaultGeneration,
      target.workstreamId,
      target.membershipGeneration,
    ).toArray().length === 1;
  }

  nextDefaultPublicationDueAt(): number | null {
    return this.storage.sql.exec<{ due_at: number | null } & Record<string, SqlStorageValue>>(
      `SELECT MIN(publication.next_attempt_at) AS due_at
         FROM project_default_resource_publications publication
         JOIN project_default_resource_targets target
           ON target.project_id = publication.project_id
          AND target.resource_id = publication.resource_id
          AND target.default_generation = publication.default_generation
          AND target.workstream_id = publication.workstream_id
          AND target.membership_generation = publication.membership_generation
        WHERE publication.state = 'pending' AND target.state = 'pending'`,
    ).one().due_at;
  }

  claimDefaultPublications(
    now: number,
    retryAt: (attempt: number) => number,
  ): WorkspaceProjectDefaultPublication[] {
    return this.storage.transactionSync(() => {
      const rows = this.storage.sql.exec<{
        project_id: string;
        resource_id: string;
        default_generation: number;
        workstream_id: string;
        membership_generation: number;
        requested_by_user_id: string;
        attempts: number;
      } & Record<string, SqlStorageValue>>(
        `SELECT publication.project_id, publication.resource_id,
                publication.default_generation, publication.workstream_id,
                publication.membership_generation, publication.requested_by_user_id,
                publication.attempts
           FROM project_default_resource_publications publication
           JOIN project_default_resource_targets target
             ON target.project_id = publication.project_id
            AND target.resource_id = publication.resource_id
            AND target.default_generation = publication.default_generation
            AND target.workstream_id = publication.workstream_id
            AND target.membership_generation = publication.membership_generation
          WHERE publication.state = 'pending' AND publication.next_attempt_at <= ?
            AND target.state = 'pending'
          ORDER BY publication.next_attempt_at, publication.project_id,
                   publication.resource_id, publication.workstream_id
          LIMIT 100`,
        now,
      ).toArray();
      for (const row of rows) {
        const attempt = row.attempts + 1;
        this.storage.sql.exec(
          `UPDATE project_default_resource_publications
              SET attempts = ?, next_attempt_at = ?, updated_at = ?
            WHERE project_id = ? AND resource_id = ? AND default_generation = ?
              AND workstream_id = ? AND membership_generation = ? AND state = 'pending'`,
          attempt,
          retryAt(attempt),
          now,
          row.project_id,
          row.resource_id,
          row.default_generation,
          row.workstream_id,
          row.membership_generation,
        );
      }
      return rows.map((row) => ({
        projectId: asProjectId(row.project_id),
        resourceId: row.resource_id,
        defaultGeneration: row.default_generation,
        workstreamId: asWorkstreamId(row.workstream_id),
        membershipGeneration: row.membership_generation,
        requestedByUserId: row.requested_by_user_id,
        attempts: row.attempts + 1,
      }));
    });
  }

  acceptDefaultPublications(
    publications: readonly WorkspaceProjectDefaultPublication[],
    now = Date.now(),
  ): void {
    this.storage.transactionSync(() => {
      for (const publication of publications) {
        this.storage.sql.exec(
          `UPDATE project_default_resource_publications
              SET state = 'accepted', updated_at = ?, accepted_at = ?
            WHERE project_id = ? AND resource_id = ? AND default_generation = ?
              AND workstream_id = ? AND membership_generation = ? AND state = 'pending'`,
          now,
          now,
          publication.projectId,
          publication.resourceId,
          publication.defaultGeneration,
          publication.workstreamId,
          publication.membershipGeneration,
        );
      }
    });
  }

  listInactive(userId: string): ProjectDirectory {
    const rows = this.storage.sql.exec<ProjectRow>(
      `SELECT project.* FROM projects project
         LEFT JOIN project_participants participant
           ON participant.project_id = project.project_id
          AND participant.user_id = ? AND participant.state = 'active'
        WHERE project.status <> 'active'
          AND (project.scope = 'workspace' OR participant.user_id IS NOT NULL)
        ORDER BY project.updated_at DESC, project.project_id`,
      userId,
    ).toArray();
    return ProjectDirectorySchema.parse({
      waterline: this.storage.sql.exec<{ waterline: number } & Record<string, SqlStorageValue>>(
        "SELECT waterline FROM workspace_project_state WHERE id = 1",
      ).one().waterline,
      items: rows.map((row) => this.summary(row)),
    });
  }

  archive(request: WorkspaceProjectLifecycleRequest, now = Date.now()): ProjectSummary | false {
    return this.storage.transactionSync(() => {
      if (!this.visibleProjectIds(request.userId).includes(request.projectId)) return false;
      const archived = this.storage.sql.exec<{ project_id: string } & Record<string, SqlStorageValue>>(
        `UPDATE projects SET status = 'archived', archived_at = ?, archived_by_user_id = ?,
             lifecycle_generation = lifecycle_generation + 1, updated_at = ?
           WHERE project_id = ? AND status = 'active' RETURNING project_id`,
        now,
        request.userId,
        now,
        request.projectId,
      ).toArray()[0];
      if (!archived) return false;
      this.storage.sql.exec(
        `UPDATE project_default_resource_targets SET state = 'terminal', updated_at = ?,
             last_error_code = 'project_archived'
           WHERE project_id = ? AND state = 'pending'`,
        now,
        request.projectId,
      );
      this.advanceWaterline(now);
      return this.project(request.projectId);
    });
  }

  restore(request: WorkspaceProjectLifecycleRequest, now = Date.now()): {
    project: ProjectSummary;
    targets: WorkspaceProjectDefaultTarget[];
  } | "conflict" | false {
    return this.storage.transactionSync(() => {
      const readable = this.listInactive(request.userId).items.some((project) => project.id === request.projectId);
      if (!readable) return false;
      const conflict = this.storage.sql.exec<{ workstream_id: string } & Record<string, SqlStorageValue>>(
        `SELECT retained.workstream_id
           FROM project_workstream_memberships retained
           JOIN project_workstream_memberships other
             ON other.workstream_id = retained.workstream_id
            AND other.project_id <> retained.project_id AND other.state = 'active'
           JOIN projects other_project ON other_project.project_id = other.project_id
          WHERE retained.project_id = ? AND retained.state = 'active'
            AND other_project.status = 'active' LIMIT 1`,
        request.projectId,
      ).toArray()[0];
      if (conflict) return "conflict";
      const project = this.storage.sql.exec<{ scope: "personal" | "workspace" } & Record<string, SqlStorageValue>>(
        "SELECT scope FROM projects WHERE project_id = ?",
        request.projectId,
      ).one();
      const projectParticipants = new Set(this.storage.sql.exec<{ user_id: string } & Record<string, SqlStorageValue>>(
        "SELECT user_id FROM project_participants WHERE project_id = ? AND state = 'active'",
        request.projectId,
      ).toArray().map((participant) => participant.user_id));
      const retainedWorkstreamIds = this.storage.sql.exec<{ workstream_id: string } & Record<string, SqlStorageValue>>(
        "SELECT workstream_id FROM project_workstream_memberships WHERE project_id = ? AND state = 'active'",
        request.projectId,
      ).toArray().map((membership) => membership.workstream_id);
      for (const workstreamId of retainedWorkstreamIds) {
        const directory = this.storage.sql.exec<{ scope: "personal" | "workspace" } & Record<string, SqlStorageValue>>(
          "SELECT scope FROM workspace_workstream_directory WHERE workstream_id = ? AND archived_at IS NULL",
          workstreamId,
        ).toArray()[0];
        if (!directory || directory.scope !== project.scope) return "conflict";
        if (project.scope === "personal") {
          const workstreamParticipants = new Set(this.storage.sql.exec<{ user_id: string } & Record<string, SqlStorageValue>>(
            `SELECT user_id FROM workspace_workstream_viewers
              WHERE workstream_id = ? AND is_participant = 1`,
            workstreamId,
          ).toArray().map((participant) => participant.user_id));
          if (projectParticipants.size !== workstreamParticipants.size
            || [...projectParticipants].some((userId) => !workstreamParticipants.has(userId))) return "conflict";
        }
      }
      const restored = this.storage.sql.exec<{ project_id: string } & Record<string, SqlStorageValue>>(
        `UPDATE projects SET status = 'active', archived_at = NULL, archived_by_user_id = NULL,
             lifecycle_generation = lifecycle_generation + 1, updated_at = ?
           WHERE project_id = ? AND status = 'archived' RETURNING project_id`,
        now,
        request.projectId,
      ).toArray()[0];
      if (!restored) return false;
      const memberships = this.storage.sql.exec<{
        workstream_id: string;
        generation: number;
      } & Record<string, SqlStorageValue>>(
        `SELECT workstream_id, generation FROM project_workstream_memberships
          WHERE project_id = ? AND state = 'active' ORDER BY workstream_id`,
        request.projectId,
      ).toArray();
      const defaults = this.storage.sql.exec<{
        resource_id: string;
        generation: number;
      } & Record<string, SqlStorageValue>>(
        `SELECT resource_id, generation FROM project_default_resources
          WHERE project_id = ? AND state = 'active' ORDER BY resource_id`,
        request.projectId,
      ).toArray();
      const targets: WorkspaceProjectDefaultTarget[] = [];
      for (const resource of defaults) {
        const defaultGeneration = resource.generation + 1;
        this.storage.sql.exec(
          `UPDATE project_default_resources SET generation = ?, updated_at = ?
            WHERE project_id = ? AND resource_id = ?`,
          defaultGeneration,
          now,
          request.projectId,
          resource.resource_id,
        );
        for (const membership of memberships) {
          const target = {
            projectId: request.projectId,
            resourceId: resource.resource_id,
            defaultGeneration,
            workstreamId: asWorkstreamId(membership.workstream_id),
            membershipGeneration: membership.generation,
          };
          targets.push(target);
          this.storage.sql.exec(
            `INSERT INTO project_default_resource_targets
               (project_id, resource_id, default_generation, workstream_id,
                membership_generation, state, attempts, created_at, updated_at,
                applied_at, last_error_code)
             VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, NULL, NULL)`,
            target.projectId,
            target.resourceId,
            target.defaultGeneration,
            target.workstreamId,
            target.membershipGeneration,
            now,
            now,
          );
        }
      }
      this.stageDefaultPublications(targets, request.userId, now);
      this.appendOrder(request.userId, request.projectId, now);
      this.advanceWaterline(now);
      return { project: this.project(request.projectId), targets };
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

  private stageDefaultPublications(
    targets: readonly WorkspaceProjectDefaultTarget[],
    requestedByUserId: string,
    now: number,
  ): void {
    for (const target of targets) {
      this.storage.sql.exec(
        `INSERT OR IGNORE INTO project_default_resource_publications (
           project_id, resource_id, default_generation, workstream_id, membership_generation,
           requested_by_user_id, state, attempts, next_attempt_at, created_at, updated_at, accepted_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, NULL)`,
        target.projectId,
        target.resourceId,
        target.defaultGeneration,
        target.workstreamId,
        target.membershipGeneration,
        requestedByUserId,
        now,
        now,
        now,
      );
    }
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
      workstreamIds: this.storage.sql.exec<{ workstream_id: string } & Record<string, SqlStorageValue>>(
        `SELECT workstream_id FROM project_workstream_memberships
          WHERE project_id = ? AND state = 'active' ORDER BY workstream_id`,
        row.project_id,
      ).toArray().map((membership) => membership.workstream_id),
      defaultResourceIds: this.storage.sql.exec<{ resource_id: string } & Record<string, SqlStorageValue>>(
        `SELECT resource_id FROM project_default_resources
          WHERE project_id = ? AND state = 'active' ORDER BY resource_id`,
        row.project_id,
      ).toArray().map((resource) => resource.resource_id),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    });
  }

  private projectAudienceContains(sourceProjectId: string, targetProjectId: string): boolean {
    const scopes = this.storage.sql.exec<{
      project_id: string;
      scope: "personal" | "workspace";
    } & Record<string, SqlStorageValue>>(
      "SELECT project_id, scope FROM projects WHERE project_id IN (?, ?)",
      sourceProjectId,
      targetProjectId,
    ).toArray();
    const sourceScope = scopes.find((row) => row.project_id === sourceProjectId)?.scope;
    const targetScope = scopes.find((row) => row.project_id === targetProjectId)?.scope;
    if (sourceScope === "workspace") return true;
    if (sourceScope !== "personal" || targetScope !== "personal") return false;
    const participants = (projectId: string): Set<string> => new Set(
      this.storage.sql.exec<{ user_id: string } & Record<string, SqlStorageValue>>(
        `SELECT user_id FROM project_participants
          WHERE project_id = ? AND state = 'active'`,
        projectId,
      ).toArray().map((row) => row.user_id),
    );
    const sourceParticipants = participants(sourceProjectId);
    return [...participants(targetProjectId)].every((userId) => sourceParticipants.has(userId));
  }

  private advanceWaterline(now: number): void {
    this.storage.sql.exec(
      `UPDATE workspace_project_state SET waterline = waterline + 1, updated_at = ? WHERE id = 1`,
      now,
    );
  }
}
