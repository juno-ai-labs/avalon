import { ProductFeatureFlagKeySchema } from '@rally/contracts';
import { Hono } from 'hono';
import { z } from 'zod';
import { accessFailureMessage, readAccessConfiguration, verifyAccessRequest, type AccessPrincipal } from './access';
import { listDeadLetterQueues, peekDeadLetterQueue } from './cloudflare-queue-admin';
import { searchUsers, searchWorkspaces } from './directory';
import { devAuthEnabled, type Env } from './env';
import {
  listManagedFlags,
  listManagedModelFlags,
  updateManagedFlag,
  updateManagedModelRouting,
} from './flagship';
import { validateOpenRouterModels } from './openrouter';
import {
  ManagedFlagUpdateSchema,
  ManagedModelRoleSchema,
  ManagedModelUpdateSchema,
  ModelValidationRequestSchema,
} from './protocol';
import { consumeFlagChanges } from './queues';
import { relayRegionalError, retireWorkspace } from './regional-api';

type AceHono = { Bindings: Env; Variables: { principal: AccessPrincipal } };
const app = new Hono<AceHono>();

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

app.get('/api/session', (c) => c.json({
  email: c.get('principal').email,
  version: c.env.APP_VERSION ?? 'development',
}));

app.get('/api/flags', async (c) => c.json({ flags: await listManagedFlags(c.env) }));

app.get('/api/models', async (c) => c.json({ flags: await listManagedModelFlags(c.env) }));

app.post('/api/models/validate', async (c) => {
  const origin = c.req.header('origin');
  if (!origin || origin !== new URL(c.req.url).origin) return c.json({ error: 'same_origin_required' }, 403);
  const body = ModelValidationRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'invalid_model_validation_request' }, 400);
  try {
    return c.json({ models: await validateOpenRouterModels(body.data.modelIds) });
  } catch {
    return c.json({
      error: 'openrouter_validation_unavailable',
      message: 'OpenRouter model validation is temporarily unavailable.',
    }, 502);
  }
});

app.get('/api/queues/dead-letters', async (c) => c.json({ queues: await listDeadLetterQueues(c.env) }));

app.post('/api/queues/dead-letters/:id/peek', async (c) => {
  const origin = c.req.header('origin');
  if (!origin || origin !== new URL(c.req.url).origin) return c.json({ error: 'same_origin_required' }, 403);
  const messages = await peekDeadLetterQueue(c.env, decodeURIComponent(c.req.param('id')));
  return c.json({ messages });
});

app.get('/api/directory/users', async (c) => {
  const query = c.req.query('q')?.trim() ?? '';
  return c.json({ results: query.length >= 2 ? await searchUsers(c.env, query) : [] });
});

app.get('/api/directory/workspaces', async (c) => {
  const query = c.req.query('q')?.trim() ?? '';
  return c.json({ results: query.length >= 2 ? await searchWorkspaces(c.env, query) : [] });
});

app.put('/api/flags/:key', async (c) => {
  const origin = c.req.header('origin');
  if (!origin || origin !== new URL(c.req.url).origin) return c.json({ error: 'same_origin_required' }, 403);
  const key = ProductFeatureFlagKeySchema.safeParse(decodeURIComponent(c.req.param('key')));
  const body = ManagedFlagUpdateSchema.safeParse(await c.req.json().catch(() => null));
  if (!key.success || !body.success || body.data.key !== key.data) {
    return c.json({ error: 'invalid_flag_configuration' }, 400);
  }
  const flag = await updateManagedFlag(c.env, key.data, body.data);
  console.log(JSON.stringify({
    event: 'ace_product_flag_updated',
    actor_subject: c.get('principal').subject,
    flag_key: key.data,
  }));
  return c.json({ flag });
});

app.put('/api/models/:role', async (c) => {
  const origin = c.req.header('origin');
  if (!origin || origin !== new URL(c.req.url).origin) return c.json({ error: 'same_origin_required' }, 403);
  const role = ManagedModelRoleSchema.safeParse(decodeURIComponent(c.req.param('role')));
  const body = ManagedModelUpdateSchema.safeParse(await c.req.json().catch(() => null));
  if (!role.success || !body.success || body.data.role !== role.data) {
    return c.json({
      error: 'invalid_model_configuration',
      message: 'The model route is incomplete or does not match the requested role.',
    }, 400);
  }
  let validations;
  try {
    validations = await validateOpenRouterModels([
      body.data.routing.model,
      ...body.data.routing.fallbackModels,
    ]);
  } catch {
    return c.json({
      error: 'openrouter_validation_unavailable',
      message: 'OpenRouter model validation is temporarily unavailable. No changes were saved.',
    }, 502);
  }
  const invalidModelIds = validations.filter((validation) => !validation.valid)
    .map((validation) => validation.modelId);
  if (invalidModelIds.length > 0) {
    return c.json({
      error: 'invalid_openrouter_models',
      message: `OpenRouter does not recognize or currently route: ${invalidModelIds.join(', ')}`,
      invalidModelIds,
    }, 400);
  }
  const flag = await updateManagedModelRouting(c.env, role.data, body.data);
  console.log(JSON.stringify({
    event: 'ace_agent_model_updated',
    actor_subject: c.get('principal').subject,
    agent_role: role.data,
  }));
  return c.json({ flag });
});

/**
 * The workspaces tab. Ace holds nothing here: the route asks the regional API
 * over the operator credential and relays its answer, and a regional refusal
 * reaches the page as the code and message the API gave, so an operator reads
 * "no workspace with this id in this region" rather than "request failed".
 * Writes are same-origin, like every other write in Ace.
 */
const UuidSchema = z.string().uuid();
const RetireRequestSchema = z.strictObject({
  region: z.enum(['global', 'eu']),
  confirmWorkspaceId: z.string().uuid(),
});

function sameOrigin(c: { req: { header(name: string): string | undefined; url: string } }): boolean {
  const origin = c.req.header('origin');
  return Boolean(origin) && origin === new URL(c.req.url).origin;
}

app.post('/api/workspaces/:workspaceId/retire', async (c) => {
  if (!sameOrigin(c)) return c.json({ error: 'same_origin_required', message: 'Writes are accepted from the Ace page only.' }, 403);
  const workspaceId = UuidSchema.safeParse(c.req.param('workspaceId'));
  const body = RetireRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!workspaceId.success || !body.success) {
    return c.json({ error: 'invalid_retirement_request', message: 'The request needs the region and the typed workspace id.' }, 400);
  }
  // Refused here as well as regionally: the confirmation is the whole of the
  // protection on an irreversible close, and the page is not trusted to have
  // asked for it.
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

app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));
app.onError((error, c) => {
  console.error(JSON.stringify({ event: 'ace_request_failed', path: c.req.path, error: error.message }));
  return c.json({ error: 'internal_error' }, 500);
});

export default {
  fetch: app.fetch,
  queue: consumeFlagChanges,
} satisfies ExportedHandler<Env>;
