// Measures how smoothly streamed agent text reveals in the work-stream
// transcript, against the running desktop client. The metrics and the numbers
// they produced live in docs/streaming-reveal.md; the injection technique is
// the one docs/dev-environment.md documents under "A real streaming turn".
//
// A synthetic turn is played into the live renderer by dispatching
// stream_started/stream_delta MessageEvents onto the substream socket, with
// the wire cadence produced by a close emulation of the production batcher
// on the work-stream socket path (createSequencedStreamDeltaBatcher in
// apps/api/src/services/integrations.ts, the only batcher), so injected frames have the
// burst shape a real turn has — and a cadence experiment is a driver option
// rather than a server change.
//
// Prerequisites: `pnpm dev:api:local` running, the Electron client up under
// Xvfb with `--remoteDebuggingPort=9222`, and the local development account
// signed in (docs/dev-environment.md §4).
//
// Usage:
//   node scripts/measure-stream-smoothness.mjs '<json-options>'
//
// Options (all optional):
//   label            names the report and screenshot files   ["baseline"]
//   workstreamId     transcript to stream into               [seeded ENG-142]
//   tokensPerSecond  synthetic model speed                   [25]
//   tokenChars       characters per token                    [4]
//   durationSec      length of the streamed turn             [60]
//   prefillChars     text delivered at once before measuring [0]
//   maxDelayMs       emulated batcher maxDelayMs             [100]
//   maxCharacters    emulated batcher maxCharacters          [2048]
//   scrollAwayPx     scroll up this far before streaming     [0]
//   corpus           'mixed' (headings/paragraphs/code/table)
//                    or 'list' (list-dominant reply)         ["mixed"]
//
// Reports, for the measurement window: wire frame inter-arrival and size
// distributions, commit rate (MutationObserver batches over the transcript),
// painted-frame rate and duration distribution via requestAnimationFrame,
// characters revealed per painted frame (the smoothness metric: its
// coefficient of variation and the fraction of frames revealing nothing), and
// PerformanceObserver longtask totals. Output: a JSON summary on stdout, the
// full samples in report-<label>.json, and a screenshot shot-<label>.png,
// both under .stream-measurements/ (gitignored) in the working directory.

/* global window, document, location, requestAnimationFrame, MutationObserver --
   the callbacks handed to page.evaluate run in the renderer, not in Node */

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The sandbox image ships Playwright globally rather than in the repository
// (docs/dev-environment.md — do not add a browser driver as a dependency).
const PLAYWRIGHT_GLOBAL = '/opt/node22/lib/node_modules/playwright/index.mjs';
const { chromium } = await import(PLAYWRIGHT_GLOBAL).catch(() => import('playwright'));

const options = {
  label: 'baseline',
  workstreamId: '00000000-0000-7000-8000-000000000021',
  tokensPerSecond: 25,
  tokenChars: 4,
  durationSec: 60,
  prefillChars: 0,
  maxDelayMs: 100,
  maxCharacters: 2_048,
  scrollAwayPx: 0,
  corpus: 'mixed',
  ...(process.argv[2] ? JSON.parse(process.argv[2]) : {}),
};

const OUTPUT_DIR = '.stream-measurements';
mkdirSync(OUTPUT_DIR, { recursive: true });

// ---------------------------------------------------------------- content ---

// Realistic markdown, because per-commit render cost is dominated by parsing
// and highlighting: headings, emphasis, a list, a fenced code block, a table.
const MARKDOWN_CORPUS = `## Investigating the retry storm

The queue consumer retried the same delivery **four times** in ninety seconds, and each retry re-ran the projection against a row that had already advanced. The fix is to compare the \`authorityGeneration\` before applying, and to treat an equal waterline as a duplicate rather than an update.

- The first delivery applied cleanly and advanced the waterline to 41.
- The redelivery carried waterline 41 again and must be dropped, not reapplied.
- A third copy arrived on the workspace socket and was ordered correctly by the ledger.

Here is the guard as it stands today:

\`\`\`ts
function shouldApply(payload: Versioned, ledger: Ledger): boolean {
  if (payload.generation < ledger.generation) return false;
  if (payload.generation > ledger.generation) return true;
  return payload.waterline > ledger.waterline;
}
\`\`\`

The interesting case is the *half-applied* payload: the common half can be newer while the viewer half is behind, and the receiver applies each half independently. That is deliberate, and the reasoning is recorded in the socket document.

| Path | Carries version | Ordered by |
| --- | --- | --- |
| Control socket | yes | commonWaterline |
| Workspace socket | yes | commonWaterline |
| Queue projection | yes | source version |

What remains is the reconnect window: a client that was away does not get the gap replayed frame by frame, so the snapshot has to be sufficient on its own. The next step is to verify the resume path against a room that compacted while the client was away, and to write the numbers down before changing anything.

`;

// The list-dominant shape: every candidate blank-line boundary is a list
// line, so the splitter's per-item cuts are the only thing standing between
// this reply and a whole-body re-parse per commit.
const LIST_CORPUS = `Here is the plan for the migration, step by step:

${Array.from({ length: 12 }, (_, index) => `- Step ${index + 1}: a full sentence describing what this step does, which system it touches, and the check that proves it landed.\n\n`).join('')}${Array.from({ length: 12 }, (_, index) => `${index + 1}. Verify item ${index + 1} against the checklist with enough words to make the parser do real work.\n`).join('')}
`;

function buildTokens(totalChars, tokenChars) {
  const corpus = options.corpus === 'list' ? LIST_CORPUS : MARKDOWN_CORPUS;
  let text = '';
  while (text.length < totalChars) text += corpus;
  text = text.slice(0, totalChars);
  const tokens = [];
  for (let index = 0; index < text.length; index += tokenChars) {
    tokens.push(text.slice(index, index + tokenChars));
  }
  return tokens;
}

// ------------------------------------------------------ batcher emulation ---

// Behavioural copy of createSequencedStreamDeltaBatcher, the one batcher on
// the work-stream socket path: a push flushes when the window has passed since
// the last flush, and a trailing timer sends held text at the window's end when
// no later push does. Token i arrives at i * interval on the simulated clock.
function scheduleFrames(tokens, tokenIntervalMs, { maxCharacters, maxDelayMs }) {
  const frames = [];
  const batcher = { pending: '', last: 0 };
  const send = (at) => {
    frames.push({ at, delta: batcher.pending });
    batcher.pending = '';
    batcher.last = at;
  };
  tokens.forEach((token, index) => {
    const at = index * tokenIntervalMs;
    const deadline = batcher.last + maxDelayMs;
    if (batcher.pending && deadline < at) send(deadline);
    batcher.pending += token;
    if (batcher.pending.length >= maxCharacters || at - batcher.last >= maxDelayMs) send(at);
  });
  if (batcher.pending) send(Math.min(batcher.last + maxDelayMs, tokens.length * tokenIntervalMs));
  return frames;
}

// ------------------------------------------------------------- statistics ---

function percentile(sorted, share) {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((share / 100) * sorted.length) - 1));
  return sorted[index];
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  const mean = sum / (sorted.length || 1);
  const variance = sorted.reduce((total, value) => total + (value - mean) ** 2, 0) / (sorted.length || 1);
  return {
    n: sorted.length,
    mean: Number(mean.toFixed(2)),
    sd: Number(Math.sqrt(variance).toFixed(2)),
    cv: Number((Math.sqrt(variance) / (mean || 1)).toFixed(3)),
    p50: Number((percentile(sorted, 50) ?? 0).toFixed(2)),
    p95: Number((percentile(sorted, 95) ?? 0).toFixed(2)),
    max: Number((sorted.at(-1) ?? 0).toFixed(2)),
  };
}

// ------------------------------------------------------------------- main ---

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const context = browser.contexts()[0];
const page = context.pages().find((candidate) => candidate.url().startsWith('http'));
if (!page) throw new Error('no renderer page found — is the client running with --remoteDebuggingPort=9222?');

// The wrapper must exist before the app opens its sockets, so it is installed
// as an init script and the page reloaded onto the target work stream.
await context.addInitScript(() => {
  window.__wsList = [];
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(...args) {
      super(...args);
      window.__wsList.push(this);
    }
  };
});
await page.evaluate((id) => { location.hash = `#/workstreams/${id}`; }, options.workstreamId);
await page.reload({ waitUntil: 'load' });
// In-page timers are throttled when the window is occluded; the reveal loop
// and the paint sampler both need a foreground window.
await page.bringToFront();

await page.waitForFunction(() => (window.__wsList ?? []).some(
  (sock) => sock.url.includes('/substreams/0') && sock.readyState === 1,
), null, { timeout: 30_000 });
await page.waitForTimeout(1_500);

// The screen can open at the unread anchor, which deliberately does not
// follow. The baseline is the reader watching the stream, so go to the end
// first; a scrolled-away variant then pulls back from there.
const jump = page.locator('button.jump-bottom');
if (await jump.count()) {
  await jump.click();
  await page.waitForTimeout(800);
}

if (options.scrollAwayPx > 0) {
  await page.evaluate((px) => {
    const element = document.querySelector('.transcript-scroll');
    element.scrollTop = Math.max(0, element.scrollTop - px);
  }, options.scrollAwayPx);
  await page.waitForTimeout(300);
}

await page.evaluate(() => {
  window.__metrics = { wire: [], raf: [], mutations: [], longtasks: [] };
  const streamBody = () => document.querySelector('.message-block.is-streaming');
  let rafOn = true;
  const loop = (timestamp) => {
    if (!rafOn) return;
    const element = streamBody();
    window.__metrics.raf.push([timestamp, element ? element.textContent.length : -1]);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  const mutationObserver = new MutationObserver(() => {
    window.__metrics.mutations.push(performance.now());
  });
  mutationObserver.observe(document.querySelector('.transcript-scroll'), {
    subtree: true, childList: true, characterData: true,
  });
  const longtaskObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) window.__metrics.longtasks.push([entry.startTime, entry.duration]);
  });
  longtaskObserver.observe({ entryTypes: ['longtask'] });
  window.__stopMetrics = () => {
    rafOn = false;
    mutationObserver.disconnect();
    longtaskObserver.disconnect();
  };
  window.__inject = (frame) => {
    const sock = (window.__wsList ?? []).filter(
      (candidate) => candidate.url.includes('/substreams/0') && candidate.readyState === 1,
    ).at(-1);
    if (!sock) return 'no-socket';
    window.__metrics.wire.push([performance.now(), frame.delta ? frame.delta.length : 0, frame.type]);
    sock.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }));
    return 'ok';
  };
});

const messageId = randomUUID();
const harnessRunId = randomUUID();
const turnId = `measure-${Date.now()}`;
// The room drops any frame at or below its current sequence; wall-clock
// milliseconds exceed every seeded room's sequence and stay monotonic across
// runs against the same page.
let sequence = Date.now();
let streamSeq = 0;
const frame = (extra) => ({
  sequence: ++sequence,
  occurredAt: new Date().toISOString(),
  messageId,
  turnId,
  epoch: 0,
  streamSeq: ++streamSeq,
  reset: false,
  ...extra,
});

const started = await page.evaluate((f) => window.__inject(f), frame({ type: 'stream_started', harnessRunId }));
if (started !== 'ok') throw new Error(`stream_started not injected: ${started}`);

if (options.prefillChars > 0) {
  const prefill = buildTokens(options.prefillChars, options.prefillChars)[0];
  await page.evaluate((f) => window.__inject(f), frame({ type: 'stream_delta', harnessRunId, delta: prefill }));
  await page.waitForTimeout(1_500); // let the large commit settle before the window opens
}

const tokenIntervalMs = 1000 / options.tokensPerSecond;
const totalChars = Math.round(options.durationSec * options.tokensPerSecond * options.tokenChars);
const tokens = buildTokens(totalChars, options.tokenChars);
const schedule = scheduleFrames(tokens, tokenIntervalMs, options);

const measureStart = await page.evaluate(() => performance.now());
const driveStart = Date.now();
let missedDeadlines = 0;
for (const entry of schedule) {
  const wait = entry.at - (Date.now() - driveStart);
  if (wait > 4) await new Promise((resolve) => setTimeout(resolve, wait));
  else if (wait < -50) missedDeadlines += 1;
  const result = await page.evaluate(
    (f) => window.__inject(f),
    frame({ type: 'stream_delta', harnessRunId, delta: entry.delta }),
  );
  if (result !== 'ok') throw new Error(`frame not injected: ${result}`);
}
const measureEnd = await page.evaluate(() => performance.now());
await page.screenshot({ path: join(OUTPUT_DIR, `shot-${options.label}.png`) });
await page.evaluate(() => window.__stopMetrics());
const metrics = await page.evaluate(() => window.__metrics);

// ---------------------------------------------------------------- analyse ---

const inWindow = ([t]) => t >= measureStart && t <= measureEnd;
const wire = metrics.wire.filter(inWindow).filter(([, , type]) => type === 'stream_delta');
const wireGaps = wire.slice(1).map(([t], index) => t - wire[index][0]);
const wireChars = wire.map(([, chars]) => chars);

const raf = metrics.raf.filter(inWindow).filter(([, length]) => length >= 0);
const rafGaps = raf.slice(1).map(([t], index) => t - raf[index][0]);
const revealed = raf.slice(1).map(([, length], index) => Math.max(0, length - raf[index][1]));
const nonZero = revealed.filter((value) => value > 0);

const mutations = metrics.mutations.filter((t) => t >= measureStart && t <= measureEnd);
const longtasks = metrics.longtasks.filter(inWindow);
const windowSec = (measureEnd - measureStart) / 1000;

const report = {
  options,
  windowSec: Number(windowSec.toFixed(1)),
  driverMissedDeadlines: missedDeadlines,
  wire: {
    frames: wire.length,
    framesPerSec: Number((wire.length / windowSec).toFixed(2)),
    interArrivalMs: stats(wireGaps),
    charsPerFrame: stats(wireChars),
  },
  commits: {
    mutationBatches: mutations.length,
    perSec: Number((mutations.length / windowSec).toFixed(2)),
  },
  paint: {
    frames: raf.length,
    perSec: Number((raf.length / windowSec).toFixed(2)),
    frameDurationMs: stats(rafGaps),
    droppedFrameFraction: Number((rafGaps.filter((gap) => gap > 25).length / (rafGaps.length || 1)).toFixed(3)),
  },
  reveal: {
    charsPerPaintedFrame: stats(revealed),
    zeroRevealFrameFraction: Number((revealed.filter((value) => value === 0).length / (revealed.length || 1)).toFixed(3)),
    burstSizeWhenNonZero: stats(nonZero),
  },
  longtasks: {
    count: longtasks.length,
    totalMs: Number(longtasks.reduce((total, [, duration]) => total + duration, 0).toFixed(0)),
    durations: stats(longtasks.map(([, duration]) => duration)),
  },
};

writeFileSync(join(OUTPUT_DIR, `report-${options.label}.json`), JSON.stringify({ report, metrics }, null, 1));
console.log(JSON.stringify(report, null, 2));
await browser.close();
