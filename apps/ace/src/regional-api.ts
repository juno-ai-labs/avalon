import { regionConfiguration } from "@rally/contracts/regions";
import type { Region } from "@rally/contracts/regions";
import { WorkspaceRetirementResultSchema, type WorkspaceRetirementResult } from '@rally/contracts';
import { zodDiagnosticCode } from '@rally/contracts/zod-diagnostics';
import { z } from 'zod';
import type { Env } from './env';

/**
 * Ace's client for the regional API's operator routes.
 *
 * Ace holds no state behind these and reads no table: every question is asked
 * of the regional Worker that owns the answer, over that region's operator
 * credential in the `demos` role, and every response is parsed with the shared
 * contract before it reaches the page. A workspace is retired in whichever
 * region owns it, so retirement takes the region — and the regional API
 * refuses an id its region does not own, so a wrong region is a refusal
 * rather than a phantom retirement. `docs/ace.md` owns the pages;
 * `docs/workspace-retirement.md` owns the walk.
 */

export type RallyRegion = Region;

export class RegionalApiError extends Error {
  /**
   * `local` marks a refusal Ace made before asking anybody — a missing base
   * URL or token — which is Ace's own 503, as opposed to a regional answer.
   */
  constructor(readonly status: number, readonly code: string, message: string, readonly local = false) {
    super(message);
    this.name = 'RegionalApiError';
  }
}

function baseUrl(env: Env, region: RallyRegion): string {
  const base = region === 'global' ? env.RALLY_API_BASE_URL : env[`RALLY_${regionConfiguration(region).bindingPrefix}_API_BASE_URL`];
  if (!base) throw new RegionalApiError(503, 'regional_api_not_configured', 'The regional API base URL is not configured', true);
  return base.replace(/\/$/u, '');
}

function operatorToken(env: Env, region: RallyRegion): string {
  const token = region === 'global' ? env.RALLY_OPERATOR_TOKEN : env[`RALLY_${regionConfiguration(region).bindingPrefix}_OPERATOR_TOKEN`];
  if (!token) throw new RegionalApiError(503, 'operator_token_not_configured', 'The operator credential is not configured', true);
  return token;
}

/**
 * One request to one region's operator API, parsed with the contract the
 * caller names. The parser is required: a default that cast the body was an
 * `as` standing in for a parse, in the one file whose job is to parse.
 */
export async function regional<Result>(
  env: Env,
  region: RallyRegion,
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown },
  parse: (value: unknown) => Result,
): Promise<Result> {
  const token = operatorToken(env, region);
  const response = await fetch(`${baseUrl(env, region)}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const body = await response.json().catch(() => null) as
    | { error?: { code?: unknown; message?: unknown } | string; message?: unknown }
    | null;
  if (!response.ok) {
    const error = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error : null;
    const code = typeof error?.code === 'string' ? error.code
      : typeof body?.error === 'string' ? body.error : 'regional_api_error';
    const message = typeof error?.message === 'string' ? error.message
      : typeof body?.message === 'string' ? body.message : `The regional API answered ${response.status}`;
    throw new RegionalApiError(response.status, code, message);
  }
  return parse(body);
}

/**
 * A regional 5xx is relayed as a bad gateway; Ace's own refusal keeps its
 * status. An answer the contract does not accept is named as such: Ace and the
 * regional API deploy independently, and a version skew between them read as
 * an outage — one that no refresh clears, because the mismatch is
 * deterministic.
 */
export function relayRegionalError(error: unknown): Response {
  if (error instanceof RegionalApiError) {
    const status = error.local ? error.status : error.status >= 500 ? 502 : error.status;
    return Response.json({ error: error.code, message: error.message }, { status });
  }
  if (error instanceof z.ZodError) {
    // Which field disagrees is the one thing an operator can act on: it says
    // whether Ace or the regional API is the one behind. Paths and issue
    // codes only; the regional answer's values stay out of the page.
    return Response.json({
      error: 'regional_api_contract_mismatch',
      message: `The regional API answered in a shape this version of Ace does not recognise (${zodDiagnosticCode(error, 'regional_response')}); Ace and the regional API may be on different versions.`,
    }, { status: 502 });
  }
  return Response.json({ error: 'regional_api_unavailable', message: 'The regional API could not be reached.' }, { status: 502 });
}

/**
 * Retire a workspace in the region that owns it. The confirmation the operator
 * typed travels with the call, and the regional API refuses unless it names
 * the workspace in the path — a consistency check on the request, made once
 * more on the far side; the typed ceremony itself is the page's.
 */
export async function retireWorkspace(
  env: Env,
  input: { region: RallyRegion; workspaceId: string; confirmWorkspaceId: string },
): Promise<WorkspaceRetirementResult> {
  return regional(
    env,
    input.region,
    `/internal/workspaces/${encodeURIComponent(input.workspaceId)}/retire`,
    { method: 'POST', body: { confirmWorkspaceId: input.confirmWorkspaceId } },
    (value) => WorkspaceRetirementResultSchema.parse(value),
  );
}

export function regionalDatabase(env: Env, region: string): D1Database {
  const db = env[`${regionConfiguration(region).bindingPrefix}_DB`];
  if (!db) throw new Error('regional_database_unavailable');
  return db;
}
export function regionalFlagQueue(env: Env, region: string): Queue {
  const queue = env[`${regionConfiguration(region).bindingPrefix}_PRODUCT_FLAG_QUEUE`];
  if (!queue) throw new Error('regional_queue_unavailable');
  return queue;
}
