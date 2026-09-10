import { getPath } from 'hono/utils/url';
import type { Env } from '../env';
import { MAX_PRIVATE_ACCESS_REQUEST_BYTES, MAX_ACCESS_REQUESTS_PER_IP_PER_HOUR, MAX_ACCESS_EMAILS_PER_HOUR, MAX_DOWNLOAD_STARTS_PER_MINUTE } from './access-request-limits';

/** Runs before the Worker-wide authority read, so rejected traffic cannot spend D1. */
export async function privateAccessEdge(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  // Match Hono's decoding exactly: /%61ccess must not evade the outer guard.
  const path = getPath(request);
  if (path !== '/access' && !path.startsWith('/access/')) return null;
  const origin = request.headers.get('origin');
  const allowedOrigin = origin && env.ALLOWED_ORIGINS.split(',').map((value) => value.trim()).includes(origin);
  const headers = new Headers({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  if (allowedOrigin) { headers.set('Access-Control-Allow-Origin', origin); headers.set('Vary', 'Origin'); }
  const refuse = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status, headers });
  if (path !== url.pathname || env.AVALON_REGION !== 'global' || (env.APP_ENV === 'production' && url.origin !== new URL(env.PUBLIC_API_BASE_URL).origin)) {
    return refuse(404, 'not_found', 'Not found');
  }
  if (!['/access/requests', '/access/downloads/redeem'].includes(url.pathname)) return refuse(404, 'not_found', 'Not found');
  // Browser preflight performs no database work and cannot trigger an effect.
  if (request.method === 'OPTIONS') {
    if (!allowedOrigin) return refuse(403, 'origin_not_allowed', 'Origin not allowed');
    headers.set('Access-Control-Allow-Methods', 'POST');
    headers.set('Access-Control-Allow-Headers', 'Content-Type');
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== 'POST') return refuse(405, 'method_not_allowed', 'Use POST');
  if (url.pathname === '/access/requests' && !allowedOrigin) return refuse(403, 'origin_not_allowed', 'Origin not allowed');
  if (env.APP_ENV === 'production' && (!env.ACCESS_EDGE_RATE_LIMITER || !env.TURNSTILE_SECRET_KEY ||
    ![MAX_PRIVATE_ACCESS_REQUEST_BYTES, MAX_ACCESS_REQUESTS_PER_IP_PER_HOUR, MAX_ACCESS_EMAILS_PER_HOUR, MAX_DOWNLOAD_STARTS_PER_MINUTE].every(Number.isFinite))) return refuse(503, 'access_unavailable', 'Please try again later.');
  if (env.ACCESS_EDGE_RATE_LIMITER) {
    try {
      if (!(await env.ACCESS_EDGE_RATE_LIMITER.limit({ key: request.headers.get('cf-connecting-ip') ?? 'unattributed' })).success) {
        return refuse(429, 'access_request_rate_limited', 'Too many requests. Please try again later.');
      }
    } catch { return refuse(503, 'access_unavailable', 'Please try again later.'); }
  }
  // Streaming enforcement in the route also covers absent/incorrect lengths.
  if (Number(request.headers.get('content-length')) > MAX_PRIVATE_ACCESS_REQUEST_BYTES) {
    return refuse(413, 'access_body_too_large', 'This request is too large.');
  }
  return null;
}
