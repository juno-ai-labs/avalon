// Rally motion components: hook cards, captions, the Channel chat UI, and the end card.
// Every component takes the time t (seconds) and derives its own animation from it.

// ---------- hook cards ----------
/**
 * A full-screen statement card. Lines push up into view when it starts (tin) and
 * up out of view when the next card replaces it (tout); tin <= 0 means "already
 * on screen at frame 0" so the first frame is a readable thumbnail.
 *
 * card: { lines: [[text, color], ...], tin, tout, size = 128, lh = size * 1.02, x = 72, cy = H / 2 }
 * Returns { x, y0, lh, font, ls } while visible (for strikes and swaps), else null.
 * Call done() on the returned object after any extra drawing to restore the clip.
 */
function hookCard(ctx, t, card) {
  const size = card.size || 128, lh = card.lh || Math.round(size * 1.02), x = card.x ?? 72, cy = card.cy ?? H / 2;
  const n = card.lines.length, y0 = cy - (n - 1) * lh / 2 - 5;
  const top = y0 - size * 1.0, height = (n - 1) * lh + size * 1.45;
  const pin = card.tin <= 0 ? 1 : eio5(prog(t, card.tin, card.tin + .34)), pout = eio5(prog(t, card.tout ?? 1e9, (card.tout ?? 1e9) + .32));
  if (pin <= 0 || pout >= 1) return null;
  const font = F.disp(800, size), ls = -size * .039;
  ctx.save(); ctx.beginPath(); ctx.rect(0, top, W, height); ctx.clip(); ctx.translate(0, (1 - pin) * height - pout * height);
  if (card.tin <= 0) { const pop = 1 + .03 * (1 - eo3(prog(t, 0, .5))); ctx.translate(x, cy); ctx.scale(pop, pop); ctx.translate(-x, -cy); }
  card.lines.forEach(([s, c], i) => { if (s) text(ctx, s, x, y0 + i * lh, font, c, 'left', ls); });
  return { x, y0, lh, font, ls, size, done: () => ctx.restore() };
}
/** A volt bar struck through a word, drawn on over ~0.22s from t0. */
function strike(ctx, t, t0, x, baseline, width, size) {
  const p = eoX(prog(t, t0, t0 + .22)); if (p <= 0) return;
  ctx.fillStyle = C.volt; ctx.fillRect(x - 10, baseline - size * .42, (width + 20) * p, size * .155);
}

// ---------- captions ----------
/**
 * Two-line captions above a product UI. caps: [{ t0, lines: [[[text, color], ...], [[...]]] }].
 * Each holds until the next one starts (or `end`). Hold each >= 2.4s: people read them muted.
 */
function captions(ctx, t, caps, { end, x = 72, y = 222, size = 74, lh = 80, top = 150, height = 172 } = {}) {
  const f = F.disp(800, size), ls = -size * .034;
  caps.forEach((cap, i) => {
    const t1 = i < caps.length - 1 ? caps[i + 1].t0 : end;
    const pin = eoX(prog(t, cap.t0, cap.t0 + .45)), pout = eiX(prog(t, t1 - .18, t1 + .02));
    if (pin <= 0 || pout >= 1) return;
    ctx.save(); ctx.beginPath(); ctx.rect(0, top, W, height); ctx.clip();
    cap.lines.forEach((line, j) => {
      const d = eoX(prog(t, cap.t0 + j * .07, cap.t0 + .45 + j * .07));
      let xx = x; const yy = y + j * lh + (1 - d) * height - pout * height;
      line.forEach(([s, c]) => { text(ctx, s, xx, yy, f, c, 'left', ls); xx += measure(ctx, s, f, ls); });
    });
    ctx.restore();
  });
}

// ---------- Channel chat UI ----------
// Follows the desktop app: humans on the RIGHT in bubbles (their personal
// colour, name + dot above), Rally on the LEFT with no bubble ("Rally" above).
// Sizes are ~2.3x the app's 14px so a phone can read them.
const CHAT = { PAD: 36, MAXW: 640, MF: F.ui(420, 33), LH: 44, BYF: F.ui(500, 23), BIGF: F.disp(800, 50), BIGLH: 58 };

/** The window shell: background, header with avatars, composer. app = { x, y, w, h }. */
function channelWindow(ctx, app, { title, sub, people = [], lock = false, composer = 'Message #' + title } = {}) {
  const { PAD } = CHAT;
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.7)'; ctx.shadowBlur = 60; ctx.shadowOffsetY = 24;
  rr(ctx, app.x, app.y, app.w, app.h, 30); ctx.fillStyle = UI.bg; ctx.fill(); ctx.restore();
  rr(ctx, app.x, app.y, app.w, app.h, 30); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.stroke();
  ctx.fillStyle = UI.line; ctx.fillRect(app.x, app.y + 104, app.w, 2);
  let x = app.x + PAD;
  if (lock) { lockIcon(ctx, x + 10, app.y + 52, 1.5, C.volt); x += 34; }
  text(ctx, title.startsWith('#') || lock ? title : '# ' + title, x, app.y + 62, F.ui(700, 36), UI.text, 'left', -.4);
  if (sub) text(ctx, sub, x, app.y + 92, F.ui(500, 21), lock ? C.volt : UI.muted);
  people.forEach((p, i) => avatar(ctx, app.x + app.w - PAD - 20 - (people.length - 1 - i) * 34, app.y + 52, 22, p, 1));
  const y = app.y + app.h - 96;
  rr(ctx, app.x + PAD - 8, y, app.w - PAD * 2 + 16, 70, 35); ctx.fillStyle = UI.raised; ctx.fill();
  text(ctx, composer, app.x + PAD + 22, y + 45, F.ui(420, 27), UI.muted);
}
const chatBottom = app => app.y + app.h - 128;

/**
 * Messages, bottom-anchored like a real chat: each new one pushes the rest up.
 * msg kinds (all need t, the time it appears):
 *   { who: 'maya' | 'theo' | 'priya', s, mention? }        human bubble, right
 *   { who: 'rally', s, stream?, big?, segments?, react? }   Rally, left, no bubble
 *   { who: 'history', person, agent, items }                imported thread as grey placeholders
 *   { who: 'divider', label }                               centred rule with a label
 * A message may also carry highlight: t => 0..1 (hover state).
 */
function chatStack(ctx, app, msgs, t, { bottom = chatBottom(app) } = {}) {
  const vis = msgs.filter(m => t >= m.t);
  let y = bottom; const pos = [];
  for (let i = vis.length - 1; i >= 0; i--) {
    const m = vis[i]; const h = chatMsgHeight(ctx, m, t); const k = i === vis.length - 1 ? eo3(prog(t, m.t, m.t + .32)) : 1;
    y -= h * k; pos.unshift([m, y]);
  }
  ctx.save(); ctx.beginPath(); ctx.rect(app.x, app.y + 106, app.w, app.h - 106); ctx.clip();
  pos.forEach(([m, top]) => { m._top = top; if (top + chatMsgHeight(ctx, m, t) >= app.y) chatMsg(ctx, app, m, top, t); });
  ctx.restore();
  return pos;
}
function chatMsgHeight(ctx, m, t) {
  const { MF, LH, BIGF, BIGLH, MAXW } = CHAT;
  if (m.who === 'divider') return 74;
  if (m.who === 'history') return m.items.reduce((a, b) => a + 34 + historyItemH(b) + 22, 0);
  const lines = wrap(ctx, (m.mention ? m.mention + ' ' : '') + m.s, m.big ? BIGF : MF, m.big ? 900 : MAXW - (m.who === 'rally' ? 0 : 52));
  m._lines = lines;
  return 34 + lines.length * (m.big ? BIGLH : LH) + (m.who === 'rally' ? 6 : 30) + (m.big ? 10 : 0) + (m.react ? 64 * eo3(prog(t, m.react, m.react + .3)) : 0);
}
const historyItemH = b => b.bars ? b.bars.length * 34 - 10 : 64;
/** An @mention chip: the person's avatar, or Rally's mark. */
function mentionChip(ctx, x, y, label, onBubble, ink = '#0b0c0a') {
  const f = F.ui(560, 28); const w = measure(ctx, label, f) + 52;
  rr(ctx, x, y - 30, w, 40, 8); ctx.fillStyle = onBubble ? 'rgba(11,12,10,.18)' : 'rgba(143,143,143,.13)'; ctx.fill();
  const who = Object.values(P).find(p => '@' + p.name === label);
  if (!who || who.ai) { ctx.beginPath(); ctx.arc(x + 20, y - 10, 12, 0, 7); ctx.fillStyle = '#111210'; ctx.fill(); drawMark(ctx, x + 20, y - 9.5, 17, 1, C.volt, 26); }
  else avatar(ctx, x + 20, y - 10, 12, who, 1);
  text(ctx, label, x + 38, y, f, onBubble ? ink : UI.text);
  return w;
}
function chatMsg(ctx, app, m, top, t) {
  const { PAD, MF, LH, BYF, BIGF, BIGLH } = CHAT;
  const right = app.x + app.w - PAD;
  if (m.who === 'history') {
    let y = top; const person = P[m.person];
    m.items.forEach((b, i) => {
      const q = eo3(prog(t, m.t + i * .07, m.t + .3 + i * .07)); const h = historyItemH(b);
      if (q > 0) {
        ctx.save(); ctx.globalAlpha = q; ctx.translate(0, (1 - q) * 18);
        const by = y + 34;
        if (b.side === 'r') {
          const nw = measure(ctx, person.name, BYF);
          text(ctx, person.name, right - 18, y + 24, BYF, 'rgba(228,228,228,.7)', 'right');
          ctx.beginPath(); ctx.arc(right - 18 - nw - 13, y + 16, 6, 0, 7); ctx.fillStyle = rgba(person.dot || person.color, .7); ctx.fill();
          rr(ctx, right - b.w, by, b.w, h, 32); ctx.fillStyle = 'rgba(90,90,90,.8)'; ctx.fill();
          rr(ctx, right - b.w + 26, by + h / 2 - 9, b.w - 70, 18, 9); ctx.fillStyle = 'rgba(255,255,255,.22)'; ctx.fill();
        } else {
          text(ctx, m.agent, app.x + PAD, y + 24, BYF, 'rgba(163,163,163,.8)');
          b.bars.forEach((w, j) => { rr(ctx, app.x + PAD, by + j * 34, w, 22, 11); ctx.fillStyle = 'rgba(255,255,255,.11)'; ctx.fill(); });
        }
        ctx.restore();
      }
      y += 34 + h + 22;
    });
    return;
  }
  if (m.who === 'divider') {
    const a = clamp((t - m.t) / .2); if (a <= 0) return;
    ctx.save(); ctx.globalAlpha = a;
    const f = F.ui(600, 23), lw = measure(ctx, m.label, f), cx = app.x + app.w / 2, y = top + 34, side = (app.w - PAD * 2 - lw) / 2 - 24;
    ctx.fillStyle = UI.line; ctx.fillRect(app.x + PAD, y - 8, side, 2); ctx.fillRect(cx + lw / 2 + 24, y - 8, side, 2);
    text(ctx, m.label, cx, y, f, UI.muted, 'center');
    ctx.restore(); return;
  }
  const p = P[m.who];
  const k = spring(t - m.t, 22, .55); const a = clamp((t - m.t) / .15); if (a <= 0) return;
  ctx.save(); ctx.globalAlpha = a; ctx.translate(0, (1 - k) * 26);
  if (m.who === 'rally') {
    const f = m.big ? BIGF : MF, lh = m.big ? BIGLH : LH, by = top + 34 + (m.big ? 46 : 33);
    const hl = m.highlight ? m.highlight(t) : 0;
    if (hl > 0) {
      const hh = 34 + m._lines.length * lh + 16;
      rr(ctx, app.x + 14, top - 10, app.w - 28, hh, 16); ctx.fillStyle = `rgba(255,255,255,${.07 * hl})`; ctx.fill();
      ctx.fillStyle = rgba(C.volt, hl); ctx.fillRect(app.x + 14, top - 10, 5, hh);
    }
    text(ctx, 'Rally', app.x + PAD, top + 24, BYF, UI.subtle);
    const n = m.stream ? Math.floor(m.s.length * prog(t, m.t + .08, m.t + m.stream)) : m.s.length;
    if (m.segments) {
      // a coloured line (e.g. the brand line with "Your AI." in volt), streamed
      let x = app.x + PAD; let left = n;
      m.segments.forEach(([s, c]) => { const v = s.slice(0, Math.max(0, left)); left -= s.length; if (v) text(ctx, v, x, by, f, c, 'left', -1); x += measure(ctx, v, f, -1); });
      if (n < m.s.length) { ctx.fillStyle = C.volt; ctx.fillRect(x + 6, by - lh * .7, 14, lh * .83); }
    } else {
      drawWrapped(ctx, m._lines, n, app.x + PAD, by, lh, f, UI.text);
      if (n < m.s.length) { const c = caretAt(ctx, m._lines, n, f); ctx.fillStyle = C.volt; ctx.fillRect(app.x + PAD + c.x + 4, by + c.line * lh - 28, 12, 34); }
    }
    if (m.react) reactionChip(ctx, app.x + PAD, top + 34 + m._lines.length * lh + 22, t - m.react, m.reactors || [P.maya, P.theo, P.priya]);
  } else {
    const lines = m._lines; ctx.font = MF;
    let tw = Math.max(...lines.map(l => ctx.measureText(l.text).width));
    if (m.mention) { const cw = measure(ctx, m.mention, F.ui(560, 28)) + 52; ctx.font = MF; tw = Math.max(tw, cw + 10 + ctx.measureText(lines[0].text.slice(m.mention.length + 1)).width); }
    const bw = tw + 52, bh = lines.length * LH + 26, bx = right - bw, by = top + 34;
    const nw = measure(ctx, p.name, BYF);
    text(ctx, p.name, right - 18, top + 24, BYF, UI.subtle, 'right');
    ctx.beginPath(); ctx.arc(right - 18 - nw - 13, top + 16, 6, 0, 7); ctx.fillStyle = p.dot || p.color; ctx.fill();
    ctx.save(); ctx.translate(right, by); const sk = lerp(.92, 1, clamp(k, 0, 1.1)); ctx.scale(sk, sk); ctx.translate(-right, -by);
    rr(ctx, bx, by, bw, bh, 36); ctx.fillStyle = p.color; ctx.fill();
    let x = bx + 26;
    if (m.mention) {
      const cw = mentionChip(ctx, x, by + 46, m.mention, true, p.ink); x += cw + 10;
      text(ctx, lines[0].text.slice(m.mention.length + 1), x, by + 46, MF, p.ink);
      lines.slice(1).forEach((l, i) => text(ctx, l.text, bx + 26, by + 46 + (i + 1) * LH, MF, p.ink));
    } else lines.forEach((l, i) => text(ctx, l.text, x, by + 46 + i * LH, MF, p.ink));
    ctx.restore();
  }
  ctx.restore();
}
/** "+1" chip with reactors' faces popping in, counting up. lt = seconds since it appears. */
function reactionChip(ctx, x, y, lt, reactors) {
  const rq = spring(lt, 24, .45); if (rq <= 0) return;
  const cnt = Math.round(lerp(1, reactors.length, eo3(clamp(lt / .5))));
  ctx.save(); ctx.translate(x, y); ctx.scale(rq, rq);
  const w = 118 + reactors.length * 26;
  rr(ctx, 0, 0, w, 50, 25); ctx.fillStyle = UI.raised; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = rgba(C.volt, .6); ctx.stroke();
  text(ctx, '+1', 20, 35, F.ui(700, 25), C.volt);
  reactors.forEach((p, i) => avatar(ctx, 80 + i * 26, 25, 14, p, spring(lt - .1 - i * .12, 26, .45)));
  text(ctx, String(cnt), w - 16, 35, F.ui(700, 25), UI.text, 'right');
  ctx.restore();
}
/** Where a hover action pill sits: just after the end of a message's first line. */
function pillBeside(ctx, app, m, w = 270) {
  ctx.font = CHAT.MF; const tw = ctx.measureText(m._lines[0].text).width;
  return { x: app.x + CHAT.PAD + tw + 26, y: m._top + 36, w, h: 56 };
}
/** A UI button/menu item with an optional glyph; turns volt once pressed. */
function actionPill(ctx, r, label, { glyphName, branch = false, pressedAt, t, scale = 1, size = 27 } = {}) {
  if (scale <= .01) return;
  const pressed = pressedAt != null && t > pressedAt - .04; const press = pressedAt != null ? Math.exp(-Math.abs(t - pressedAt) * 30) : 0;
  ctx.save(); ctx.translate(r.x + r.w / 2, r.y + r.h / 2); const s = scale * (1 - press * .06); ctx.scale(s, s);
  rr(ctx, -r.w / 2, -r.h / 2, r.w, r.h, Math.min(16, r.h / 2)); ctx.fillStyle = pressed ? C.volt : UI.raised; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,.14)'; ctx.stroke();
  const ink = pressed ? '#0b0c0a' : UI.text;
  if (branch) branchIcon(ctx, -r.w / 2 + 32, -4, 1.2, ink, 2.6);
  if (glyphName) { ctx.save(); ctx.translate(-r.w / 2 + 40, 0); glyph(ctx, glyphName, ink); ctx.restore(); }
  text(ctx, label, -r.w / 2 + (branch || glyphName ? 66 : 24), size * .36, F.ui(600, size), ink);
  ctx.restore();
}

// ---------- end card ----------
/**
 * The lockup: the mark draws itself, "rally" slides out of it, tagline, URL pill,
 * and the cast's cursors gather. lt = seconds since the card started (needs ~3.5s).
 * Centred on the frame, laid out for H = 1080; works for square and 16:9.
 */
function endCard(ctx, lt, { tagline = ['One place for you,', 'your coworkers, and AI.'], url = 'rallywith.ai', cast = true } = {}) {
  const fl = 1 - clamp(lt / .16);
  const mp = eio3(prog(lt, .05, .65));
  const slide = eio5(prog(lt, .55, 1.0));
  const markS = 190, wordF = F.disp(750, 160), wls = -8;
  const ww = measure(ctx, 'rally', wordF, wls); const total = markS * .92 + 28 + ww;
  const mx = lerp(W / 2, W / 2 - total / 2 + markS * .46, slide), my = 430;
  glow(ctx, mx, my, 460, C.volt, .13 * mp);
  const ms = markS * lerp(1.5, 1, slide);
  drawMark(ctx, mx, my, ms, mp, C.volt, 15, 28); drawMark(ctx, mx, my, ms, mp, C.volt, 15, 0);
  if (mp > 0 && mp < 1) { const [hx, hy] = markPoint(mx, my, ms, mp); glow(ctx, hx, hy, 70, C.volt, .55); glow(ctx, hx, hy, 22, '#ffffff', .9); }
  const wx = W / 2 - total / 2 + markS * .92 + 28; const wr = eio5(prog(lt, .7, 1.15));
  if (wr > 0) { ctx.save(); ctx.beginPath(); ctx.rect(wx - 10, my - 160, (ww + 40) * wr, 240); ctx.clip(); text(ctx, 'rally', wx - (1 - wr) * 90, my + 48, wordF, C.paper, 'left', wls); ctx.restore(); }
  const tf = F.disp(700, 54);
  tagline.forEach((s, j) => {
    const p = eoX(prog(lt, 1.05 + j * .08, 1.5 + j * .08));
    ctx.save(); ctx.globalAlpha = p; ctx.beginPath(); ctx.rect(0, 610 + j * 66, W, 70); ctx.clip();
    text(ctx, s, W / 2, 662 + j * 66 + (1 - p) * 60, tf, 'rgba(240,239,232,.9)', 'center', -1.5); ctx.restore();
  });
  if (url) {
    const up = eoX(prog(lt, 1.4, 1.8));
    ctx.save(); ctx.globalAlpha = up; const uf = F.ui(700, 36); const uw = measure(ctx, url, uf, .5);
    rr(ctx, W / 2 - uw / 2 - 36, 830 + (1 - up) * 20, uw + 72, 76, 38); ctx.fillStyle = C.volt; ctx.fill();
    text(ctx, url, W / 2, 880 + (1 - up) * 20, uf, '#0b0c0a', 'center', .5); ctx.restore();
  }
  if (cast) {
    const homes = { maya: [mx - 190, my - 150], theo: [wx + ww + 10, my - 120], priya: [W / 2 - 410, 980], rally: [W / 2 + 330, 990] };
    const starts = { maya: [-200, -100], theo: [W + 200, -150], priya: [-200, H + 170], rally: [W + 200, H + 170] };
    Object.keys(homes).forEach((n, i) => {
      const t0 = .7 + i * .07; const p = eo5(prog(lt, t0, t0 + .6)); if (p <= 0) return;
      const x = lerp(starts[n][0], homes[n][0], p) + Math.sin(lt * 2.3 + i) * 6 * p, y = lerp(starts[n][1], homes[n][1], p) + Math.cos(lt * 1.9 + i * 2) * 5 * p;
      cursor(ctx, x, y, P[n], 1.35, 1);
    });
  }
  if (fl > 0) { ctx.fillStyle = rgba(C.paper, fl * .85); ctx.fillRect(0, 0, W, H); }
}
