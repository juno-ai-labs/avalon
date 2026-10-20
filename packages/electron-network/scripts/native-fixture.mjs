import { app, net, session } from 'electron';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import bridgeModule from './bridge.cjs';
const { createElectronFetch } = bridgeModule;
// The upstream comparison intentionally captures its detached rejection. The
// bridge must produce none; both transport and source errors reach its caller.
const unhandled = [];
process.on('unhandledRejection', error => { unhandled.push(String(error)); });
async function settle() { await new Promise(resolve => setImmediate(() => setImmediate(resolve))); }
app.whenReady().then(async () => {
  const server = createServer((request, response) => {
    if (request.url === '/reset') { request.socket.destroy(); return; }
    if (request.url === '/hold') { response.writeHead(200, { 'Content-Type': 'text/plain', 'X-Content-Type-Options': 'nosniff' }); response.write('partial'); return; }
    let body = '';
    request.on('data', chunk => body += chunk);
    request.on('end', () => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ body, type: request.headers['content-type'] })); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const bridge = createElectronFetch(net);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.url.includes('/blocked') }));
  for (const [name, fetcher] of [['electron', net.fetch.bind(net)], ['bridge', bridge]]) {
    unhandled.length = 0;
    const caught = [];
    await fetcher(`${base}/blocked`, { method: 'POST', body: 'mutation' }).catch(error => caught.push(String(error)));
    await settle();
    await fetcher(`${base}/reset`, { method: 'POST', body: 'mutation' }).catch(error => caught.push(String(error)));
    await settle();
    console.log(JSON.stringify({ name, caught, unhandled }));
    assert.equal(caught.length, 2);
    assert.ok(caught[0].includes('ERR_BLOCKED_BY_CLIENT'));
    assert.ok(caught[1].includes('ERR_EMPTY_RESPONSE'));
    if (name === 'bridge') assert.deepEqual(unhandled, []);
  }
  const result = await bridge(`${base}/echo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"value":1}' });
  assert.deepEqual(await result.json(), { body: '{"value":1}', type: 'application/json' });
  const head = await bridge(`${base}/echo`, { method: 'HEAD' });
  assert.equal(head.body, null);
  const form = new FormData();
  form.set('file', new Blob(['native multipart']), 'fixture.txt');
  const multipart = await (await bridge(`${base}/echo`, { method: 'POST', body: form })).json();
  assert.ok(multipart.type.startsWith('multipart/form-data; boundary='));
  assert.ok(multipart.body.includes('native multipart'));
  const controller = new AbortController();
  const held = await bridge(`${base}/hold`, { signal: controller.signal });
  const interrupted = held.text();
  const expectedInterruption = assert.rejects(interrupted, /caller cancelled/);
  controller.abort(new Error('caller cancelled'));
  await expectedInterruption;
  await settle();
  assert.deepEqual(unhandled, []);
  console.log('native JSON, multipart, HEAD, response streaming and cancellation passed');
  for (const [name, fetcher] of [['electron', net.fetch.bind(net)], ['bridge', bridge]]) {
    unhandled.length = 0;
    const sourceError = new Error('source stream failed');
    const body = new ReadableStream({ start(controller) { controller.error(sourceError); } });
    const request = new Request(`${base}/echo`, { method: 'POST', body, duplex: 'half', // Only the broken upstream comparison needs this abort to settle its fetch.
      signal: AbortSignal.timeout(500) });
    const caught = await fetcher(request).then(() => 'unexpected success', error => String(error));
    await settle();
    console.log(JSON.stringify({ name, scenario: 'source stream failure', caught, unhandled }));
    if (name === 'bridge') {
      assert.equal(caught, 'Error: source stream failed');
      assert.deepEqual(unhandled, []);
    } else {
      assert.ok(unhandled.includes('Error: source stream failed'));
    }
  }
  server.close();
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
