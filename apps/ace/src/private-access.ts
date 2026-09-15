import { zodDiagnosticCode } from '@rally/contracts';
import { regional, relayRegionalError } from './regional-api';
import { ACCESS_PAGE_SIZE, AccessPageQuerySchema, AccessRecoverySchema, AccessRecoveryResultSchema, DownloadGrantInputSchema } from '@rally/contracts/private-access';
import { downloadGrantUrl, issueDownloadGrant, listAccessRequests, listDownloadGrants, revokeDownloadGrant } from '@rally/db/private-access';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AccessPrincipal } from './access';
import type { Env } from './env';

export const accessRoutes = new Hono<{ Bindings: Env; Variables: { principal: AccessPrincipal } }>();
accessRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  if (c.req.method === 'POST' && c.req.header('origin') !== new URL(c.req.url).origin) return c.json({ error: 'same_origin_required' }, 403);
  await next();
});
accessRoutes.get('/requests', async (c) => {
  const query = AccessPageQuerySchema.safeParse(c.req.query());
  if (!query.success) return c.json({ error: 'invalid_page' }, 400);
  const rows = await listAccessRequests(c.env.GLOBAL_DB, query.data.q, query.data.before);
  return c.json({ requests: rows.slice(0, ACCESS_PAGE_SIZE), nextCursor: rows.length > ACCESS_PAGE_SIZE ? rows[ACCESS_PAGE_SIZE - 1]!.id : null });
});
accessRoutes.get('/downloads', async (c) => {
  const query = AccessPageQuerySchema.safeParse(c.req.query());
  if (!query.success) return c.json({ error: 'invalid_page' }, 400);
  const rows = await listDownloadGrants(c.env.GLOBAL_DB, query.data.q, query.data.before);
  return c.json({ grants: rows.slice(0, ACCESS_PAGE_SIZE), nextCursor: rows.length > ACCESS_PAGE_SIZE ? rows[ACCESS_PAGE_SIZE - 1]!.id : null });
});
accessRoutes.post('/downloads/:id/revoke', async (c) => {
  const id = z.string().uuid().safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'invalid_grant' }, 400);
  if (!await revokeDownloadGrant(c.env.GLOBAL_DB, id.data)) return c.json({ error: 'not_found' }, 404);
  console.log(JSON.stringify({ event: 'ace_download_grant_revoked', actor: c.get('principal').subject, grantId: id.data }));
  return c.json({ revoked: true });
});
accessRoutes.post('/requests/:id/recover', async (c) => {
  const id = z.string().uuid().safeParse(c.req.param('id'));
  const input = AccessRecoverySchema.safeParse(await c.req.json().catch(() => null));
  if (!id.success || !input.success) return c.json({ error: 'invalid_recovery' }, 400);
  try {
    const result = await regional(c.env, 'global', `/internal/access/requests/${id.data}/recover`,
      { method: 'POST', body: input.data }, (value) => AccessRecoveryResultSchema.parse(value));
    console.log(JSON.stringify({ event: 'ace_access_recovery', actor: c.get('principal').subject, requestId: id.data, action: input.data.action }));
    return c.json(result);
  } catch (error) { return relayRegionalError(error); }
});
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
    // A deadline can pass between request validation and the shared issuer,
    // which re-validates; the field it refused is what the operator corrects.
    if (error instanceof z.ZodError) {
      return c.json({ error: 'invalid_download_request', message: `The download grant was refused (${zodDiagnosticCode(error, 'download_grant')})` }, 400);
    }
    throw error;
  }
});
