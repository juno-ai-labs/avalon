import { WorkerEntrypoint } from 'cloudflare:workers';
import { WorkspaceIdSchema } from '@rally/contracts';
import { z } from 'zod';
import type { Env } from './env';
import { authorizationWorkspace } from './services/authorization-service';
import { resolveInspectionWorkspaceRoute } from './engineering-inspection-routes';

const CommandSchema = z.strictObject({ workspaceId: WorkspaceIdSchema,
  action: z.enum(['backfill', 'status']) });

/** Private operator Service Binding only. No product HTTP route exposes migration controls. */
export class AuthorizationControl extends WorkerEntrypoint<Env> {
  async execute(input: unknown) {
    const command = CommandSchema.parse(input);
    const route = await resolveInspectionWorkspaceRoute(this.env, command.workspaceId);
    if (!route) return { status: 'unavailable' as const, reason: 'workspace_route_unavailable' as const, retryable: true };
    const workspace = await authorizationWorkspace(this.env, command.workspaceId);
    const target = { workspaceId: command.workspaceId };
    switch (command.action) {
      case 'backfill': return workspace.beginAuthorizationBackfill(target);
      case 'status': return workspace.authorizationBackfillStatus(target);
    }
  }
}
