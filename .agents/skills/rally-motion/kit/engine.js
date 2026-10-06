// Rally motion engine: a deterministic canvas stage that renders any time t,
// with motion blur, grain and a vignette. Loaded as a classic script (file://
// pages cannot import ES modules), so everything here is a plain global.
//
// A scene calls stage({...}) once, then start(frame) with its frame(ctx, t).
// render.mjs drives it through window.renderFrame(i) and window.grab().

let W = 1080, H = 1080; // design space every scene draws in
let OS = 1; // output pixels per design unit
let FPS = 60, DUR = 15;
let out, ctxO, sub, ctxS;
const STAGE = { sub: 5, shutter: 0.5, grain: 0.05, vignette: 0.35, bg: '#070707' };
let FRAME = null;

/**
 * w, h: design space. outW: output width in pixels (height follows the ratio).
 * X specs: 1200x1200 for 1:1, 1920x1080 for 16:9.
 */
function stage({ w, h, outW, fps = 60, duration, sub: subframes = 5, shutter = 0.5, grain = 0.05, vignette = 0.35, bg = '#070707' }) {
  W = w; H = h; OS = outW / w; FPS = fps; DUR = duration;
  Object.assign(STAGE, { sub: subframes, shutter, grain, vignette, bg });
  out = document.createElement('canvas');
  out.width = Math.round(w * OS); out.height = Math.round(h * OS);
  document.body.appendChild(out);
  ctxO = out.getContext('2d');
  sub = new OffscreenCanvas(out.width, out.height); ctxS = sub.getContext('2d');
  window.STAGE_INFO = { width: out.width, height: out.height, fps, duration };
}

// ---------- math ----------
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const prog = (t, a, b) => clamp((t - a) / (b - a));
const eo3 = t => 1 - Math.pow(1 - t, 3);
const eo5 = t => 1 - Math.pow(1 - t, 5);
const eoX = t => t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
const eiX = t => t <= 0 ? 0 : Math.pow(2, 10 * t - 10);
const eio3 = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const eio5 = t => t < .5 ? 16 * t ** 5 : 1 - Math.pow(-2 * t + 2, 5) / 2;
const linear = t => t;
// damped spring; x is seconds since the spring started. Overshoots once, settles.
const spring = (x, w = 20, z = 0.45) => x <= 0 ? 0 : 1 - Math.exp(-z * w * x) * Math.cos(w * Math.sqrt(1 - z * z) * x);
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const val = (v, t) => typeof v === 'function' ? v(t) : v;
/**
 * Keyframes: [[time, value, ease?], ...]. A value may be a number, an array, or
 * a function of t (so a key can follow something that moves). The ease applies
 * to the segment arriving at that key.
 */
function kf(t, keys) {
  if (t <= keys[0][0]) return val(keys[0][1], t);
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1, e = eio3] = keys[i];
    if (t <= t1) {
      const [t0, v0] = keys[i - 1];
      const p = e(prog(t, t0, t1));
      const a = val(v0, t), b = val(v1, t);
      return Array.isArray(a) ? a.map((x, j) => lerp(x, b[j], p)) : lerp(a, b, p);
    }
  }
  return val(keys[keys.length - 1][1], t);
}
function rgba(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${n >> 8 & 255},${n & 255},${a})`; }

// ---------- drawing ----------
function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }
function text(ctx, s, x, y, font, color, align = 'left', ls = 0) {
  ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
  ctx.letterSpacing = ls + 'px'; ctx.fillText(s, x, y); ctx.letterSpacing = '0px';
}
function measure(ctx, s, font, ls = 0) { ctx.font = font; ctx.letterSpacing = ls + 'px'; const w = ctx.measureText(s).width; ctx.letterSpacing = '0px'; return w; }
function wrap(ctx, s, font, maxW) {
  ctx.font = font; const words = s.split(' '); const lines = []; let cur = '', start = 0, idx = 0;
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (ctx.measureText(test).width > maxW && cur) { lines.push({ text: cur, start }); start = idx; cur = w; }
    else cur = test;
    idx += w.length + 1;
  }
  lines.push({ text: cur, start });
  return lines;
}
// x offset and line index of character n in wrapped lines (for carets and highlights)
function caretAt(ctx, lines, n, font) {
  ctx.font = font;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i], end = L.start + L.text.length;
    if (n <= end || i === lines.length - 1) return { x: ctx.measureText(L.text.slice(0, clamp(n - L.start, 0, L.text.length))).width, line: i };
  }
}
// draws the first n characters of wrapped text (streaming / typing)
function drawWrapped(ctx, lines, n, x, y, lh, font, color) {
  ctx.font = font; ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.letterSpacing = '0px';
  lines.forEach((L, i) => { const vis = L.text.slice(0, clamp(n - L.start, 0, L.text.length)); if (vis) ctx.fillText(vis, x, y + i * lh); });
}
function glow(ctx, x, y, r, color, a) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, rgba(color, a)); g.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

// ---------- render loop ----------
const GRAIN = [];
let leakWarned = false;
function drawFrame(ctx, t) {
  ctx.setTransform(OS, 0, 0, OS, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = STAGE.bg; ctx.fillRect(0, 0, W, H);
  FRAME(ctx, t);
  // An unbalanced save/restore silently moves everything drawn after it (it
  // once dragged the logo 80px down during a slide-in). Say so loudly.
  const m = ctx.getTransform();
  if (!leakWarned && (Math.abs(m.a - OS) > 1e-6 || Math.abs(m.e) > 1e-3 || Math.abs(m.f) > 1e-3 || ctx.globalAlpha !== 1)) {
    leakWarned = true; console.warn(`rally-motion: canvas state leaked out of frame() at t=${t.toFixed(3)}; a save() is missing its restore()`);
  }
}
window.renderFrame = function (fi) {
  const t0 = fi / FPS;
  ctxO.setTransform(1, 0, 0, 1, 0, 0); ctxO.globalAlpha = 1;
  // motion blur: average STAGE.sub instants across the shutter
  for (let s = 0; s < STAGE.sub; s++) {
    drawFrame(ctxS, Math.max(0, t0 + (s / STAGE.sub - .5) * STAGE.shutter / FPS));
    ctxO.globalAlpha = 1 / (s + 1); ctxO.drawImage(sub, 0, 0);
  }
  ctxO.globalAlpha = 1;
  if (STAGE.vignette) {
    ctxO.setTransform(OS, 0, 0, OS, 0, 0);
    const r = Math.max(W, H);
    const g = ctxO.createRadialGradient(W / 2, H / 2, r * .5, W / 2, H / 2, r * .9);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${STAGE.vignette})`); ctxO.fillStyle = g; ctxO.fillRect(0, 0, W, H);
    ctxO.setTransform(1, 0, 0, 1, 0, 0);
  }
  if (STAGE.grain) {
    ctxO.globalAlpha = STAGE.grain; ctxO.globalCompositeOperation = 'overlay';
    const g = GRAIN[fi % GRAIN.length]; for (let y = 0; y < out.height; y += 256) for (let x = 0; x < out.width; x += 256) ctxO.drawImage(g, x, y);
    ctxO.globalCompositeOperation = 'source-over'; ctxO.globalAlpha = 1;
  }
};
window.grab = () => out.toDataURL('image/png');

/** Loads fonts, the mark and grain, then marks the page ready for render.mjs. */
async function start(frameFn) {
  FRAME = frameFn;
  loadMark();
  for (let k = 0; k < 6; k++) {
    const c = new OffscreenCanvas(256, 256), x = c.getContext('2d'); const id = x.createImageData(256, 256); const r = rng(k + 1);
    for (let i = 0; i < id.data.length; i += 4) { const v = r() * 255; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 255; }
    x.putImageData(id, 0, 0); GRAIN.push(c);
  }
  const weights = [400, 420, 500, 560, 600, 650, 700, 750, 800, 900];
  await Promise.all(['Inter Tight', 'Inter', 'Geist Mono'].flatMap(f => weights.map(w => document.fonts.load(`${w} 40px "${f}"`, 'Rally 0123'))));
  const q = new URLSearchParams(location.search);
  if (q.has('t')) window.renderFrame(Math.round(parseFloat(q.get('t')) * FPS));
  window.ready = true;
}
