import { diagnosticErrorCode, logWarn } from "../observability/logger";
import { IdSchema } from '@rally/contracts';
import { z } from 'zod';
import { ResourceService } from '../services/resource-service';
import { Hono } from 'hono';
import { SearchRequestSchema, SearchResponseSchema } from '@rally/contracts/search';
import type { HonoAppEnv } from '../env';
import { zValidator } from '../middleware/validation';
import { authenticate, getRequestMembership, getWorkspaceAuth, requireWorkspaceAuth } from '../middleware/auth';
import { ApiError } from '../lib/api-error';
import { searchWorkspacePage } from '../services/workspace-search-service';

export const searchRoutes = new Hono<HonoAppEnv>();
searchRoutes.use('*', requireWorkspaceAuth);

/** Whether the session still holds the workspace relationship the search was answered for. */
function stillHolds(current: Awaited<ReturnType<typeof authenticate>>, auth: { workspaceId: string; userId: string }): boolean {
  return current.workspaceId === auth.workspaceId && current.userId === auth.userId
    && (Boolean(current.role) || current.accessClass === 'guest');
}
searchRoutes.post('/', zValidator('json', SearchRequestSchema), async (c) => {
  const auth = getWorkspaceAuth(c);
  const started = performance.now();
  let results;
  try { results = await searchWorkspacePage(c.env, auth, c.req.valid('json'), c.req.raw.signal); }
  catch (error) {
    if (error instanceof ApiError) throw error;
    logWarn(c.env, 'search_workspace_unavailable', {
      error_code: diagnosticErrorCode(error, 'search_unavailable'),
    });
    // Provider failures may echo indexed text. Return a closed, content-free error.
    throw new ApiError(503, 'search_unavailable', 'Search is temporarily unavailable');
  }
  const current = await authenticate(c);
  if (!stillHolds(current, auth)) {
    throw new ApiError(403, 'search_access_revoked', 'Workspace access has changed');
  }
  return c.json(SearchResponseSchema.parse({ ...results,
    ...('timings' in results ? { timings: { ...results.timings, serverMs: performance.now() - started } } : {}),
  }));
});

searchRoutes.get('/resources/:id/preview', zValidator('param', z.strictObject({ id: IdSchema })), async (c) => {
  const auth = getWorkspaceAuth(c);
  return new ResourceService(c.env, auth, undefined,
    getRequestMembership(c))
    .searchPreview(c.req.valid('param').id, c.req.raw.signal);
});
