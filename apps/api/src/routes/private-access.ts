import { AccessRequestInputSchema, DownloadGrantTokenSchema } from '@rally/contracts/private-access';
import { redeemDownloadGrant, availableDownloadGrantExists } from '@rally/db/private-access';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { admitAccessRequest, MAX_ACCESS_REQUESTS_PER_IP_PER_HOUR, MAX_PRIVATE_ACCESS_REQUEST_BYTES } from '../services/access-request-limits';
import { downloadErrorPage } from '../services/download-error-page';
import type { HonoAppEnv } from '../env';
import { ApiError } from '../lib/api-error';
import { requestAccess } from '../services/access-request-service';

export function createPrivateAccessRoutes(
  maxRequestsPerIpPerHour = MAX_ACCESS_REQUESTS_PER_IP_PER_HOUR,
  maxBodyBytes = MAX_PRIVATE_ACCESS_REQUEST_BYTES,
) {
  const privateAccessRoutes = new Hono<HonoAppEnv>();

  privateAccessRoutes.use('*', async (c, next) => {
    if (c.env.AVALON_REGION !== 'global') throw new ApiError(404, 'not_found', 'Not found');
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

  if (Number.isFinite(maxBodyBytes)) privateAccessRoutes.use('*', bodyLimit({
    maxSize: maxBodyBytes,
    onError: () => { throw new ApiError(413, 'access_body_too_large', 'This request is too large.'); },
  }));

  privateAccessRoutes.post('/requests', async (c) => {
    const parsed = AccessRequestInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ApiError(400, 'invalid_email', 'Enter a valid email address.');
    if (!await admitAccessRequest(c.env, c.req.header('cf-connecting-ip') ?? 'unattributed', maxRequestsPerIpPerHour)) {
      throw new ApiError(429, 'access_request_rate_limited', 'Too many access requests. Please try again later.');
    }
    await requestAccess(c.env, parsed.data.email);
    // Never disclose whether this address was already in the list.
    return c.json({ accepted: true }, 202);
  });

  privateAccessRoutes.post('/downloads/redeem', async (c) => {
    const form = await c.req.parseBody();
    const parsed = DownloadGrantTokenSchema.safeParse(form.token);
    const unavailable = () => downloadErrorPage(410);
    if (!parsed.success || !await availableDownloadGrantExists(c.env.DB, parsed.data)) return unavailable();
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
