import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createElectronFetch, type ElectronFetchTransport, type ElectronRequestPort } from './index';

// Chromium cannot run inside Vitest's Node process. Double only its request
// capability; Request, Response, Node streams and the upload pipe are real.
class RequestPort extends EventEmitter implements ElectronRequestPort {
  readonly headers = new Headers();
  readonly chunks: Buffer[] = [];
  private endUpload: () => void = () => {};
  readonly ended = new Promise<void>((resolve) => { this.endUpload = resolve; });
  readonly abort = vi.fn(() => { this.emit('abort'); });
  writeFailure?: Error;

  setHeader(name: string, value: string): void { this.headers.set(name, value); }
  write(chunk: Buffer, _encoding: string | undefined, callback: (error?: Error) => void): void {
    this.chunks.push(chunk);
    callback(this.writeFailure);
  }
  end(): void { this.endUpload(); }
}

function setup() {
  const client = new RequestPort();
  const fetch = vi.fn<ElectronFetchTransport['fetch']>(async () => new Response('bodyless'));
  const request = vi.fn<ElectronFetchTransport['request']>(() => client);
  const transport = { fetch, request } satisfies ElectronFetchTransport;
  return { client, transport, fetch: createElectronFetch(transport) };
}

function response(statusCode = 200, text = 'response') {
  return Object.assign(Readable.from([Buffer.from(text)]), {
    statusCode,
    statusMessage: statusCode === 200 ? 'OK' : 'No Content',
    headers: { 'content-type': 'text/plain', 'set-cookie': ['a=1', 'b=2'] },
  });
}

describe('Electron upload bridge', () => {
  it('delegates custom-protocol fetches to Electron', async () => {
    const { fetch, transport } = setup();
    expect(await (await fetch('file:///app/icon.png')).text()).toBe('bodyless');
    expect(transport.fetch.mock.calls[0]?.[0].url).toBe('file:///app/icon.png');
    expect(transport.request).not.toHaveBeenCalled();
  });

  it.each(['GET', 'HEAD'])('owns a bodyless %s request and response errors', async (method) => {
    const { fetch, client, transport } = setup();
    const pending = fetch('https://api.example/read', { method });
    await client.ended;
    const stream = response();
    client.emit('response', stream);
    const result = await pending;
    expect(transport.fetch).not.toHaveBeenCalled();
    if (method === 'HEAD') expect(result.body).toBeNull();
    else expect(await result.text()).toBe('response');
    // Even null-body responses must own native stream errors.
    stream.emit('error', new Error('net::ERR_NETWORK_CHANGED'));
  });

  it('sends a JSON mutation once and streams the response', async () => {
    const { fetch, client, transport } = setup();
    const pending = fetch('https://api.example/command', {
      method: 'PATCH', headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' },
      body: '{"value":1}', credentials: 'omit', redirect: 'error', cache: 'no-store',
    });
    await client.ended;
    expect(Buffer.concat(client.chunks).toString()).toBe('{"value":1}');
    expect(client.headers.get('authorization')).toBe('Bearer fixture');
    expect(transport.request).toHaveBeenCalledExactlyOnceWith({
      url: 'https://api.example/command', method: 'PATCH', credentials: 'omit',
      redirect: 'error', cache: 'no-store', referrerPolicy: '',
    });
    client.emit('response', response());
    const result = await pending;
    expect(result.status).toBe(200);
    expect(result.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
    expect(await result.text()).toBe('response');
  });

  it('serializes multipart bodies with their generated boundary', async () => {
    const { fetch, client } = setup();
    const form = new FormData();
    form.set('dump', new Blob(['fixture dump']), 'dump.dmp');
    const pending = fetch('https://api.example/upload', { method: 'POST', body: form });
    await client.ended;
    const type = client.headers.get('content-type');
    expect(type).toMatch(/^multipart\/form-data; boundary=/u);
    const bytes = Buffer.concat(client.chunks).toString();
    expect(bytes).toContain(`--${type?.split('boundary=')[1]}`);
    expect(bytes).toContain('filename="dump.dmp"');
    expect(bytes).toContain('fixture dump');
    client.emit('response', response(204, ''));
    const result = await pending;
    expect(result.body).toBeNull();
  });

  it.each([
    'ERR_CONNECTION_RESET', 'ERR_NETWORK_CHANGED', 'ERR_NETWORK_IO_SUSPENDED',
    'ERR_INTERNET_DISCONNECTED', 'ERR_NAME_NOT_RESOLVED', 'ERR_PROXY_CONNECTION_FAILED',
    'ERR_CERT_AUTHORITY_INVALID', 'ERR_TIMED_OUT', 'ERR_FUTURE_TRANSPORT_FAILURE',
  ])('delivers %s to the caller without replay or an unhandled upload rejection', async (code) => {
    const { fetch, client, transport } = setup();
    const error = new Error(`net::${code}`);
    // Failure during upload rejects both the request and the real pipeTo.
    client.writeFailure = error;
    const pending = fetch('https://api.example/write', { method: 'POST', body: 'mutation' });
    await expect(pending).rejects.toBe(error);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(transport.request).toHaveBeenCalledTimes(1);
    expect(transport.fetch).not.toHaveBeenCalled();
    expect(client.abort).toHaveBeenCalled();
    // Vitest fails this test file on any detached, unhandled rejection.
  });

  it('rejects network failure after upload but before headers', async () => {
    const { fetch, client } = setup();
    const pending = fetch('https://api.example/write', { method: 'POST', body: 'mutation' });
    const rejected = expect(pending).rejects.toThrow('net::ERR_CONNECTION_CLOSED');
    await client.ended;
    client.emit('error', new Error('net::ERR_CONNECTION_CLOSED'));
    await rejected;
  });

  it('rejects a response read interrupted after headers', async () => {
    const { fetch, client } = setup();
    const pending = fetch('https://api.example/write', { method: 'POST', body: 'mutation' });
    await client.ended;
    const stream = Object.assign(new Readable({ read() {} }), {
      statusCode: 200, statusMessage: 'OK', headers: {},
    });
    client.emit('response', stream);
    const result = await pending;
    const read = result.text();
    const rejected = expect(read).rejects.toThrow('net::ERR_CONNECTION_CLOSED');
    client.emit('error', new Error('net::ERR_CONNECTION_CLOSED'));
    await rejected;
  });

  it('rejects a failed source stream and cancels the native request', async () => {
    const { fetch, client } = setup();
    const body = new ReadableStream({ start(controller) { controller.error(new Error('source failed')); } });
    const request = new Request('https://api.example/write', { method: 'POST', body, duplex: 'half' } as RequestInit);
    await expect(fetch(request)).rejects.toThrow('source failed');
    expect(client.abort).toHaveBeenCalled();
  });

  it('rejects an already aborted request without opening a connection', async () => {
    const { fetch, transport } = setup();
    const controller = new AbortController();
    const error = new Error('cancelled');
    controller.abort(error);
    await expect(fetch('https://api.example/write', { method: 'POST', body: 'mutation', signal: controller.signal })).rejects.toBe(error);
    expect(transport.request).not.toHaveBeenCalled();
    expect(transport.fetch).not.toHaveBeenCalled();
  });

  it('aborts a response read when the caller cancels after headers', async () => {
    const { fetch, client } = setup();
    const controller = new AbortController();
    const pending = fetch('https://api.example/write', { method: 'POST', body: 'mutation', signal: controller.signal });
    await client.ended;
    client.emit('response', Object.assign(new Readable({ read() {} }), {
      statusCode: 200, statusMessage: 'OK', headers: {},
    }));
    const result = await pending;
    const rejected = expect(result.text()).rejects.toThrow('cancelled');
    controller.abort(new Error('cancelled'));
    await rejected;
    expect(client.abort).toHaveBeenCalled();
  });
});
