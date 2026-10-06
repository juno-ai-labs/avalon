// Rally bento: an Apple-keynote-style grid of feature tiles, toured by a camera.
// layout -> tour camera -> drawBento(). BENTO_TILES holds a ready painter for
// every shipped feature; add new ones in the same shape: (ctx, tile, lt) where
// lt is seconds since the camera reached the tile.

/** cols x rows grid; tiles: { id: [col, row, wCells, hCells] }. Returns geometry. */
function bentoLayout({ cols, rows, cell = 400, gap = 24, radius = 52, tiles }) {
  const at = c => gap + c * (cell + gap), span = n => n * cell + (n - 1) * gap;
  const out = { width: span(cols) + gap * 2, height: span(rows) + gap * 2, radius, tiles: {} };
  Object.entries(tiles).forEach(([id, [c, r, w, h]]) => { out.tiles[id] = { id, x: at(c), y: at(r), w: span(w), h: span(h) }; });
  return out;
}
/**
 * Camera that dives in at `dive`, visits each [id, t0] in order (moves take
 * `move` seconds, then a slow push), pulls back to the whole grid at `pull`,
 * and keeps a gentle push on the overview until `end`. fill: how much of the
 * frame a visited tile takes ({ w, h } in design units, capped by maxScale).
 */
function bentoTour(layout, order, { dive, pull, end, move = .42, fill = { w: W * .78, h: H * .8 }, maxScale = 1.9, margin = 60 }) {
  const overview = [layout.width / 2, layout.height / 2, Math.min((W - margin) / layout.width, (H - margin) / layout.height)];
  const camFor = tl => [tl.x + tl.w / 2, tl.y + tl.h / 2, Math.min(maxScale, fill.w / tl.w, fill.h / tl.h)];
  const keys = [[dive, [overview[0], overview[1], overview[2] * .85]]];
  let prev = null;
  order.forEach(([id, t0]) => {
    layout.tiles[id].t0 = t0;
    const c = camFor(layout.tiles[id]);
    if (prev) keys.push([t0, prev, linear]);
    keys.push([t0 + (prev ? move : .5), c, eio5]);
    prev = c;
  });
  keys.push([pull, prev, linear]);
  keys.push([pull + .8, overview, eio5]);
  return t => {
    const [x, y, s] = kf(t, keys);
    const cur = order.reduce((a, v) => t >= v[1] ? v : a, null);
    const drift = cur && t < pull ? 1 + .04 * eo3(prog(t, cur[1] + move, cur[1] + 1.8)) : 1;
    const settle = 1 + .025 * prog(t, pull + .8, end);
    return { x, y, s: s * drift * settle };
  };
}
/** Draws every tile. A tile builds (springs in) just before the camera reaches it. */
function drawBento(ctx, t, cam, layout, painters = BENTO_TILES) {
  ctx.save(); ctx.translate(W / 2, H / 2); ctx.scale(cam.s, cam.s); ctx.translate(-cam.x, -cam.y);
  Object.values(layout.tiles).forEach(tl => {
    const built = tl.t0 == null ? 1 : spring(t - (tl.t0 - .12), 18, .6), lt = tl.t0 == null ? t : t - tl.t0;
    ctx.save();
    rr(ctx, tl.x, tl.y, tl.w, tl.h, layout.radius); ctx.fillStyle = UI.tile; ctx.fill();
    ctx.lineWidth = 2 / Math.max(.5, cam.s); ctx.strokeStyle = 'rgba(255,255,255,.06)'; ctx.stroke();
    if (built > 0 && painters[tl.id]) {
      ctx.clip();
      ctx.globalAlpha = clamp(built * 1.3);
      const k = lerp(.94, 1, clamp(built, 0, 1.1)); ctx.translate(tl.x + tl.w / 2, tl.y + tl.h / 2); ctx.scale(k, k); ctx.translate(-tl.x - tl.w / 2, -tl.y - tl.h / 2);
      painters[tl.id](ctx, tl, Math.max(0, lt));
    }
    ctx.restore();
  });
  ctx.restore();
}

// ---------- tile painters ----------
// Tiles adapt to their size: the same painter works as 1x1, 2x1, 1x2 or 2x2.
function tileLabel(ctx, tl, lines, size = 56, lt = 1) {
  const f = F.disp(750, size); const q = eoX(clamp(lt / .45));
  ctx.save(); ctx.globalAlpha = q;
  lines.forEach((s, i) => text(ctx, s, tl.x + 44, tl.y + tl.h - 44 - (lines.length - 1 - i) * size * 1.08 + (1 - q) * 24, f, C.paper, 'left', -size * .025));
  ctx.restore();
}
function bubble(ctx, xr, y, w, color, txt, ink, s = 30, left = false) {
  const f = F.ui(500, s); const tw = txt ? measure(ctx, txt, f) : w;
  const bw = txt ? tw + 44 : w, bh = s + 30, x = left ? xr : xr - bw;
  if (!left) { rr(ctx, x, y, bw, bh, bh / 2); ctx.fillStyle = color; ctx.fill(); }
  if (txt) text(ctx, txt, x + (left ? 0 : 22), y + bh / 2 + s * .36, f, ink);
  return bw;
}
const BENTO_TILES = {
  multi(ctx, tl, lt) {
    glow(ctx, tl.x + 300, tl.y + 300, 520, C.volt, .09);
    const q = i => spring(lt - .1 - i * .16, 22, .55);
    text(ctx, 'Multiplayer', tl.x + 56, tl.y + 190, F.disp(800, 120), C.volt, 'left', -4);
    text(ctx, 'AI sessions', tl.x + 56, tl.y + 312, F.disp(800, 120), C.paper, 'left', -4);
    // a live chat on the right half
    const xr = tl.x + tl.w - 50; let y = tl.y + 90;
    [['Maya', C.blue, 'Launch post today?', '#0b0c0a'], ['Theo', C.orange, '@Rally draft it', '#0b0c0a'], ['Rally', null, 'Here’s a first pass.', UI.text], ['Priya', '#5a5a5a', 'Love it.', '#fcfcfc']].forEach(([n, col, s, ink], i) => {
      const k = q(i); if (k <= 0) { y += 132; return; }
      ctx.save(); ctx.globalAlpha = clamp(k * 1.4); ctx.translate(0, (1 - k) * 30);
      if (col) { text(ctx, n, xr - 16, y, F.ui(500, 28), UI.subtle, 'right'); bubble(ctx, xr, y + 12, 0, col, s, ink, 40); }
      else { text(ctx, 'Rally', tl.x + 730, y, F.ui(500, 28), UI.subtle); bubble(ctx, tl.x + 730, y + 12, 0, null, s, ink, 40, true); }
      ctx.restore(); y += 132;
    });
    // everyone here
    [P.maya, P.theo, P.priya, P.rally].forEach((p, i) => avatar(ctx, tl.x + 92 + i * 62, tl.y + tl.h - 96, 34, p, spring(lt - .5 - i * .08, 24, .45)));
    const k = spring(lt - .85, 24, .45);
    if (k > 0) { ctx.save(); ctx.translate(tl.x + 92 + 4 * 62 + 18, tl.y + tl.h - 96); ctx.scale(k, k); rr(ctx, -34, -34, 92, 68, 34); ctx.fillStyle = '#2a2a28'; ctx.fill(); text(ctx, '+8', 12, 11, F.ui(700, 30), C.paper, 'center'); ctx.restore(); }
  },
  claude(ctx, tl, lt) { importTile(ctx, tl, lt, 'Claude'); },
  chatgpt(ctx, tl, lt) { importTile(ctx, tl, lt, 'ChatGPT'); },
  computer(ctx, tl, lt) {
    glow(ctx, tl.x + 200, tl.y + 280, 300, C.blue, .1);
    const x = tl.x + 34, y = tl.y + 40, w = tl.w - 68, h = 470;
    windowFrame(ctx, x, y, w, h);
    rr(ctx, x + 28, y + 78, w - 56, 120, 14); ctx.fillStyle = 'rgba(255,255,255,.06)'; ctx.fill();
    [0, 1, 2].forEach(i => { rr(ctx, x + 28, y + 222 + i * 40, (w - 56) * [.9, .7, .8][i], 18, 9); ctx.fillStyle = 'rgba(255,255,255,.1)'; ctx.fill(); });
    const pressed = lt > .62;
    rr(ctx, x + 28, y + 370, 190, 56, 28); ctx.fillStyle = pressed ? C.volt : 'rgba(255,255,255,.14)'; ctx.fill();
    text(ctx, pressed ? 'Booked' : 'Book', x + 123, y + 407, F.ui(700, 24), pressed ? '#0b0c0a' : UI.text, 'center');
    // Rally drives, Maya watches and points
    const rp = kf(lt, [[0, [x + w - 40, y + 120]], [.55, [x + 150, y + 404], eio5]]);
    const mp = kf(lt, [[0, [x + 40, y + 160]], [.7, [x + 240, y + 250], eio5]]);
    cursor(ctx, mp[0], mp[1], P.maya, 1.2, 1);
    const click = Math.exp(-Math.abs(lt - .62) * 28);
    const rq = prog(lt, .62, 1.05); if (rq > 0 && rq < 1) { ctx.beginPath(); ctx.arc(rp[0] + 3, rp[1] + 3, 10 + eo3(rq) * 40, 0, 7); ctx.strokeStyle = rgba(C.volt, 1 - rq); ctx.lineWidth = 4; ctx.stroke(); }
    cursor(ctx, rp[0], rp[1], P.rally, 1.2, 1, click);
    tileLabel(ctx, tl, ['Shared', 'computer use'], 56, lt);
  },
  live(ctx, tl, lt) {
    glow(ctx, tl.x + 600, tl.y + 200, 500, C.orange, .1);
    const x = tl.x + 40, y = tl.y + 40, w = tl.w - 80, h = 560;
    windowFrame(ctx, x, y, w, h, 'launch-day preview');
    const lq = .55 + .45 * Math.sin(lt * 8);
    rr(ctx, x + w - 120, y + 14, 92, 30, 15); ctx.fillStyle = '#0b0c0a'; ctx.fill();
    ctx.beginPath(); ctx.arc(x + w - 102, y + 29, 6, 0, 7); ctx.fillStyle = rgba(C.volt, lq); ctx.fill();
    text(ctx, 'LIVE', x + w - 90, y + 37, F.mono(700, 18), C.volt);
    // the site itself
    text(ctx, 'Ship faster,', x + 40, y + 140, F.disp(800, 56), C.paper, 'left', -1.5);
    text(ctx, 'together.', x + 40, y + 200, F.disp(800, 56), C.volt, 'left', -1.5);
    rr(ctx, x + 40, y + 232, 180, 48, 24); ctx.fillStyle = C.paper; ctx.fill(); text(ctx, 'Get started', x + 130, y + 264, F.ui(700, 20), '#0b0c0a', 'center');
    const bars = [.35, .5, .42, .66, .58, .8, .95];
    bars.forEach((b, i) => {
      const g = spring(lt - .15 - i * .06, 20, .55); const v = b * (1 + .06 * Math.sin(lt * 3 + i)); const bh = 210 * v * g;
      rr(ctx, x + 300 + i * 56, y + 520 - bh, 38, Math.max(0, bh), 6); ctx.fillStyle = i === 6 ? C.volt : 'rgba(255,255,255,.2)'; ctx.fill();
    });
    tileLabel(ctx, tl, ['Live website artifacts'], 60, lt);
  },
  connectors(ctx, tl, lt) {
    // scales with the tile: z = 1 for a 2x1 tile, 1.5 for 2x2
    const z = tl.h > 600 ? 1.5 : 1, cx = tl.x + tl.w / 2, cy = tl.y + (z > 1 ? 330 : 150);
    glow(ctx, cx, cy, 280 * z, C.volt, .12);
    const icons = ['mail', 'cal', 'doc', 'chat', 'code', 'folder'];
    icons.forEach((ic, i) => {
      const side = i < 3 ? -1 : 1, j = i % 3; const x = cx + side * (z > 1 ? 250 + (j === 1 ? 70 : 0) : 220 + (j === 1 ? 70 : 0)), y = cy - (z > 1 ? 190 : 90) + j * (z > 1 ? 190 : 90);
      const k = spring(lt - .08 - i * .06, 24, .5);
      ctx.save(); ctx.globalAlpha = clamp(k); ctx.strokeStyle = 'rgba(255,255,255,.14)'; ctx.lineWidth = 3;
      const hub = 60 * z + 6, edge = 34 * z;
      ctx.beginPath(); ctx.moveTo(x - side * edge, y); ctx.bezierCurveTo((x + cx) / 2, y, (x + cx) / 2, cy, cx - side * hub, cy); ctx.stroke();
      const u = ((lt * .9 + i * .17) % 1); const px = lerp(x - side * edge, cx - side * hub, u), py = lerp(y, cy, eio3(u));
      ctx.beginPath(); ctx.arc(px, py, 6, 0, 7); ctx.fillStyle = C.volt; ctx.fill();
      ctx.translate(x, y); ctx.scale(k * z, k * z);
      rr(ctx, -34, -34, 68, 68, 18); ctx.fillStyle = '#262624'; ctx.fill();
      glyph(ctx, ic); ctx.restore();
    });
    markDisc(ctx, cx, cy, 60 * z, spring(lt - .02, 22, .5));
    tileLabel(ctx, tl, ['Connectors'], z > 1 ? 64 : 56, lt);
  },
  artifacts(ctx, tl, lt) {
    glow(ctx, tl.x + 560, tl.y + 140, 360, C.blue, .1);
    const base = [tl.x + 560, tl.y + 300];
    [[-150, -.16, 'doc'], [0, 0, 'chart'], [150, .16, 'slide']].forEach(([dx, rot, kind], i) => {
      const k = spring(lt - .05 - i * .1, 20, .55);
      ctx.save(); ctx.translate(base[0] + dx * clamp(k, 0, 1.1), base[1] + (1 - k) * 80); ctx.rotate(rot * clamp(k, 0, 1.1));
      rr(ctx, -110, -250, 220, 260, 18); ctx.fillStyle = kind === 'chart' ? '#1f1f1d' : C.paper; ctx.fill();
      if (kind === 'doc') { rr(ctx, -84, -220, 120, 20, 8); ctx.fillStyle = '#111'; ctx.fill(); [0, 1, 2, 3, 4].forEach(j => { rr(ctx, -84, -180 + j * 30, 168 * [1, .9, .95, .7, .85][j], 12, 6); ctx.fillStyle = '#c9c7bd'; ctx.fill(); }); }
      if (kind === 'chart') { [.4, .6, .5, .85].forEach((b, j) => { rr(ctx, -80 + j * 44, -30 - 170 * b, 30, 170 * b, 5); ctx.fillStyle = j === 3 ? C.volt : 'rgba(255,255,255,.25)'; ctx.fill(); }); }
      if (kind === 'slide') { rr(ctx, -84, -220, 168, 96, 10); ctx.fillStyle = C.orange; ctx.fill(); rr(ctx, -84, -104, 130, 16, 8); ctx.fillStyle = '#111'; ctx.fill(); rr(ctx, -84, -76, 100, 12, 6); ctx.fillStyle = '#c9c7bd'; ctx.fill(); }
      ctx.restore();
    });
    tileLabel(ctx, tl, ['Artifacts'], 60, lt);
  },
  spaces(ctx, tl, lt) {
    glow(ctx, tl.x + 120, tl.y + 160, 300, C.volt, .08);
    const x = tl.x + 40; let y = tl.y + 84;
    const rows = [['space', 'Launch', C.volt], ['ch', '# launch-day'], ['br', 'headline'], ['ch', '# design'], ['ch', '# gtm'], ['space', 'Hiring', C.blue], ['ch', '# candidates']];
    rows.forEach(([kind, s, col], i) => {
      const k = eoX(prog(lt, .05 + i * .07, .4 + i * .07)); if (k <= 0) { y += (kind === 'space' ? 74 : 64) + (kind === 'space' && i ? 26 : 0); return; }
      ctx.save(); ctx.globalAlpha = k; ctx.translate((1 - k) * -40, 0);
      if (kind === 'space') { if (i) y += 26; rr(ctx, x, y - 36, 48, 48, 13); ctx.fillStyle = col; ctx.fill(); text(ctx, s, x + 66, y, F.ui(700, 40), C.paper); }
      else if (kind === 'br') { branchIcon(ctx, x + 72, y - 12, 1.25, C.volt, 2.6); text(ctx, s, x + 100, y, F.ui(500, 32), 'rgba(240,239,232,.75)'); }
      else text(ctx, s, x + 34, y, F.ui(500, 34), 'rgba(240,239,232,.85)');
      ctx.restore(); y += kind === 'space' ? 74 : 64;
    });
    tileLabel(ctx, tl, ['Spaces'], 60, lt);
  },
  breakouts(ctx, tl, lt) {
    glow(ctx, tl.x + 420, tl.y + 120, 360, C.volt, .08);
    const y = tl.y + 190, x0 = tl.x + 60, x1 = tl.x + tl.w - 60, bx0 = tl.x + 230, bx1 = tl.x + 620, by = tl.y + 70;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    [0, 1, 2, 3, 4, 5, 6].forEach(i => { ctx.beginPath(); ctx.arc(x0 + 30 + i * 110, y, 10, 0, 7); ctx.fillStyle = 'rgba(255,255,255,.45)'; ctx.fill(); });
    const p = eio3(prog(lt, .1, .75));
    const path = new Path2D(); path.moveTo(bx0, y); path.bezierCurveTo(bx0 + 80, y, bx0 + 60, by, bx0 + 150, by); path.lineTo(bx1 - 150, by); path.bezierCurveTo(bx1 - 60, by, bx1 - 80, y, bx1, y);
    ctx.save(); ctx.setLineDash([900 * p, 2000]); ctx.strokeStyle = C.volt; ctx.lineWidth = 7; ctx.shadowColor = C.volt; ctx.shadowBlur = 18; ctx.stroke(path); ctx.restore();
    if (p > .35) { const k = spring(lt - .35, 24, .5); ctx.save(); ctx.translate(tl.x + 425, by); ctx.scale(k, k); rr(ctx, -82, -24, 164, 48, 24); ctx.fillStyle = '#0b0c0a'; ctx.fill(); ctx.strokeStyle = C.volt; ctx.lineWidth = 2.5; ctx.stroke(); lockIcon(ctx, -50, -2, 1.1, C.volt); text(ctx, 'Private', 12, 8, F.ui(650, 22), C.volt, 'center'); ctx.restore(); }
    tileLabel(ctx, tl, ['Breakouts'], 60, lt);
  },
  sidekicks(ctx, tl, lt) {
    // wide tile: mark on the right; square tile: mark above the label
    const wide = tl.w > tl.h * 1.4, cx = wide ? tl.x + tl.w - 230 : tl.x + tl.w / 2, cy = wide ? tl.y + tl.h / 2 : tl.y + 160;
    glow(ctx, cx, cy, 300, C.volt, .14);
    ctx.strokeStyle = 'rgba(204,255,0,.18)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cx, cy, 120, 0, 7); ctx.stroke();
    [0, 1, 2].forEach(i => { const a = lt * 1.6 + i * 2.09; ctx.beginPath(); ctx.arc(cx + Math.cos(a) * 120, cy + Math.sin(a) * 120, 11, 0, 7); ctx.fillStyle = [C.blue, C.orange, C.paper][i]; ctx.fill(); });
    markDisc(ctx, cx, cy, 72, spring(lt - .05, 20, .45));
    tileLabel(ctx, tl, ['Sidekicks'], 56, lt);
  },
  triggered(ctx, tl, lt) {
    glow(ctx, tl.x + 420, tl.y + 140, 380, C.volt, .08);
    const y = tl.y + 120;
    const s1 = spring(lt - .05, 24, .5), s2 = spring(lt - .35, 24, .5), s3 = spring(lt - .65, 24, .5);
    ctx.save(); ctx.translate(tl.x + 50, y); ctx.scale(s1, s1);
    rr(ctx, 0, -32, 250, 64, 32); ctx.fillStyle = '#262624'; ctx.fill();
    ctx.strokeStyle = C.paper; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(34, 0, 14, 0, 7); ctx.moveTo(34, -7); ctx.lineTo(34, 0); ctx.lineTo(40, 4); ctx.stroke();
    text(ctx, 'Mon 9:00', 62, 9, F.ui(650, 26), C.paper); ctx.restore();
    const ap = eio3(prog(lt, .2, .45)), bp = eio3(prog(lt, .5, .75));
    ctx.strokeStyle = C.volt; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(tl.x + 310, y); ctx.lineTo(tl.x + 310 + 60 * ap, y); ctx.stroke();
    markDisc(ctx, tl.x + 420, y, 42, s2);
    ctx.beginPath(); ctx.moveTo(tl.x + 474, y); ctx.lineTo(tl.x + 474 + 60 * bp, y); ctx.stroke();
    ctx.save(); ctx.translate(tl.x + 548, y); ctx.scale(s3, s3);
    rr(ctx, 0, -32, 230, 64, 32); ctx.fillStyle = C.volt; ctx.fill(); text(ctx, 'Digest sent', 24, 9, F.ui(700, 26), '#0b0c0a'); ctx.restore();
    tileLabel(ctx, tl, ['Triggered Sidekicks'], 56, lt);
  },
};
function importTile(ctx, tl, lt, name) {
  glow(ctx, tl.x + 280, tl.y + 150, 260, C.volt, .1);
  const cx = tl.x + 300, cy = tl.y + 140;
  rr(ctx, tl.x + 40, tl.y + 44, 170, 190, 18); ctx.fillStyle = '#232321'; ctx.fill();
  text(ctx, name, tl.x + 58, tl.y + 82, F.ui(650, 22), UI.muted);
  [0, 1, 2].forEach(i => { rr(ctx, tl.x + (i % 2 ? 100 : 58), tl.y + 104 + i * 40, i % 2 ? 92 : 110, 26, 13); ctx.fillStyle = i % 2 ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.1)'; ctx.fill(); });
  // messages flow over into Rally
  for (let i = 0; i < 4; i++) {
    const u = prog(lt, .15 + i * .12, .55 + i * .12); if (u <= 0 || u >= 1) continue;
    const e = eio3(u); const x = lerp(tl.x + 190, cx - 30, e), y = lerp(tl.y + 120 + (i % 3) * 36, cy, e) - Math.sin(e * Math.PI) * 40;
    rr(ctx, x - 24, y - 10, 48, 20, 10); ctx.fillStyle = rgba('#f0efe8', .6 * (1 - u * .5)); ctx.fill();
  }
  markDisc(ctx, cx, cy, 52, spring(lt - .05, 22, .45) * (1 + .08 * Math.exp(-Math.abs(lt - .75) * 10)));
  tileLabel(ctx, tl, [name, 'import'], 52, lt);
}