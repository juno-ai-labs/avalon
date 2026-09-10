import { verifyAccessChallenge } from '../services/access-turnstile';
import { AccessRequestInputSchema, DownloadGrantTokenSchema } from '@rally/contracts/private-access';
import { redeemDownloadGrant, availableDownloadGrantExists, admitDownloadStart } from '@rally/db/private-access';
import { Hono } from 'hono';
import { admitAccessRequest, MAX_ACCESS_REQUESTS_PER_IP_PER_HOUR, MAX_PRIVATE_ACCESS_REQUEST_BYTES, MAX_DOWNLOAD_STARTS_PER_MINUTE } from '../services/access-request-limits';
import { downloadErrorPage } from '../services/download-error-page';
import type { HonoAppEnv } from '../env';
import { ApiError } from '../lib/api-error';
import { requestAccess } from '../services/access-request-service';

export function createPrivateAccessRoutes(
  maxRequestsPerIpPerHour = MAX_ACCESS_REQUESTS_PER_IP_PER_HOUR,
  maxBodyBytes = MAX_PRIVATE_ACCESS_REQUEST_BYTES,
  maxDownloadStarts = MAX_DOWNLOAD_STARTS_PER_MINUTE,
) {
  const privateAccessRoutes = new Hono<HonoAppEnv>();

  privateAccessRoutes.use('*', async (c, next) => {
    if (c.env.AVALON_REGION !== 'global') throw new ApiError(404, 'not_found', 'Not found');
    // This new surface has no legacy clients. Keep it off the Worker's API and
    // webhook aliases so a rule on the canonical host cannot be bypassed there.
    if (c.env.APP_ENV === 'production' && new URL(c.req.url).origin !== new URL(c.env.PUBLIC_API_BASE_URL).origin) {
      throw new ApiError(404, 'not_found', 'Not found');
    }
    c.header('Cache-Control', 'no-store');
    await next();
  });

  // Intake sends email; keep its origin gate. Downloads are authorized solely by
  // the bearer token: a native cross-origin POST with no-referrer sends Origin:null.
  privateAccessRoutes.use('/requests', async (c, next) => {
    const origin = c.req.header('origin');
    const allowed = c.env.ALLOWED_ORIGINS.split(',').map((value) => value.trim());
    if (!origin || !allowed.includes(origin)) throw new ApiError(403, 'origin_not_allowed', 'Origin not allowed');
    await next();
  });

  if (Number.isFinite(maxBodyBytes)) privateAccessRoutes.use('*', async (c, next) => {
    const reader = c.req.raw.body?.getReader();
    if (!reader) return next();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBodyBytes) {
          await reader.cancel();
          throw new ApiError(413, 'access_body_too_large', 'This request is too large.');
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    c.req.raw = new Request(c.req.raw, { body: bytes });
    await next();
  });

  privateAccessRoutes.post('/requests', async (c) => {
    if (c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      throw new ApiError(400, 'invalid_access_request', 'Send the request as JSON.');
    }
    const parsed = AccessRequestInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ApiError(400, 'invalid_email', 'Enter a valid email address.');
    await verifyAccessChallenge(c.env, parsed.data.turnstileToken, c.req.header('origin')!, c.req.header('cf-connecting-ip'));
    if (!await admitAccessRequest(c.env, c.req.header('cf-connecting-ip') ?? 'unattributed', maxRequestsPerIpPerHour)) {
      throw new ApiError(429, 'access_request_rate_limited', 'Too many access requests. Please try again later.');
    }
    await requestAccess(c.env, parsed.data.email);
    // Successful new and duplicate requests share one response. Delivery
    // failures remain explicit so a saved-but-unacknowledged request can retry.
    return c.json({ accepted: true }, 202);
  });

  privateAccessRoutes.post('/downloads/redeem', async (c) => {
    const unavailable = () => downloadErrorPage(410);
    if (c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/x-www-form-urlencoded') return unavailable();
    // Only the browser's one-field URL-encoded form is supported. Multipart
    // attachments and repeated fields must never reach the parser or storage.
    const form = new URLSearchParams(await c.req.text());
    if (form.getAll('token').length !== 1 || [...form.keys()].some((key) => key !== 'token')) return unavailable();
    const parsed = DownloadGrantTokenSchema.safeParse(form.get('token'));
    if (!parsed.success || !await availableDownloadGrantExists(c.env.DB, parsed.data)) return unavailable();
    if (!await admitDownloadStart(c.env.DB, parsed.data, maxDownloadStarts)) return downloadErrorPage(429, parsed.data);
    const releases = c.env.DESKTOP_RELEASES;
    if (!releases) return downloadErrorPage(503, parsed.data);
    // Load the stream before claiming. Missing files never burn a grant, and no
    // reusable public R2 URL is returned. The canonical alias moves on publication.
    const object = await releases.get('stable/darwin/arm64/Rally.dmg');
    if (!object) return downloadErrorPage(503, parsed.data);
    if (!await redeemDownloadGrant(c.env.DB, parsed.data)) {
      await object.body.cancel();
      return unavailable();
    }
    return new Response(object.body, {
      headers: {
        'Content-Type': 'application/x-apple-diskimage',
        'Content-Disposition': 'attachment; filename="Rally.dmg"',
        'Content-Length': String(object.size),
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });

  return privateAccessRoutes;
}

export const privateAccessRoutes = createPrivateAccessRoutes();
