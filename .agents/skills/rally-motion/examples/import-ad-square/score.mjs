// Score for scene.html. Every cue is a time from the scene's timeline, so if the
// picture moves, move the cue with it.
import { createMix, CHORDS, nf } from '../../kit/audio-lib.mjs';

const m = createMix(17.5);
const { Bm, G, D, A } = CHORDS;

// hook: three cards
m.pad(0, [50, 57, 62, 66], 1.85, .03, .05, .3);
m.kick(0, .6); [79, 76, 83, 86].forEach((n, i) => m.blip(.05 + i * .08, nf(n), .08, i / 1.5 - 1, 30));
m.whoosh(1.85, .4, .3, .03, .45, .8, -.8);
m.pad(1.98, [47, 54, 59, 62], 2.3, .03, .1, .3);
m.blip(2.45, nf(81), .1, -.3, 26); // menu item appears
m.whoosh(2.98, .28, .25, .05, .5, -.8, .8); m.clap(3.0, .35); m.stab(3.0, Bm, .05); // strike
m.blip(3.22, nf(86), .14, .2, 20); m.blip(3.3, nf(90), .1, .2, 26); // ChatGPT swaps in
m.tick(3.55, .18, -.3); m.blip(3.55, nf(88), .12, -.3, 26); // click
m.whoosh(4.25, .4, .35, .03, .45, 0, 0);
m.impact(4.38, .75); m.pad(4.38, D, 1.4, .04, .05, .4);
[74, 78, 81, 86].forEach((n, i) => m.blip(4.55 + i * .07, nf(n), .1, i / 1.5 - 1, 28));

// the Channel: a groove under the whole story
m.whoosh(5.75, .5, .35, .02, .4, 0, 0);
m.groove({ from: 6.1, to: 13.55, beat: .5, bar: 2, chords: [Bm, G, D, A] });
for (let i = 0; i < 6; i++) m.blip(6.07 + i * .07, nf([62, 66, 69, 74, 78, 81][i]), .045, i % 2 ? -.4 : .4, 45); // history fades in
m.blip(6.67, nf(86), .07, 0, 30); // divider
m.blip(6.85, nf(83), .2, .3); m.blip(6.97, nf(79), .1, .3, 30); // Priya
m.whoosh(8.57, .3, .15, .05, .5, -.4, .4);
m.blip(8.85, nf(83), .2, .3); m.blip(8.97, nf(88), .1, .3, 30); // Maya
m.bell(9.5, nf(81), .12, -.3); m.bell(9.58, nf(86), .1, -.3); // Rally
for (let i = 0; i < 14; i++) m.tick(9.55 + i * .042, .035, -.35);
m.stab(10.15, D, .06);
m.whoosh(11.07, .3, .15, .05, .5, .4, -.4);
m.blip(11.25, nf(79), .2, .3); m.blip(11.75, nf(76), .2, .3);
[86, 90, 93].forEach((n, i) => m.blip(11.9 + i * .12, nf(n), .1, i - 1, 30)); // reactions
m.impact(11.85, .35);

// end card
m.riser(12.85, .7, .3);
m.endCard(13.55, 3.9);

m.write(process.env.OUT_WAV || new URL('./score.wav', import.meta.url).pathname);
