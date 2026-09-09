import { DownloadGrantInputSchema } from '@rally/contracts/private-access';
import { downloadGrantUrl, issueDownloadGrant, listAccessRequests } from '@rally/db/private-access';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AccessPrincipal } from './access';
import type { Env } from './env';

export const accessRoutes = new Hono<{ Bindings: Env; Variables: { principal: AccessPrincipal } }>();
accessRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
});
accessRoutes.get('/requests', async (c) => c.json({ requests: await listAccessRequests(c.env.GLOBAL_DB) }));
accessRoutes.post('/downloads', async (c) => {
  if (c.req.header('origin') !== new URL(c.req.url).origin) return c.json({ error: 'same_origin_required' }, 403);
  const body = DownloadGrantInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'invalid_download_request' }, 400);
  if (body.data.requestId && !await c.env.GLOBAL_DB.prepare('SELECT id FROM access_requests WHERE id = ?')
    .bind(body.data.requestId).first()) return c.json({ error: 'request_not_found' }, 404);
  try {
    const grant = await issueDownloadGrant(c.env.GLOBAL_DB, {
      source: 'manual', ...(body.data.requestId ? { sourceId: body.data.requestId } : {}), createdBy: c.get('principal').subject,
      ...(body.data.expiresAt ? { expiresAt: body.data.expiresAt } : {}),
    });
    console.log(JSON.stringify({ event: 'ace_download_grant_issued', actor: c.get('principal').subject,
      grantId: grant.id, requestId: body.data.requestId ?? null, expiresAt: grant.expiresAt }));
    return c.json({ id: grant.id, url: downloadGrantUrl(grant.token), expiresAt: grant.expiresAt }, 201);
  } catch (error) {
    // A deadline can pass between request validation and the shared issuer.
    if (error instanceof z.ZodError) return c.json({ error: 'invalid_download_request' }, 400);
    throw error;
  }
});
