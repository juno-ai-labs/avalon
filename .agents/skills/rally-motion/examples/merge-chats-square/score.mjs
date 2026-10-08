// Score for scene.html. Cues follow the scene's timeline: tense and thin while the
// two chats are apart, a release on the merge, the house groove once it flows.
import { createMix, CHORDS, nf } from '../../kit/audio-lib.mjs';

const m = createMix(15);
const { Bm, G, D, A } = CHORDS;

// apart: an uneasy pad, no groove
m.kick(0, .5); m.pad(0, [47, 54, 59, 62], 2.9, .03, .05, .4);
m.pad(2.9, [46, 53, 58, 61], 2.4, .03, .3, .2); // slips down a semitone as it strains
const ai = t => m.blip(t, nf(64), .13, 0, 32); // the generic assistant: dull, no bell
const human = (t, pan) => { m.blip(t, nf(81), .18, pan); m.blip(t + .1, nf(76), .08, pan, 30); };
human(1.95, .4); ai(2.35); human(2.95, -.4); ai(3.2); human(3.95, .4); ai(4.27);
human(4.45, -.4); ai(4.72); human(4.98, .4);
// each paste: the receiver grabs the other AI's answer and drags it home, landing with a knock; the trips speed up
[[1.35, .6, -1], [3.5, .45, -1], [4.05, .4, 1], [4.52, .32, -1], [4.84, .24, 1], [5.02, .2, -1]].forEach(([t, d, dir], i) => {
  m.tick(t, .12, dir * .6);
  m.whoosh(t + d * .2, d * .8, .22 + i * .03, .03, .45, dir * .7, -dir * .7);
  m.kick(t + d, .35 + i * .06); m.blip(t + d, nf(50), .12, -dir * .6, 18);
  if (i >= 2) m.stab(t + d, [47, 48, 54], .05 + i * .01); // grating cluster as it piles up
});
m.riser(3.0, 2.25, .32);

// the merge: both chats' messages slide into one interleaved Channel, newest first
m.whoosh(5.18, .6, .4, .02, .5, -.8, .8);
for (let j = 0; j < 6; j++) m.tick(5.62 + j * .035, .07, j % 2 ? .5 : -.5); // messages landing
m.impact(5.72, 1); m.bell(5.74, nf(86), .1, 0);

// together: the groove, a blip per person, a bell when Rally speaks
m.groove({ from: 5.72, to: 11.4, beat: .5, bar: 2, chords: [D, A, Bm, G] });
m.blip(6.15, nf(83), .2, .3); m.blip(6.27, nf(88), .1, .3, 30); // Bob
m.bell(6.6, nf(81), .12, -.3); for (let i = 0; i < 11; i++) m.tick(6.65 + i * .04, .03, -.35);
m.blip(7.5, nf(79), .2, .3); // Alice
m.bell(7.9, nf(83), .12, -.3); for (let i = 0; i < 12; i++) m.tick(7.95 + i * .04, .03, -.35);
[86, 90].forEach((n, i) => m.blip(8.95 + i * .12, nf(n), .1, i - .5, 30)); // reactions
m.blip(9.4, nf(83), .2, .3); // Bob
m.blip(10.1, nf(88), .2, .3); m.stab(10.1, D, .06); // Shipping it.

m.riser(10.75, .65, .3);
m.endCard(11.4, 3.6);

m.write(process.env.OUT_WAV || new URL('./score.wav', import.meta.url).pathname);
