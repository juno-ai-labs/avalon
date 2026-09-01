import {
  WorkstreamSchema,
  type Workstream,
  type WorkstreamBatchFilter,
} from "@rally/contracts";
import { z } from "zod";

import { workspaceDOName } from "../durable-objects/names";
import {
  WorkspaceBatchDispatchAdvanceResultSchema,
  WorkspaceBatchDispatchBeginResultSchema,
  WorkspaceDirectoryPageSchema,
  WorkspaceDirectoryReadableIdsResultSchema,
} from "../durable-objects/workspace-directory-protocol";
import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";

const PinnedWorkstreamsSchema = z.strictObject({ items: z.array(WorkstreamSchema) });

/** Typed WorkspaceDO client for the authoritative cross-workstream directory. */
export class WorkstreamDirectoryService {
  constructor(private readonly env: Env, private readonly auth: AuthContext) {}

  async list(limit: number, before?: string, includeSystem = false) {
    const workspace = await this.workspace();
    return WorkspaceDirectoryPageSchema.parse(await workspace.listWorkstreams({
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      limit,
      ...(before ? { before } : {}),
      includeSystem,
    }));
  }

  async visible(workstreamId: string): Promise<boolean> {
    const workspace = await this.workspace();
    return workspace.canReadWorkstream({
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      workstreamId,
    });
  }

  async readableIds(workstreamIds: string[]): Promise<string[]> {
    if (workstreamIds.length === 0) return [];
    const workspace = await this.workspace();
    return WorkspaceDirectoryReadableIdsResultSchema.parse(await workspace.readableWorkstreamIds({
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      workstreamIds,
    })).items;
  }

  async batchTargets(filter: WorkstreamBatchFilter): Promise<string[]> {
    const workspace = await this.workspace();
    const result = await workspace.batchUpdateTargets({
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      filter,
    });
    return result.items;
  }

  async beginBatchDispatch(input: {
    operationId: string;
    requestHash: string;
    filter: WorkstreamBatchFilter;
  }): Promise<{ items: string[]; targetCount: number }> {
    const workspace = await this.workspace();
    return WorkspaceBatchDispatchBeginResultSchema.parse(
      await workspace.beginWorkstreamBatchDispatch({
        workspaceId: this.auth.workspaceId,
        userId: this.auth.userId,
        ...input,
      }),
    );
  }

  async advanceBatchDispatch(input: {
    operationId: string;
    requestHash: string;
    workstreamIds: string[];
  }): Promise<{ remainingCount: number }> {
    const workspace = await this.workspace();
    return WorkspaceBatchDispatchAdvanceResultSchema.parse(
      await workspace.advanceWorkstreamBatchDispatch({
        workspaceId: this.auth.workspaceId,
        ...input,
      }),
    );
  }

  async plannedForAutomation(
    automationSubscriptionId: string,
    plannedFor: string,
  ): Promise<Workstream | null> {
    const workspace = await this.workspace();
    const result = await workspace.plannedWorkstream({
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      automationSubscriptionId,
      plannedFor,
    });
    return result ? WorkstreamSchema.parse(result) : null;
  }

  async pin(workstreamId: string): Promise<{ items: Workstream[] }> {
    const workspace = await this.workspace();
    try {
      return PinnedWorkstreamsSchema.parse(await workspace.pinWorkstream({
        workspaceId: this.auth.workspaceId,
        userId: this.auth.userId,
        workstreamId,
      }));
    } catch (error) {
      if (error instanceof Error && error.message === "workstream_not_found") {
        throw new ApiError(404, "workstream_not_found", "Work stream not found");
      }
      if (error instanceof Error && error.message === "workstream_pin_limit_reached") {
        throw new ApiError(422, "workstream_pin_limit_reached", "Up to 1,000 work streams may be pinned");
      }
      throw error;
    }
  }

  async unpin(workstreamId: string): Promise<{ items: Workstream[] }> {
    const workspace = await this.workspace();
    return PinnedWorkstreamsSchema.parse(await workspace.unpinWorkstream({
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      workstreamId,
    }));
  }

  async reorderPins(workstreamIds: string[]): Promise<{ items: Workstream[] }> {
    const workspace = await this.workspace();
    return PinnedWorkstreamsSchema.parse(await workspace.reorderWorkstreamPins({
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      workstreamIds,
    }));
  }

  private workspace() {
    return durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      this.auth.workspaceId,
      workspaceDOName(this.env.AVALON_REGION, this.auth.workspaceId),
    );
  }
}
