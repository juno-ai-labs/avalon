import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { stopIsolatedProcesses } from './launch-smoke.mjs';
import { isEntryPoint } from './entry-point.mjs';

// Exercise the shipped renderer and its real permission handlers. Chromium's
// fake microphone avoids requiring audio hardware on the Linux build runner.
export async function smokeLinux(executable, screenshot, environment = process.env) {
  const profile = await mkdtemp(join(tmpdir(), 'rally-linux-smoke-'));
  let child;
  let socket;
  let failure;
  try {
    child = spawn(executable, [`--user-data-dir=${profile}`, '--remote-debugging-port=0',
      '--use-fake-device-for-media-stream',
      ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])], { detached: true, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const endpoint = await new Promise((accept, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Linux smoke did not expose CDP: ${output}`)), 30_000);
      const receive = (chunk) => {
        output += chunk.toString();
        const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/u);
        if (match) { clearTimeout(timeout); accept(match[1]); }
      };
      child.stdout.on('data', receive);
      child.stderr.on('data', receive);
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Linux app exited (${code}): ${output}`)); });
    });
    socket = new WebSocket(endpoint);
    await once(socket, 'open');
    let sequence = 0;
    const pending = new Map();
    socket.on('message', (bytes) => {
      const message = JSON.parse(bytes.toString());
      if (!message.id) return;
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timeout);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.accept(message.result);
    });
    const send = (method, params = {}, sessionId) => new Promise((accept, reject) => {
      const id = ++sequence;
      pending.set(id, { accept, reject, timeout: setTimeout(() => {
        pending.delete(id); reject(new Error(`Linux smoke timed out: ${method}`));
      }, 30_000) });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    let target;
    for (let attempt = 0; attempt < 60; attempt++) {
      const { targetInfos } = await send('Target.getTargets');
      target = targetInfos.find((item) => item.type === 'page' && item.url.includes('index.html') && !item.url.includes('surface='));
      if (target) break;
      if (child.exitCode !== null) throw new Error(`Linux app exited: ${output}`);
      await new Promise((accept) => setTimeout(accept, 500));
    }
    if (!target) throw new Error(`Linux main renderer missing: ${output}`);
    const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    // A target exists before its initial navigation commits. Do not start the
    // audio promise in the provisional about:blank execution context.
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const state = await send('Runtime.evaluate', { returnByValue: true,
          expression: "document.readyState === 'complete' && !!document.querySelector('#root')?.textContent" }, sessionId);
        ready = state.result?.value === true;
      } catch (error) {
        if (!/Execution context was destroyed|Cannot find context/u.test(error.message)) throw error;
      }
      if (ready) break;
      await new Promise((accept) => setTimeout(accept, 500));
    }
    if (!ready) throw new Error(`Linux renderer did not mount: ${output}`);
    const result = await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const context = new AudioContext();
      try {
        await context.resume();
        const analyser = context.createAnalyser();
        context.createMediaStreamSource(stream).connect(analyser);
        const samples = new Float32Array(analyser.fftSize);
        for (let i = 0; i < 100; i++) {
          analyser.getFloatTimeDomainData(samples);
          if (samples.some(value => value !== 0)) return { microphone: 'capturing', ui: document.querySelector('#root').textContent.slice(0, 200) };
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('Microphone produced no audio samples');
      } finally { stream.getTracks().forEach(track => track.stop()); await context.close(); }
    })()` }, sessionId);
    if (result.exceptionDetails || result.result?.value?.microphone !== 'capturing') {
      throw new Error(`Linux microphone smoke failed: ${JSON.stringify(result)}`);
    }
    if (screenshot) {
      const capture = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
      await writeFile(screenshot, Buffer.from(capture.data, 'base64'));
    }
    console.log(`Linux packaged renderer and microphone passed: ${JSON.stringify(result.result.value)}`);
    // Electron does not consistently acknowledge CDP Browser.close. The
    // isolated child is terminated and reaped in finally instead.
  } catch (error) { failure = error; }
  try {
    socket?.terminate();
    if (child?.pid) {
      const exited = child.exitCode === null && child.signalCode === null ? once(child, 'exit') : Promise.resolve();
      // AppImage extraction launches another process. Kill the isolated group,
      // not only its launcher, and find detached Crashpad helpers by profile.
      try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await stopIsolatedProcesses(() => new Set(execFileSync('/bin/ps', ['-axo', 'pid=,args='], { encoding: 'utf8' })
        .split('\n').filter((line) => line.includes(profile))
        .map((line) => Number(line.trim().match(/^\d+/u)?.[0])).filter(Number.isSafeInteger)));
      await exited;
      child.stdout.destroy();
      child.stderr.destroy();
    }
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], 'Linux smoke and cleanup failed') : error;
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
  if (failure) throw failure;
}

if (isEntryPoint(import.meta.url)) await smokeLinux(resolve(process.argv[2]), process.argv[3]);
