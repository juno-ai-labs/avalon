import { ProductFeatureFlagKeySchema } from '@rally/contracts';
import { Hono } from 'hono';
import { accessFailureMessage, readAccessConfiguration, verifyAccessRequest, type AccessPrincipal } from './access';
import { searchUsers, searchWorkspaces } from './directory';
import { devAuthEnabled, type Env } from './env';
import { listManagedFlags, updateManagedFlag } from './flagship';
import { ManagedFlagUpdateSchema } from './protocol';
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
