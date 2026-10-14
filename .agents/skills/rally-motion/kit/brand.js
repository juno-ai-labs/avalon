// Rally brand primitives: colours, type, people, the mark, cursors, avatars, icons.
// Values come from apps/site/src/styles.css (brand) and packages/ui/src/styles/themes.css (app dark theme).

const C = {
  bg: '#111210', // site near-black, used behind hook text
  paper: '#f0efe8', // warm off-white for type
  volt: '#ccff00', // the brand colour: one accent per frame, never decoration
  blue: '#47c7fc',
  orange: '#ff6337',
  muted: 'rgba(240,239,232,.55)',
};
// The desktop app's dark theme, for any Channel UI.
const UI = {
  bg: '#070707', raised: '#2f2f2f', text: '#fcfcfc', subtle: '#e4e4e4', muted: '#a3a3a3',
  line: 'rgba(255,255,255,.09)', humanBubble: '#5a5a5a', tile: '#141413',
};
// Inter Tight = display (heavy, tight tracking); Inter = UI; Geist Mono = small labels.
const F = {
  disp: (w, s) => `${w} ${s}px "Inter Tight"`,
  ui: (w, s) => `${w} ${s}px "Inter"`,
  mono: (w, s) => `${w} ${s}px "Geist Mono"`,
};
// The recurring cast. Personal colours tint each person's chat bubble.
const P = {
  maya: { name: 'Maya', color: C.blue, ink: '#0b0c0a' },
  theo: { name: 'Theo', color: C.orange, ink: '#0b0c0a' },
  priya: { name: 'Priya', color: UI.humanBubble, ink: '#fcfcfc', dot: C.paper, cursor: C.paper },
  rally: { name: 'Rally', color: C.volt, ai: true },
};

// ---------- the mark ----------
let MARK, MARK_LEN = 1;
const MARK_PTS = [];
function loadMark() {
  MARK = new Path2D(MARK_D);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', MARK_D); svg.appendChild(path); svg.style.position = 'absolute'; svg.style.width = svg.style.height = '0';
  document.body.appendChild(svg);
  MARK_LEN = path.getTotalLength();
  for (let i = 0; i <= 600; i++) { const p = path.getPointAtLength(MARK_LEN * i / 600); MARK_PTS.push([p.x, p.y]); }
}
/** The mark centred at (cx, cy), `size` wide. p < 1 draws the stroke on; glow adds a bloom. */
function drawMark(ctx, cx, cy, size, p = 1, color = C.volt, lw = 15, glowPx = 0) {
  if (p <= 0) return;
  const V = MARK_VIEWBOX;
  ctx.save(); ctx.translate(cx, cy); const k = size / V.s; ctx.scale(k, k); ctx.translate(-(V.x + V.s / 2), -(V.y + V.s / 2));
  ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = color;
  if (p < 1) ctx.setLineDash([MARK_LEN * p, MARK_LEN * 2]);
  if (glowPx) { ctx.shadowColor = color; ctx.shadowBlur = glowPx; }
  ctx.stroke(MARK); ctx.restore();
}
/** Where the drawing tip is at progress p (for a spark on the stroke head). */
function markPoint(cx, cy, size, p) {
  const V = MARK_VIEWBOX;
  const i = clamp(p) * (MARK_PTS.length - 1); const a = MARK_PTS[Math.floor(i)], b = MARK_PTS[Math.ceil(i)], f = i % 1;
  const k = size / V.s;
  return [cx + (lerp(a[0], b[0], f) - (V.x + V.s / 2)) * k, cy + (lerp(a[1], b[1], f) - (V.y + V.s / 2)) * k];
}
/** Rally as an avatar: a volt disc with the mark in ink. */
function markDisc(ctx, x, y, r, k = 1) {
  if (k <= 0) return;
  ctx.save(); ctx.translate(x, y); ctx.scale(k, k);
  ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.fillStyle = C.volt; ctx.fill();
  drawMark(ctx, 0, 1, r * 1.45, 1, '#0b0c0a', 22); ctx.restore();
}

// ---------- people ----------
function avatar(ctx, x, y, r, p, scale = 1) {
  if (scale <= 0.001) return;
  if (p.ai) { markDisc(ctx, x, y, r, scale); return; }
  ctx.save(); ctx.translate(x, y); ctx.scale(scale, scale);
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fillStyle = p.color; ctx.fill();
  text(ctx, p.name[0], 0, r * 0.36, F.ui(700, r * 0.95), p.ink, 'center');
  ctx.restore();
}
const ARROW = new Path2D('M0 0 L0 27 L7 21 L12.5 32.5 L17.5 30.3 L12.2 19 L21 19 Z');
/** A named multiplayer cursor. click (0..1) squashes it for a press. */
function cursor(ctx, x, y, p, s = 1, alpha = 1, click = 0) {
  if (alpha <= 0) return;
  const col = p.cursor || p.color;
  ctx.save(); ctx.globalAlpha = alpha; ctx.translate(x, y); ctx.scale(s * (1 - click * .18), s * (1 - click * .18));
  ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 3;
  ctx.fillStyle = col; ctx.fill(ARROW); ctx.shadowColor = 'transparent';
  ctx.lineWidth = 2; ctx.strokeStyle = '#111210'; ctx.stroke(ARROW);
  const f = F.ui(650, 15); const w = measure(ctx, p.name, f) + (p.ai ? 44 : 22);
  rr(ctx, 18, 30, w, 28, 8); ctx.fillStyle = col; ctx.fill();
  if (p.ai) { drawMark(ctx, 36, 44, 22, 1, '#111210', 26); text(ctx, p.name, 50, 49.5, f, '#111210'); }
  else text(ctx, p.name, 29, 49.5, f, '#111210');
  ctx.restore();
}
/** Expanding ring for a click at (x, y), lt seconds after it. */
function clickRing(ctx, x, y, lt, color) {
  const rp = clamp(lt / .45); if (lt <= 0 || rp >= 1) return;
  ctx.beginPath(); ctx.arc(x + 3, y + 3, 10 + eo3(rp) * 50, 0, 7); ctx.strokeStyle = rgba(color, 1 - rp); ctx.lineWidth = 4; ctx.stroke();
}

// ---------- icons and chips ----------
function branchIcon(ctx, x, y, s, color, lw = 2.4) { // the app's "↳" breakout glyph
  ctx.save(); ctx.translate(x, y); ctx.scale(s, s); ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-6, -10); ctx.lineTo(-6, 4); ctx.quadraticCurveTo(-6, 9, -1, 9); ctx.lineTo(8, 9); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(4, 5); ctx.lineTo(8, 9); ctx.lineTo(4, 13); ctx.stroke(); ctx.restore();
}
function lockIcon(ctx, x, y, s, color) {
  ctx.save(); ctx.translate(x, y); ctx.scale(s, s); ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2.4;
  ctx.beginPath(); ctx.arc(0, -3, 5, Math.PI, 0); ctx.lineTo(5, 1); ctx.moveTo(-5, 1); ctx.lineTo(-5, -3); ctx.stroke();
  rr(ctx, -8, 0, 16, 12, 2.5); ctx.fill(); ctx.restore();
}
/** Generic line glyphs, centred, ~32 units. Never draw third-party logos. */
function glyph(ctx, ic, color = C.paper) {
  ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.beginPath();
  if (ic === 'mail') { ctx.rect(-16, -11, 32, 22); ctx.moveTo(-16, -11); ctx.lineTo(0, 2); ctx.lineTo(16, -11); }
  if (ic === 'cal') { ctx.rect(-15, -12, 30, 26); ctx.moveTo(-15, -4); ctx.lineTo(15, -4); ctx.moveTo(-8, -16); ctx.lineTo(-8, -9); ctx.moveTo(8, -16); ctx.lineTo(8, -9); }
  if (ic === 'doc') { ctx.moveTo(-11, -16); ctx.lineTo(5, -16); ctx.lineTo(12, -9); ctx.lineTo(12, 16); ctx.lineTo(-11, 16); ctx.closePath(); ctx.moveTo(-5, 0); ctx.lineTo(6, 0); ctx.moveTo(-5, 7); ctx.lineTo(6, 7); }
  if (ic === 'chat') { ctx.moveTo(-15, -12); ctx.lineTo(15, -12); ctx.lineTo(15, 8); ctx.lineTo(-4, 8); ctx.lineTo(-11, 15); ctx.lineTo(-11, 8); ctx.lineTo(-15, 8); ctx.closePath(); }
  if (ic === 'code') { ctx.moveTo(-6, -10); ctx.lineTo(-15, 0); ctx.lineTo(-6, 10); ctx.moveTo(6, -10); ctx.lineTo(15, 0); ctx.lineTo(6, 10); }
  if (ic === 'folder') { ctx.moveTo(-16, -10); ctx.lineTo(-5, -10); ctx.lineTo(-1, -5); ctx.lineTo(16, -5); ctx.lineTo(16, 13); ctx.lineTo(-16, 13); ctx.closePath(); }
  if (ic === 'clock') { ctx.arc(0, 0, 14, 0, 7); ctx.moveTo(0, -7); ctx.lineTo(0, 0); ctx.lineTo(6, 4); }
  if (ic === 'import') { ctx.moveTo(0, -14); ctx.lineTo(0, 8); ctx.moveTo(-9, 0); ctx.lineTo(0, 9); ctx.lineTo(9, 0); ctx.moveTo(-12, 15); ctx.lineTo(12, 15); }
  ctx.stroke();
}
function pill(ctx, x, y, txt, fill, ink, s = 24) {
  const f = F.ui(650, s); const w = measure(ctx, txt, f) + 36;
  rr(ctx, x, y, w, s + 22, (s + 22) / 2); ctx.fillStyle = fill; ctx.fill(); text(ctx, txt, x + 18, y + (s + 22) / 2 + s * .36, f, ink); return w;
}
function windowFrame(ctx, x, y, w, h, title) {
  rr(ctx, x, y, w, h, 22); ctx.fillStyle = '#0b0b0a'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,.1)'; ctx.stroke();
  [0, 1, 2].forEach(i => { ctx.beginPath(); ctx.arc(x + 28 + i * 22, y + 28, 7, 0, 7); ctx.fillStyle = 'rgba(255,255,255,.18)'; ctx.fill(); });
  if (title) { rr(ctx, x + 104, y + 12, w - 132, 32, 16); ctx.fillStyle = 'rgba(255,255,255,.06)'; ctx.fill(); text(ctx, title, x + 124, y + 35, F.ui(500, 20), UI.muted); }
}
/**
 * Small "rally" lockup for a corner. Keep it on screen from the first frame of an ad.
 * Placed top right, it carries the URL under it, right-aligned to the wordmark.
 */
function brandBug(ctx, alpha = 1, x = 92, y = 92, size = 52, url = 'rallywith.ai') {
  if (alpha <= 0) return;
  ctx.save(); ctx.globalAlpha = alpha;
  drawMark(ctx, x, y, size, 1, C.volt, 18);
  const wf = F.disp(750, size * .85), wx = x + size * .65, wy = y + size * .27;
  text(ctx, 'rally', wx, wy, wf, C.paper, 'left', -size * .042);
  if (url && x > W / 2 && y < H / 2) {
    const right = wx + measure(ctx, 'rally', wf, -size * .042);
    text(ctx, url, right, wy + size * .72, F.ui(600, size * .4), C.muted, 'right');
  }
  ctx.restore();
}
