import {
  DemoOperationListSchema,
  DemoOperationStatusSchema,
  DemoTemplateSchema,
  type DemoOperationStartRequest,
  type DemoOperationStatus,
  type DemoTemplate,
} from '@rally/contracts';
import type { Env } from './env';
import { regional } from './regional-api';

/**
 * Ace's client for the regional API's demo preparation routes.
 *
 * Ace holds no demo state and reads no demo table: every question is asked of
 * the Global Worker that owns the answer, over its operator credential in the
 * `demos` role through the shared relay, and every response is parsed with
 * the shared contract before it reaches the page. Demos are prepared in
 * Global only. `docs/ace.md` owns the page; `docs/demo-workspaces.md` owns
 * the operation.
 */

export async function listDemoOperations(env: Env): Promise<DemoOperationStatus[]> {
  return (await regional(env, 'global', '/internal/demos', {}, (value) => DemoOperationListSchema.parse(value))).operations;
}

export async function readDemoTemplate(env: Env): Promise<DemoTemplate> {
  return regional(env, 'global', '/internal/demos/template', {}, (value) => DemoTemplateSchema.parse(value));
}

export async function startDemoOperation(env: Env, request: DemoOperationStartRequest): Promise<DemoOperationStatus> {
  return regional(env, 'global', '/internal/demos', { method: 'POST', body: request }, (value) => DemoOperationStatusSchema.parse(value));
}

export async function retryDemoOperation(env: Env, operationId: string): Promise<DemoOperationStatus> {
  return regional(env, 'global', `/internal/demos/${encodeURIComponent(operationId)}/retry`, { method: 'POST' }, (value) => DemoOperationStatusSchema.parse(value));
}

/**
 * Abandon an unfinished preparation. The confirmation the operator typed
 * travels with the call, as retirement's does, and the regional API compares
 * it with the path once more — a consistency check on the request, not a
 * second confirmation; the typed ceremony is the page's.
 */
export async function abandonDemoOperation(env: Env, operationId: string, confirmOperationId: string): Promise<DemoOperationStatus> {
  return regional(
    env,
    'global',
    `/internal/demos/${encodeURIComponent(operationId)}/abandon`,
    { method: 'POST', body: { confirmOperationId } },
    (value) => DemoOperationStatusSchema.parse(value),
  );
}
