import { DownloadGrantTokenSchema } from '@rally/contracts/private-access';

/** Fixed copy and a validated capability only; no caller text is interpolated. */
export function downloadErrorPage(status: 410 | 429 | 503, token?: string): Response {
  const retry = status !== 410 && DownloadGrantTokenSchema.safeParse(token).success;
  const title = status === 429 ? 'Please wait before downloading again.' : status === 503 ? 'Your download is temporarily unavailable.' : 'This download link is no longer available.';
  const message = status === 429 ? 'Too many download attempts. Please try again in a minute.' : status === 503
    ? 'Your link has not been used. Please try again.'
    : 'The link may be invalid, used, expired or revoked. Ask the sender for a new link.';
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1"><title>Download Rally</title>
    <style>body{margin:0;background:#f7f7f3;color:#172027;font:17px/1.6 system-ui,sans-serif;display:grid;min-height:100svh;place-items:center}main{max-width:540px;margin:24px;padding:40px;background:white;border:1px solid #ddd;border-radius:16px}h1{font-size:30px;line-height:1.2}a{color:inherit}button{font:inherit;border:0;border-radius:8px;background:#f56b36;color:#fff;padding:12px 20px;cursor:pointer}.brand{font-size:24px;font-weight:700;text-decoration:none}</style>
    </head><body><main><a class="brand" href="https://rallywith.ai/">rally</a>
    <h1>${title}</h1><p>${message}</p>${retry ? `<form method="post" action="/access/downloads/redeem"><input type="hidden" name="token" value="${token}"><button type="submit">Try download again</button></form>` : ''}
    <p><a href="https://rallywith.ai/">Back to Rally</a></p></main></body></html>`, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}
