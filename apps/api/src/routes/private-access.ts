import { AccessRequestInputSchema, DownloadGrantTokenSchema } from '@rally/contracts/private-access';
import { redeemDownloadGrant, availableDownloadGrantExists } from '@rally/db/private-access';
import { Hono } from 'hono';
import type { HonoAppEnv } from '../env';
import { ApiError } from '../lib/api-error';
import { requestAccess } from '../services/access-request-service';

export const privateAccessRoutes = new Hono<HonoAppEnv>();

privateAccessRoutes.use('*', async (c, next) => {
  if (c.env.AVALON_REGION !== 'global') throw new ApiError(404, 'not_found', 'Not found');
  c.header('Cache-Control', 'no-store');
  const origin = c.req.header('origin');
  const allowed = c.env.ALLOWED_ORIGINS.split(',').map((value) => value.trim());
  if (!origin || !allowed.includes(origin)) throw new ApiError(403, 'origin_not_allowed', 'Origin not allowed');
  await next();
});

privateAccessRoutes.post('/requests', async (c) => {
  const parsed = AccessRequestInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError(400, 'invalid_email', 'Enter a valid email address.');
  await requestAccess(c.env, parsed.data.email);
  // Never disclose whether this address was already in the list.
  return c.json({ accepted: true }, 202);
});

privateAccessRoutes.post('/downloads/redeem', async (c) => {
  const form = await c.req.parseBody();
  const parsed = DownloadGrantTokenSchema.safeParse(form.token);
  const unavailable = () => c.text('This download link is invalid, used, expired, or revoked. Ask the sender for a new link.', 410);
  if (!parsed.success || !await availableDownloadGrantExists(c.env.DB, parsed.data)) return unavailable();
  const releases = c.env.DESKTOP_RELEASES;
  if (!releases) return c.text('Downloads are temporarily unavailable. Your link has not been used. Please try again.', 503);
  // Load the stream before claiming. Missing files never burn a grant, and no
  // reusable public R2 URL is returned. The canonical alias moves on publication.
  const object = await releases.get('stable/darwin/arm64/Rally.dmg');
  if (!object) return c.text('Downloads are temporarily unavailable. Your link has not been used. Please try again.', 503);
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
