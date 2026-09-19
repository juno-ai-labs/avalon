import { createServer } from 'node:http';
import { z } from 'zod';
import { HttpsUrlSchema } from '@rally/contracts/url-schemas';

const StartSchema = z.object({ url: HttpsUrlSchema, attemptId: z.string().min(1) });
/** Same lifetime as ConnectionService's sealed OAuth attempt, not a second lease. */
const OAUTH_ATTEMPT_MS = 10 * 60_000;

/** Codes stay in main; PKCE, client credentials and tokens stay in the API. */
export async function startCanvaConnection(deps: {
  request: (path: string, body: unknown) => Promise<unknown>;
  openExternal: (url: string) => Promise<void>;
  onClose?: (close: () => void) => void;
}): Promise<z.infer<typeof StartSchema>> {
  let expectedState: string | null = null;
  let used = false;
  const server = createServer((request, response) => {
    let url: URL;
    try { url = new URL(request.url ?? '/', 'http://127.0.0.1'); }
    catch { response.writeHead(400).end('Invalid callback'); return; }
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'none'");
    if (request.method !== 'GET' || url.pathname !== '/callback') {
      response.writeHead(404).end('Not found'); return;
    }
    if (!expectedState || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== expectedState) {
      response.writeHead(400).end('Invalid authorization state'); return;
    }
    if (used) { response.writeHead(409).end('Authorization already received'); return; }
    const code = url.searchParams.get('code');
    if (url.searchParams.getAll('code').length > 1 || url.searchParams.getAll('error').length > 1
      || Boolean(code) === url.searchParams.has('error')) {
      response.writeHead(400).end('Missing authorization code'); return;
    }
    used = true;
    void deps.request('/connections/canva/complete', {
      ...(code ? { code } : { error: 'access_denied' }), state: expectedState,
    }).then(() => {
      response.end(code ? 'Canva connected. Return to Rally.' : 'Canva connection cancelled. Return to Rally.');
    }, () => {
      response.writeHead(502).end('Canva connection failed. Return to Rally and try again.');
    }).finally(close);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  function close() {
    clearTimeout(timer);
    server.close();
    server.closeIdleConnections();
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    timer = setTimeout(close, OAUTH_ATTEMPT_MS);
    timer.unref();
    deps.onClose?.(close);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Canva callback listener unavailable');
    const redirectUri = `http://127.0.0.1:${address.port}/callback`;
    const start = StartSchema.parse(await deps.request('/connections/canva/start?telemetryVersion=2&desktopHandoffVersion=2', {
      scope: 'personal', capabilities: ['canva.personal.mcp'], loopbackRedirectUri: redirectUri,
    }));
    const authorization = new URL(start.url);
    if (authorization.origin !== 'https://mcp.canva.com' || authorization.pathname !== '/authorize') {
      throw new Error('Unexpected Canva authorization URL');
    }
    if (authorization.searchParams.get('redirect_uri') === redirectUri) {
      expectedState = authorization.searchParams.get('state');
      if (!expectedState) throw new Error('Canva authorization state missing');
    } else {
      // Server callback mode after allowlisting: the temporary listener is unused.
      close();
    }
    await deps.openExternal(start.url);
    return start;
  } catch (error) {
    close();
    throw error;
  }
}
