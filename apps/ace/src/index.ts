import { RegionSchema } from "@rally/contracts/regions";
import { zodDiagnosticCode } from '@rally/contracts/zod-diagnostics';
import { Hono } from 'hono';
import { z } from 'zod';
import { accessFailureMessage, readAccessConfiguration, verifyAccessRequest, type AccessPrincipal } from './access';
import { listDeadLetterQueues, peekDeadLetterQueue } from './cloudflare-queue-admin';
import { searchUsers, searchWorkspaces, type DirectoryRegion } from './directory';
import { devAuthEnabled, type Env } from './env';
import { accessRoutes } from './private-access';
import { changeWorkspacePlan, relayRegionalError, retireWorkspace } from './regional-api';
import { PlanIdSchema } from '@rally/contracts/usage';

type AceHono = { Bindings: Env; Variables: { principal: AccessPrincipal } };
const app = new Hono<AceHono>();

/** Every write in Ace is accepted from the Ace page only. */
function sameOrigin(c: { req: { header(name: string): string | undefined; url: string } }): boolean {
  const origin = c.req.header('origin');
  return Boolean(origin) && origin === new URL(c.req.url).origin;
}

/**
 * A directory that did not answer is a 502 with a sentence, not the bare
 * `internal_error` the fallback handler writes: the page shows the message, and
 * an operator about to retire a workspace has to read "the directory was down"
 * rather than a code.
 */
function directoryUnavailable(c: { json(body: unknown, status: 502): Response }, regions?: DirectoryRegion[]): Response {
  const which = regions && regions.length === 1 ? `The ${regions[0]!.toUpperCase()} directory` : 'The directory';
  return c.json({ error: 'directory_unavailable', message: `${which} did not answer. Try again; nothing was searched.` }, 502);
}

app.use('*', async (c, next) => {
  if (devAuthEnabled(c.env)) {
    c.set('principal', { email: 'developer@local', subject: 'development', audience: 'development' });
    return next();
  }
  const access = await verifyAccessRequest(c.req.raw, readAccessConfiguration(c.env));
  if (!access.ok) {
    return c.json({ error: access.reason, message: accessFailureMessage(access.reason) }, 403);
  }
  c.set('principal', access.principal);
  return next();
});

app.route('/api/access', accessRoutes);

app.get('/api/session', (c) => c.json({
  email: c.get('principal').email,
  version: c.env.APP_VERSION ?? 'development',
}));

app.get('/api/queues/dead-letters', async (c) => c.json({ queues: await listDeadLetterQueues(c.env) }));

app.post('/api/queues/dead-letters/:id/peek', async (c) => {
  if (!sameOrigin(c)) return c.json({ error: 'same_origin_required' }, 403);
  const messages = await peekDeadLetterQueue(c.env, decodeURIComponent(c.req.param('id')));
  return c.json({ messages });
});

app.get('/api/directory/users', async (c) => {
  const query = c.req.query('q')?.trim() ?? '';
  try {
    return c.json({ results: query.length >= 2 ? await searchUsers(c.env, query) : [] });
  } catch {
    return directoryUnavailable(c);
  }
});

app.get('/api/directory/workspaces', async (c) => {
  const query = c.req.query('q')?.trim() ?? '';
  if (query.length < 2) return c.json({ results: [], unavailableRegions: [] });
  try {
    return c.json(await searchWorkspaces(c.env, query));
  } catch {
    return directoryUnavailable(c);
  }
});

/**
 * The workspaces tab. Ace holds nothing here: each route asks the regional
 * API over the operator credential and relays its answer, and a regional
 * refusal reaches the page as the code and message the API gave
 * (`workspace_not_found`, "No workspace with this id in this region") rather
 * than "request failed".
 */
const UuidSchema = z.string().uuid();
const PlanRequestSchema = z.strictObject({
  region: RegionSchema,
  plan: PlanIdSchema,
});
const RetireRequestSchema = z.strictObject({
  region: RegionSchema,
  confirmWorkspaceId: z.string().uuid(),
});

app.post('/api/workspaces/:workspaceId/retire', async (c) => {
  if (!sameOrigin(c)) return c.json({ error: 'same_origin_required', message: 'Writes are accepted from the Ace page only.' }, 403);
  const workspaceId = UuidSchema.safeParse(c.req.param('workspaceId'));
  const body = RetireRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!workspaceId.success || !body.success) {
    return c.json({ error: 'invalid_retirement_request', message: 'The request needs the region and the typed workspace id.' }, 400);
  }
  // A consistency check on the request — the confirmation has to name the
  // workspace in the path — not a second confirmation: a caller that fills in
  // both fields with the same id passes it. The typed ceremony is the page's,
  // and the regional API makes the same check on what it receives.
  if (body.data.confirmWorkspaceId !== workspaceId.data) {
    return c.json({ error: 'workspace_retirement_unconfirmed', message: 'Type the workspace id to confirm.' }, 409);
  }
  try {
    const receipt = await retireWorkspace(c.env, {
      region: body.data.region,
      workspaceId: workspaceId.data,
      confirmWorkspaceId: body.data.confirmWorkspaceId,
    });
    console.log(JSON.stringify({
      event: 'ace_workspace_retired',
      actor_subject: c.get('principal').subject,
      workspace_id: workspaceId.data,
      region: body.data.region,
      complete: receipt.complete,
    }));
    return c.json(receipt);
  } catch (error) { return relayRegionalError(error); }
});

app.post('/api/workspaces/:workspaceId/plan', async (c) => {
  if (!sameOrigin(c)) return c.json({ error: 'same_origin_required', message: 'Writes are accepted from the Ace page only.' }, 403);
  const workspaceId = UuidSchema.safeParse(c.req.param('workspaceId'));
  const body = PlanRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!workspaceId.success || !body.success) {
    const refused = !workspaceId.success ? zodDiagnosticCode(workspaceId.error, 'workspace_id') : zodDiagnosticCode(body.error, 'plan_request');
    return c.json({ error: 'invalid_plan_request', message: `The request needs the region and a plan (${refused}).` }, 400);
  }
  try {
    const result = await changeWorkspacePlan(c.env, { region: body.data.region, workspaceId: workspaceId.data, plan: body.data.plan });
    console.log(JSON.stringify({
      event: 'ace_workspace_plan_changed',
      actor_subject: c.get('principal').subject,
      workspace_id: workspaceId.data,
      region: body.data.region,
      plan: body.data.plan,
    }));
    return c.json(result);
  } catch (error) { return relayRegionalError(error); }
});

app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));
app.onError((error, c) => {
  // A schema rejection's message is its issue list as JSON; the code names
  // the field so the row can be read without expanding it.
  const errorCode = zodDiagnosticCode(error, 'request');
  console.error(JSON.stringify({ event: 'ace_request_failed', path: c.req.path, error: error.message, ...(errorCode ? { error_code: errorCode } : {}) }));
  return c.json({ error: 'internal_error' }, 500);
});

export default {
  fetch: app.fetch,
  // Cloudflare still has this Worker registered as the consumer of the retired
  // flag-change queue (#1512 removed the declaration, not the hosted
  // registration), and rejects any version without a queue handler (code
  // 11001). Drain and drop whatever remains until the consumer is detached.
  queue(batch) {
    batch.ackAll();
  },
} satisfies ExportedHandler<Env>;
