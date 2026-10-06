// Score for scene.html: 133 BPM so each tile change lands on a downbeat.
import { createMix, CHORDS, nf } from '../../kit/audio-lib.mjs';

const m = createMix(30);
const BEAT = .45;

m.pad(0, [50, 57, 62, 66], 2.6, .035, .05, .4);
m.kick(0, .6); m.blip(0, nf(74), .1); m.blip(BEAT, nf(78), .08, .3, 26);
m.whoosh(2.1, .55, .4, .02, .45, 0, 0); m.riser(1.6, 1.1, .25);
m.impact(2.7, .8);
m.groove({ from: 2.7, to: 23.4, beat: BEAT, bar: BEAT * 4 });
// one move per tile: a whoosh under the camera, a bell when it lands
const tour = [2.7, 5.4, 7.2, 9.0, 10.8, 12.6, 14.4, 16.2, 18.0, 19.8, 21.6];
const notes = [86, 81, 83, 88, 90, 86, 81, 83, 88, 90, 93];
tour.forEach((t, i) => {
  if (i) m.whoosh(t - .06, .5, .28, .03, .45, i % 2 ? -.7 : .7, i % 2 ? .7 : -.7);
  m.bell(t + .14, nf(notes[i]), .09, i % 2 ? .3 : -.3); m.blip(t + .5, nf(notes[i] + 7), .06, 0, 30); m.blip(t + .95, nf(notes[i] + 12), .04, 0, 34);
});
// pull back to the whole grid and hold
m.riser(22.6, .8, .3); m.whoosh(23.35, .9, .4, .02, .4, 0, 0);
m.impact(24.3, .75); m.stab(24.3, CHORDS.Dadd9.slice(0, 5), .08);
m.pad(24.3, CHORDS.Dadd9, 4.6, .05, .05, 1.1);
m.bell(24.3, nf(86), .1, -.3); m.bell(24.38, nf(93), .06, .3);
[74, 78, 81, 86, 90].forEach((n, i) => m.bell(25.2 + i * .45, nf(n + 12), .05, (i - 2) / 2));

m.write(process.env.OUT_WAV || new URL('./score.wav', import.meta.url).pathname);
