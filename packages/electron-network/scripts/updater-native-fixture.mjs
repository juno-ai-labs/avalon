import { app } from 'electron';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const updaterRequire = createRequire(process.argv[2]);
const { ElectronHttpExecutor } = updaterRequire(process.argv[2]);
const { CancellationToken } = updaterRequire('builder-util-runtime');
// Observe actual process escapes without letting Electron open its modal error
// box. Either kind of escape fails this native test.
const escaped = [];
process.on('uncaughtException', error => escaped.push(String(error)));
process.on('unhandledRejection', error => escaped.push(String(error)));

app.whenReady().then(async () => {
  let serverResponse;
  const server = createServer((request, response) => {
    serverResponse = response;
    response.writeHead(request.url === '/reading' ? 200 : 404, {
      'Content-Length': '10000',
      'Content-Type': 'text/plain',
      'X-Content-Type-Options': 'nosniff',
    });
    response.write('partial response');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const scenario of ['rejected-feed', 'rejected-download', 'reading']) {
    const executor = new ElectronHttpExecutor();
    const createRequest = executor.createRequest.bind(executor);
    const requestErrors = [];
    let transportFailed;
    const failure = new Promise(resolve => { transportFailed = resolve; });
    executor.createRequest = (options, callback) => {
      const request = createRequest(options, response => {
        // Run the real updater consumer first, including its early HTTP-error
        // return. Drain afterwards so Chromium advances past its data-pipe
        // backpressure and observes the reset. No error listener is added here.
        callback(response);
        response.resume();
        serverResponse.socket.resetAndDestroy();
      });
      request.on('error', error => {
        requestErrors.push(error.message);
        // IncomingMessage.destroy schedules its error on nextTick. Wait for
        // that delivery before deciding whether anything escaped the request.
        setImmediate(() => setImmediate(transportFailed));
      });
      return request;
    };
    const url = new URL(`${base}/${scenario}`);
    const operation = scenario === 'rejected-download'
      ? executor.downloadToBuffer(url, { cancellationToken: new CancellationToken() })
      : executor.request({ protocol: url.protocol, hostname: url.hostname, port: url.port, path: url.pathname });
    await assert.rejects(operation, scenario === 'reading' ? /net::ERR_CONNECTION_RESET/ : /404/);
    await failure;
    assert.deepEqual(escaped, [], `${scenario}: response failure escaped the updater`);
    assert.deepEqual(requestErrors, ['net::ERR_CONNECTION_RESET']);
    console.log(`native updater ${scenario}: reset contained`);
  }
  server.close();
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
