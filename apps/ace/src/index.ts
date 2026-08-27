import { ProductFeatureFlagKeySchema } from '@rally/contracts';
import { Hono } from 'hono';
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
