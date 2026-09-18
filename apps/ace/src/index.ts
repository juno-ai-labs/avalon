import { RegionSchema } from "@rally/contracts/regions";
import { DemoOperationStartRequestSchema, ProductFeatureFlagKeySchema } from '@rally/contracts';
import { zodDiagnosticCode } from '@rally/contracts/zod-diagnostics';
import { Hono } from 'hono';
import { z } from 'zod';
import { accessFailureMessage, readAccessConfiguration, verifyAccessRequest, type AccessPrincipal } from './access';
import { listDeadLetterQueues, peekDeadLetterQueue } from './cloudflare-queue-admin';
import {
  abandonDemoOperation,
  listDemoOperations,
  readDemoTemplate,
  retryDemoOperation,
  startDemoOperation,
} from './demos';
import { searchUsers, searchWorkspaces, type DirectoryRegion } from './directory';
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
import { accessRoutes } from './private-access';
import { consumeFlagChanges } from './queues';
import { relayRegionalError, retireWorkspace } from './regional-api';

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

app.get('/api/flags', async (c) => c.json({ flags: await listManagedFlags(c.env) }));

app.get('/api/models', async (c) => c.json({ flags: await listManagedModelFlags(c.env) }));

app.post('/api/models/validate', async (c) => {
  if (!sameOrigin(c)) return c.json({ error: 'same_origin_required' }, 403);
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

app.put('/api/flags/:key', async (c) => {
  if (!sameOrigin(c)) return c.json({ error: 'same_origin_required' }, 403);
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
  if (!sameOrigin(c)) return c.json({ error: 'same_origin_required' }, 403);
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
 * The Demos page and the workspaces tab. Ace holds nothing here: each route
 * asks the regional API over the operator credential and relays its answer,
 * and a regional refusal reaches the page as the code and message the API
 * gave, so an operator reads "the template is not in this region" rather than
 * "request failed".
 */
const UuidSchema = z.string().uuid();
const AbandonRequestSchema = z.strictObject({ confirmOperationId: z.string().uuid() });
const RetireRequestSchema = z.strictObject({
  region: RegionSchema,
  confirmWorkspaceId: z.string().uuid(),
});

app.get('/api/demos', async (c) => {
  try {
    return c.json({ operations: await listDemoOperations(c.env) });
  } catch (error) { return relayRegionalError(error); }
});

app.get('/api/demos/template', async (c) => {
  try {
    return c.json(await readDemoTemplate(c.env));
  } catch (error) { return relayRegionalError(error); }
});

app.post('/api/demos', async (c) => {
  if (!sameOrigin(c)) return c.json({ error: 'same_origin_required', message: 'Writes are accepted from the Ace page only.' }, 403);
  const body = DemoOperationStartRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) {
    const field = body.error.issues[0]?.path.join('.') || 'request';
    return c.json({ error: 'invalid_demo_request', message: `The demo request is not valid: ${field}.` }, 400);
  }
  try {
    const status = await startDemoOperation(c.env, body.data);
    console.log(JSON.stringify({
      event: 'ace_demo_preparation_started',
      actor_subject: c.get('principal').subject,
      operation_id: body.data.operationId,
    }));
    return c.json(status);
  } catch (error) { return relayRegionalError(error); }
});

app.post('/api/demos/:operationId/:action{retry|abandon}', async (c) => {
  if (!sameOrigin(c)) return c.json({ error: 'same_origin_required', message: 'Writes are accepted from the Ace page only.' }, 403);
  const operationId = UuidSchema.safeParse(c.req.param('operationId'));
  if (!operationId.success) return c.json({ error: 'invalid_operation_id', message: 'The operation id is not a UUID.' }, 400);
  const action = c.req.param('action') as 'retry' | 'abandon';
  let confirmOperationId: string | null = null;
  if (action === 'abandon') {
    // The typed confirmation has to name the operation in the path — a
    // consistency check made here and again regionally, as retirement's is —
    // and what the operator typed is what travels, not a value re-derived
    // from the path.
    const body = AbandonRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'invalid_abandon_request', message: 'Type the operation id to confirm.' }, 400);
    if (body.data.confirmOperationId !== operationId.data) {
      return c.json({ error: 'demo_abandon_unconfirmed', message: 'The confirmation does not name this preparation.' }, 409);
    }
    confirmOperationId = body.data.confirmOperationId;
  }
  try {
    const status = action === 'retry'
      ? await retryDemoOperation(c.env, operationId.data)
      : await abandonDemoOperation(c.env, operationId.data, confirmOperationId!);
    console.log(JSON.stringify({
      event: action === 'retry' ? 'ace_demo_preparation_retried' : 'ace_demo_preparation_abandoned',
      actor_subject: c.get('principal').subject,
      operation_id: operationId.data,
    }));
    return c.json(status);
  } catch (error) { return relayRegionalError(error); }
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
  queue: consumeFlagChanges,
} satisfies ExportedHandler<Env>;
