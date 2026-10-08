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
// each paste: an AI answer selected, carried across, landing with a knock; the trips speed up
[[1.35, .6, -1], [3.5, .45, -1], [4.05, .4, 1], [4.52, .32, -1], [4.84, .24, 1], [5.02, .2, -1]].forEach(([t, d, dir], i) => {
  m.tick(t, .12, dir * .6);
  m.whoosh(t + d * .2, d * .8, .22 + i * .03, .03, .45, dir * .7, -dir * .7);
  m.kick(t + d, .35 + i * .06); m.blip(t + d, nf(50), .12, -dir * .6, 18);
  if (i >= 2) m.stab(t + d, [47, 48, 54], .05 + i * .01); // grating cluster as it piles up
});
m.riser(3.0, 2.25, .32);

// the merge: windows slam together, then open into one Channel
m.whoosh(5.18, .32, .4, .02, .5, -.8, .8);
m.impact(5.48, 1); m.bell(5.5, nf(86), .1, 0);

// together: the groove, a blip per person, a bell when Rally speaks
m.groove({ from: 5.5, to: 11.4, beat: .5, bar: 2, chords: [D, A, Bm, G] });
m.blip(5.85, nf(83), .2, .3); m.blip(5.97, nf(88), .1, .3, 30); // Bob
m.bell(6.3, nf(81), .12, -.3); for (let i = 0; i < 10; i++) m.tick(6.35 + i * .04, .03, -.35);
m.blip(7.2, nf(79), .2, .3); // Alice
m.bell(7.6, nf(83), .12, -.3); for (let i = 0; i < 9; i++) m.tick(7.65 + i * .04, .03, -.35);
m.blip(8.75, nf(83), .2, .3); // Bob
m.bell(9.15, nf(86), .12, -.3); for (let i = 0; i < 12; i++) m.tick(9.2 + i * .04, .03, -.35);
[86, 90].forEach((n, i) => m.blip(10.0 + i * .12, nf(n), .1, i - .5, 30)); // reactions
m.blip(10.3, nf(88), .2, .3); m.stab(10.3, D, .06); // Shipping it.

m.riser(10.75, .65, .3);
m.endCard(11.4, 3.6);

m.write(process.env.OUT_WAV || new URL('./score.wav', import.meta.url).pathname);
