import { Readable } from 'node:stream';

interface ElectronResponseHead {
  readonly statusCode: number;
  readonly statusMessage: string;
  readonly headers: Record<string, string | string[]>;
}

export interface ElectronRequestPort {
  on(event: 'response', listener: (response: ElectronResponseHead) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'abort', listener: () => void): unknown;
  setHeader(name: string, value: string): void;
  write(chunk: Buffer, encoding: string | undefined, callback: (error?: Error) => void): unknown;
  end(): unknown;
  abort(): void;
}

/** Only the Chromium networking capabilities consumed by the HTTP bridge. */
export interface ElectronFetchTransport {
  fetch(input: Request): Promise<Response>;
  request(options: {
    url: string;
    method: string;
    redirect: RequestRedirect;
    credentials: RequestCredentials;
    origin?: string;
    cache: RequestCache;
    referrerPolicy: ReferrerPolicy;
  }): ElectronRequestPort;
}

/**
 * Electron 43.2.0 net.fetch leaves req.body.pipeTo(...).then(...) unhandled.
 * Own that upload here so every failure rejects the caller's request instead
 * of creating a second process-level rejection. HTTP responses always have an
 * error owner, including HEAD/204. Custom protocols stay Electron-owned.
 */
export function createElectronFetch(transport: ElectronFetchTransport): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    const body = request.body;
    if (!['http:', 'https:'].includes(new URL(request.url).protocol)) return transport.fetch(request);

    const origin = request.headers.get('origin');
    const client = transport.request({
      url: request.url,
      method: request.method,
      redirect: request.redirect,
      credentials: request.credentials === 'same-origin' && !origin ? 'include' : request.credentials,
      ...(origin ? { origin } : {}),
      cache: request.cache,
      referrerPolicy: request.referrerPolicy,
    });

    return new Promise<Response>((resolve, reject) => {
      const upload = new AbortController();
      let responseStream: Readable | undefined;
      const cleanup = () => request.signal.removeEventListener('abort', abort);
      const fail = (error: unknown) => {
        cleanup();
        reject(error);
        upload.abort(error);
        if (error instanceof Error) responseStream?.destroy(error);
      };
      const abort = () => {
        fail(request.signal.reason);
        // Abort after headers must also reject an in-progress response read.
        responseStream?.destroy(request.signal.reason instanceof Error ? request.signal.reason : undefined);
        client.abort();
      };
      client.on('error', fail);
      client.on('abort', () => fail(new DOMException('The operation was aborted.', 'AbortError')));
      client.on('response', (response) => {
        try {
          // Electron's public types omit its Node Readable base class. Check
          // the actual SDK boundary instead of asserting an incomplete type.
          if (!(response instanceof Readable)) throw new TypeError('Electron response is not a Readable');
          responseStream = response;
          response.on('end', cleanup);
          response.on('close', () => {
            cleanup();
            if (!response.readableEnded) client.abort();
          });
          response.on('error', fail);
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            for (const entry of Array.isArray(value) ? value : [value]) headers.append(name, entry);
          }
          const noBody = request.method === 'HEAD' || [101, 204, 205, 304].includes(response.statusCode);
          // Node and DOM describe the same web-stream protocol separately.
          const body = noBody ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>;
          const result = new Response(body, { status: response.statusCode, statusText: response.statusMessage, headers });
          if (noBody) response.resume();
          resolve(result);
        } catch (error) {
          fail(error);
          client.abort();
        }
      });
      request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted) {
        abort();
        return;
      }

      try {
        for (const [name, value] of request.headers) client.setHeader(name, value);
        if (request.mode !== 'cors' || origin) client.setHeader('Sec-Fetch-Mode', request.mode);
        if (!body) {
          client.end();
          return;
        }
        const writable = new WritableStream<Uint8Array>({
          write: (chunk) => new Promise<void>((written, failed) => {
            client.write(Buffer.from(chunk), undefined, (error) => error ? failed(error) : written());
          }),
          close: () => { client.end(); },
          abort: (reason) => {
            fail(reason);
            client.abort();
          },
        });
        // The catch is essential: callers cannot observe Electron's detached
        // pipeTo promise through the fetch promise, even with try/catch.
        void body.pipeTo(writable, { signal: upload.signal }).catch((error: unknown) => {
          fail(error);
          client.abort();
        });
      } catch (error) {
        fail(error);
        client.abort();
      }
    });
  };
}
