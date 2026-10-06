#!/usr/bin/env node
// Renders a rally-motion scene with headless Chromium and ffmpeg.
//
//   node render.mjs <scene.html> --preview 0,2.5,6     contact sheet of those instants
//   node render.mjs <scene.html> --video [--score score.mjs] [--out film.mp4]
//
// --video writes the film plus <out>-check.png, one frame per second, to look at
// before anyone else does. Needs Playwright (global install) and ffmpeg.
import { execFileSync, execSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const scene = args.find(a => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
const opt = name => { const i = args.indexOf('--' + name); return i < 0 ? null : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
if (!scene || !(opt('preview') || opt('video'))) {
  console.error('usage: render.mjs <scene.html> --preview t1,t2,... | --video [--score score.mjs] [--out film.mp4]');
  process.exit(2);
}
const scenePath = path.resolve(scene);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rally-motion-'));

function loadPlaywright() {
  const roots = [process.cwd()];
  try { roots.push(execSync('npm root -g', { encoding: 'utf8' }).trim()); } catch { /* no npm */ }
  for (const r of roots) { try { return createRequire(path.join(r, 'noop.js'))('playwright'); } catch { /* next */ } }
  throw new Error('Playwright not found: it is preinstalled globally on the sandbox image (do not add it to the repo)');
}
async function openScene() {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });
  const page = await browser.newPage();
  page.on('console', m => { if (m.type() === 'warning' || m.type() === 'error') console.log(`[scene ${m.type()}] ${m.text()}`); });
  page.on('pageerror', e => console.log('[scene error]', e.message));
  await page.goto('file://' + scenePath);
  await page.waitForFunction('window.ready === true', null, { timeout: 30000 });
  const info = await page.evaluate(() => window.STAGE_INFO);
  await page.setViewportSize({ width: info.width, height: info.height });
  return { browser, page, info };
}
const grab = (page, f) => page.evaluate(i => { window.renderFrame(i); return window.grab(); }, f).then(d => Buffer.from(d.split(',')[1], 'base64'));
function sheet(files, outFile, cols) {
  files.forEach((f, i) => fs.copyFileSync(f, path.join(work, `s_${String(i).padStart(3, '0')}.png`)));
  const rows = Math.ceil(files.length / cols);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', path.join(work, 's_%03d.png'), '-vf', `scale=${Math.round(1920 / cols)}:-2,tile=${cols}x${rows}:color=0x333333`, '-frames:v', '1', outFile]);
  return outFile;
}

const { browser, page, info } = await openScene();
console.log(`scene ${info.width}x${info.height} @${info.fps}fps, ${info.duration}s`);

if (opt('preview')) {
  const times = String(opt('preview')).split(',').map(Number);
  const files = [];
  for (const t of times) { const f = path.join(work, `p_${t.toFixed(2)}.png`); fs.writeFileSync(f, await grab(page, Math.round(t * info.fps))); files.push(f); }
  const out = opt('out') && opt('out') !== true ? opt('out') : scenePath.replace(/\.html$/, '-preview.png');
  console.log('preview:', sheet(files, out, Math.min(4, files.length)));
}

if (opt('video')) {
  const out = path.resolve(opt('out') && opt('out') !== true ? opt('out') : scenePath.replace(/\.html$/, '.mp4'));
  let wav = null;
  if (opt('score')) {
    wav = path.join(work, 'score.wav');
    execFileSync('node', [path.resolve(opt('score'))], { env: { ...process.env, OUT_WAV: wav }, stdio: 'inherit' });
  }
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(info.fps), '-c:v', 'png', '-i', '-',
    ...(wav ? ['-i', wav] : []),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-tune', 'animation',
    ...(wav ? ['-c:a', 'aac', '-b:a', '320k', '-shortest'] : []), '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  const total = Math.round(info.duration * info.fps), t0 = Date.now();
  const checks = [];
  for (let f = 0; f < total; f++) {
    const png = await grab(page, f);
    if (f % info.fps === Math.floor(info.fps / 2)) { const c = path.join(work, `c_${f}.png`); fs.writeFileSync(c, png); checks.push(c); }
    if (!ff.stdin.write(png)) await new Promise(r => ff.stdin.once('drain', r));
    if (f % (info.fps * 5) === 0) console.log(`frame ${f}/${total}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  ff.stdin.end(); await new Promise(r => ff.on('close', r));
  console.log('video:', out);
  console.log('check sheet (one frame per second, read it):', sheet(checks, out.replace(/\.mp4$/, '-check.png'), 5));
}
await browser.close();
fs.rmSync(work, { recursive: true, force: true });
