// Rally motion sound: a tiny offline synth for scores that lock to the picture.
// No samples, no dependencies: every sound is generated, so a score is a plain
// script of timed calls and renders identically every time.
//
//   import { createMix, CHORDS, nf } from '../../kit/audio-lib.mjs';
//   const m = createMix(15);            // seconds
//   m.kick(0); m.whoosh(1.6, .4); m.impact(2);
//   m.write(process.env.OUT_WAV || 'score.wav');
import fs from 'node:fs';

const TAU = Math.PI * 2;
/** MIDI note to Hz. */
export const nf = n => 440 * Math.pow(2, (n - 69) / 12);
// Voicings used across the shipped films (B minor, G, D, A, then a bright D add9 for endings).
export const CHORDS = {
  Bm: [47, 54, 59, 62, 66], G: [43, 50, 55, 59, 62], D: [50, 57, 62, 66, 69], A: [45, 52, 57, 61, 64],
  Dadd9: [50, 57, 62, 64, 66, 69, 74],
};

export function createMix(duration, { sampleRate: SR = 48000 } = {}) {
  const N = Math.round(SR * duration);
  const L = new Float32Array(N), R = new Float32Array(N), sendL = new Float32Array(N), sendR = new Float32Array(N);
  let seed = 1; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const noise = () => rnd() * 2 - 1;
  const env = (t, a, d) => t < a ? t / a : Math.exp(-(t - a) * d);
  const saw = p => 2 * (p % 1) - 1;
  const m = { offset: 0, duration };

  // add a generated voice at t0; fn(x, state) returns the sample x seconds in
  function add(t0, dur, fn, gain = 1, pan = 0, send = 0) {
    t0 += m.offset;
    const s0 = Math.max(0, Math.floor(t0 * SR)), s1 = Math.min(N, Math.floor((t0 + dur) * SR));
    const gl = gain * Math.cos((pan + 1) * Math.PI / 4), gr = gain * Math.sin((pan + 1) * Math.PI / 4);
    const st = { lp: 0, lp2: 0, hp: 0, prev: 0, ph: 0, ph2: 0, ph3: 0 };
    for (let i = s0; i < s1; i++) {
      const v = fn((i - t0 * SR) / SR, st);
      L[i] += v * gl; R[i] += v * gr; sendL[i] += v * gl * send; sendR[i] += v * gr * send;
    }
  }

  // ---- drums ----
  m.kick = (t, g = 1) => add(t, .6, (x, s) => { const f = 45 + 120 * Math.exp(-x * 30); s.ph += f / SR; return Math.sin(TAU * s.ph) * Math.exp(-x * 7) + (x < .004 ? noise() * .4 : 0); }, g);
  m.clap = (t, g = .5, send = .25) => add(t, .3, (x, s) => { const n = noise(); s.hp = n - s.prev; s.prev = n; s.lp += (s.hp - s.lp) * .35; const e = Math.max(env(x, .001, 60) * (x < .03 ? 1 : 0), env(x - .01, .001, 50) * (x > .01 && x < .03 ? 1 : 0), x > .02 ? Math.exp(-(x - .02) * 18) : 0); return s.lp * e; }, g, 0, send);
  m.hat = (t, g = .12, pan = 0, decay = 70) => add(t, .12, (x, s) => { const n = noise(); const h = n - s.prev; s.prev = n; return h * Math.exp(-x * decay); }, g, pan);
  m.tick = (t, g = .08, pan = 0) => add(t, .03, (x, s) => { const n = noise(); const h = n - s.prev; s.prev = n; return h * Math.exp(-x * 400) + Math.sin(TAU * 2400 * x) * Math.exp(-x * 300) * .5; }, g, pan);
  // ---- hits and transitions ----
  /** Big downbeat: kick, sub drop and a dark crash. Use for drops, lands and the end card. */
  m.impact = (t, g = 1) => {
    m.kick(t, 1.1 * g);
    add(t, 2.5, (x, s) => { s.ph += 38 / SR; return Math.sin(TAU * s.ph) * Math.exp(-x * 1.6); }, .7 * g);
    add(t, 2.2, (x, s) => { s.lp += (noise() - s.lp) * (0.08 + .4 * Math.exp(-x * 4)); return s.lp * Math.exp(-x * 2.4); }, .9 * g, 0, .6);
  };
  /** Filtered-noise swish that pans across; put one under every camera move. */
  m.whoosh = (t, dur, g = .35, f0 = .02, f1 = .4, pan0 = -.6, pan1 = .6) => {
    t += m.offset;
    const s0 = Math.floor(t * SR), s1 = Math.min(N, Math.floor((t + dur) * SR)); let lp = 0, lp2 = 0;
    for (let i = Math.max(0, s0); i < s1; i++) {
      const p = (i - s0) / (s1 - s0); const c = f0 + (f1 - f0) * Math.sin(p * Math.PI);
      lp += (noise() - lp) * c; lp2 += (lp - lp2) * c; const v = (lp - lp2 * .6) * Math.sin(p * Math.PI) ** 2 * g;
      const pan = pan0 + (pan1 - pan0) * p; L[i] += v * Math.cos((pan + 1) * Math.PI / 4); R[i] += v * Math.sin((pan + 1) * Math.PI / 4);
      sendL[i] += v * .2; sendR[i] += v * .2;
    }
  };
  m.riser = (t, dur, g = .4) => add(t, dur, (x, s) => { const p = x / dur; const c = .01 + p * p * .5; s.lp += (noise() - s.lp) * c; s.ph += (180 + 1400 * p * p) / SR; return (s.lp * .8 + Math.sin(TAU * s.ph) * .15) * p * p; }, g, 0, .3);
  m.glitch = (t0, t1, g = .12) => { let t = t0; while (t < t1) { const d = .01 + rnd() * .04; const f = 200 + rnd() * 3000; add(t, d, (x, s) => { s.ph += f / SR; return (Math.sign(Math.sin(TAU * s.ph)) * .5 + noise() * .5) * (Math.floor(x * 3000) % 2); }, g * rnd(), rnd() * 2 - 1); t += d + rnd() * .02; } };
  // ---- tones ----
  /** Short pop: a message arriving, a chip appearing. f in Hz (use nf(midi)). */
  m.blip = (t, f, g = .25, pan = 0, decay = 22) => add(t, .35, (x, s) => { s.ph += f / SR; s.ph2 += f * 2.005 / SR; return (Math.sin(TAU * s.ph) + .35 * Math.sin(TAU * s.ph2)) * env(x, .002, decay); }, g, pan, .35);
  /** Glassy chime: Rally speaking, a reveal. */
  m.bell = (t, f, g = .2, pan = 0) => add(t, 2.5, (x, s) => { s.ph += f / SR; s.ph2 += f * 3.01 / SR; s.ph3 += f * 5.4 / SR; return (Math.sin(TAU * s.ph) * Math.exp(-x * 2) + .4 * Math.sin(TAU * s.ph2) * Math.exp(-x * 5) + .15 * Math.sin(TAU * s.ph3) * Math.exp(-x * 9)) * Math.min(1, x / .003); }, g, pan, .5);
  m.bass = (t, note, dur, g = .3) => { const f = nf(note); add(t, dur, (x, s) => { s.ph += f / SR; s.ph2 += f * 1.006 / SR; const raw = saw(s.ph) + saw(s.ph2); const c = .02 + .12 * Math.exp(-x * 14); s.lp += (raw - s.lp) * c; s.lp2 += (s.lp - s.lp2) * c; return (s.lp2 * .7 + Math.sin(TAU * s.ph) * .5) * Math.min(1, x / .004) * Math.min(1, (dur - x) / .02); }, g); };
  m.pad = (t, notes, dur, g = .08, attack = .3, release = 1) => notes.forEach((n, k) => { const f = nf(n); add(t, dur + release, (x, s) => { s.ph += f / SR; s.ph2 += f * 1.008 / SR; s.ph3 += f * .993 / SR; const raw = saw(s.ph) + saw(s.ph2) + saw(s.ph3); s.lp += (raw - s.lp) * .04; const e = Math.min(1, x / attack) * (x > dur ? Math.exp(-(x - dur) * 4 / release) : 1); return s.lp * e; }, g, (k / (notes.length - 1 || 1)) * 1.2 - .6, .6); });
  m.stab = (t, notes, g = .14) => notes.forEach((n, k) => { const f = nf(n); add(t, .6, (x, s) => { s.ph += f / SR; s.ph2 += f * 1.01 / SR; const raw = saw(s.ph) + saw(s.ph2); const c = .05 + .3 * Math.exp(-x * 20); s.lp += (raw - s.lp) * c; return s.lp * env(x, .003, 7); }, g, k % 2 ? .4 : -.4, .5); });

  // ---- patterns ----
  /**
   * The house groove: kick on every beat, clap on the off-beats, hats, a bass
   * that follows `chords` (one chord per `bar` seconds) and a soft pad.
   */
  m.groove = ({ from, to, beat = .5, bar = beat * 4, chords = [CHORDS.Bm, CHORDS.G, CHORDS.D, CHORDS.A], kick = .7, padGain = .025 }) => {
    for (let b = 0; ; b++) {
      const t = from + b * beat; if (t >= to - 1e-6) break;
      m.kick(t, kick); if (b % 2) m.clap(t, .25);
      m.hat(t + beat / 2, .08, .25); m.hat(t + beat / 4, .03, -.3, 120); m.hat(t + beat * .75, .03, -.3, 120);
      const ch = chords[Math.floor((t - from) / bar + 1e-6) % chords.length]; const root = ch[0] - 12;
      m.bass(t, root, beat * .45, .2); m.bass(t + beat / 2, root + 12, beat * .4, .14);
    }
    for (let i = 0; ; i++) { const t = from + i * bar; if (t >= to - 1e-6) break; m.pad(t, chords[i % chords.length], Math.min(bar, to - t), padGain, .2, .3); }
  };
  /** The end-card landing: impact, bright pad, two bells, a rising arpeggio. */
  m.endCard = (t, length = 3.5) => {
    m.impact(t, 1.1); m.pad(t, CHORDS.Dadd9, length - .9, .055, .02, 1.0);
    m.bell(t, nf(86), .12, -.3); m.bell(t + .08, nf(93), .07, .3);
    m.whoosh(t + .05, .65, .25, .02, .25, -.5, .5); m.whoosh(t + .7, .45, .2, .05, .4, -.6, .4);
    m.bell(t + 1.4, nf(90), .1, 0);
    [74, 78, 81, 86].forEach((n, i) => m.blip(t + .7 + i * .07, nf(n + 12), .07, (i - 1.5) / 2, 22));
  };

  /** Reverb send, soft limiter, normalise to -1 dBFS, short fade, 16-bit WAV. */
  m.write = (path) => {
    const reverb = (inp, combD, apD) => {
      const o = new Float32Array(N);
      combD.forEach(d => { const b = new Float32Array(d); let i = 0, lp = 0; for (let n = 0; n < N; n++) { const y = b[i]; lp = y * .7 + lp * .3; b[i] = inp[n] + lp * .8; o[n] += y; i = (i + 1) % d; } });
      apD.forEach(d => { const b = new Float32Array(d); let i = 0; for (let n = 0; n < N; n++) { const x = o[n]; const y = b[i] - .5 * x; b[i] = x + .5 * y; o[n] = y; i = (i + 1) % d; } });
      return o;
    };
    const rvL = reverb(sendL, [3114, 3234, 2982, 2844], [450, 1112]);
    const rvR = reverb(sendR, [3160, 3280, 3028, 2890], [496, 1158]);
    let peak = 1e-9;
    for (let i = 0; i < N; i++) { L[i] = Math.tanh((L[i] + rvL[i] * .12) * 1.1); R[i] = Math.tanh((R[i] + rvR[i] * .12) * 1.1); peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); }
    const fade = Math.floor(.25 * SR), gain = .89 / peak;
    const buf = Buffer.alloc(44 + N * 4);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);
    for (let i = 0; i < N; i++) {
      const f = i > N - fade ? (N - i) / fade : 1;
      buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i] * gain * f)) * 32767), 44 + i * 4);
      buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i] * gain * f)) * 32767), 46 + i * 4);
    }
    fs.writeFileSync(path, buf);
    return path;
  };
  return m;
}
