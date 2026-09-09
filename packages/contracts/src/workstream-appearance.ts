import { z } from "zod";
import { PROJECT_COLOR_KEYS, PROJECT_ICON_KEYS } from "./projects";

export const WORKSTREAM_ICON_KEYS = [
  "aperture", "atom", "boxes", "circle-dot", "circuit-board", "component",
  "dices", "orbit", "sparkles", "spline", "wand-sparkles", "workflow",
  ...PROJECT_ICON_KEYS,
] as const;
export const WorkstreamIconKeySchema = z.enum(WORKSTREAM_ICON_KEYS);
export type WorkstreamIconKey = z.infer<typeof WorkstreamIconKeySchema>;

/**
 * The icon to fall back on when no mark in the catalog suits the work.
 *
 * The one place the product has an opinion about *which* icon to use, and it is
 * here rather than in a description because it is a rule about the choice
 * rather than a fact about the drawing: something has to be picked when nothing
 * fits, and the prompt's fallback and the one a caller reaches for must not
 * drift apart.
 *
 * `circle-dot` rather than `sparkles`, which reads as the obvious "generic"
 * mark and is the wrong one here: sparkles is already Rally's own glyph in this
 * product — the mention icon in the composer and the account menu — so putting
 * it on every work stream no icon suits would badge exactly those rows as "the
 * agent did this". A plain dot in a ring says nothing, which is what a fallback
 * should say.
 */
export const DEFAULT_WORKSTREAM_ICON_KEY = "circle-dot" satisfies WorkstreamIconKey;

/**
 * What each icon draws.
 *
 * Written for a model rather than for a reader: the naming pass chooses an icon
 * alongside the name, and a key on its own — `spline`, `aperture`, `component` —
 * says nothing about the mark a person will see in the sidebar.
 *
 * **These describe the drawing and nothing else.** No description says what
 * kind of work an icon is for, and none should: which mark suits a work stream
 * is the model's judgement, made against the whole catalog with the request in
 * front of it, and a usage note here would be a decision taken in advance by
 * whoever last edited this file. It would also narrow the icon to the cases
 * that note happened to list, and be wrong for every request whose subject the
 * writer did not think of. Describe the drawing; let the choosing happen where
 * the request is.
 *
 * Describing it does mean naming *what it depicts* — a pair of coins, a
 * checklist, an artist's palette — and not only its geometry. That is a fact
 * about the picture rather than an opinion about its use, and it is the fact
 * that matters: an earlier draft of these lines described `coins` as two
 * overlapping discs and `list-checks` as ticked lines above an unticked one,
 * and the model, left to work out what the shapes were, put a checklist on an
 * invoice reconciliation. Say what the reader would call the thing, then how it
 * is drawn.
 *
 * A `Record` keyed by the icon type is what makes this exhaustive: adding a key
 * to {@link WORKSTREAM_ICON_KEYS} without describing it fails to compile rather
 * than shipping a mark the model is asked to choose blind.
 *
 * They are shown to a model and must stay in the plain vocabulary
 * [`writing-prompts.md`](../../../docs/writing-prompts.md) asks for — no icon
 * library names, no internal terms. The keys themselves are stored values and
 * cannot change without a migration; the descriptions can be reworded freely,
 * which is the point of keeping them apart from the keys.
 */
export const WORKSTREAM_ICON_DESCRIPTIONS: Record<WorkstreamIconKey, string> = {
  aperture: "A camera aperture: a ring of straight, angled blades that overlap and spiral inward, leaving a small opening at the centre.",
  atom: "An atom: a dot for the nucleus at the centre of two long, narrow ellipses that cross each other at an angle, the paths of its electrons.",
  boxes: "Three cubes stacked in perspective, two side by side below and a third resting in the notch above them, each showing its top face and two sides.",
  "circle-dot": "A single filled dot floating at the exact centre of an open ring, with clear space between the two.",
  "circuit-board": "A circuit board: a square panel with straight traces running across it and turning through square corners, each ending at a small round contact pad.",
  component: "Four small squares at the four points of a diamond, evenly spaced around an empty centre, reading as separable pieces of one shape.",
  dices: "Two dice drawn in perspective and overlapping slightly, with round pips on the faces that show.",
  orbit: "An orbit: a circle with a wide ellipse looping around it on a tilt, and one small filled body riding on that ellipse.",
  sparkles: "One large four-pointed star with concave sides, and two much smaller stars of the same shape near its corners.",
  spline: "A curve running between two small squares, one at each end, that mark its ends and set how it bends.",
  "wand-sparkles": "A magic wand lying on a diagonal with a narrow band near its lower end, and small four-pointed sparks scattered off its tip.",
  workflow: "A flow chart of two rounded boxes, one above the other and offset sideways, joined by a line that leaves the first, turns a right angle, and enters the second.",
  briefcase: "A briefcase: a rectangular case with a short handle standing above its top edge and a horizontal band across the middle where it opens.",
  target: "A target seen head on: three circles nested one inside another with even gaps, and a filled dot at the bullseye.",
  "calendar-days": "A calendar page: a rectangle with a band across the top, two short binder rings rising from it, and rows of small dots for the days beneath.",
  "list-checks": "A checklist: two short lines each preceded by a tick, above a third line preceded by an empty square.",
  "clipboard-list": "A clipboard with a clip centred on its top edge, holding a page of short lines each preceded by a bullet.",
  "file-text": "A written document: a portrait page with its top-right corner folded back and three lines of writing across the lower half.",
  folder: "A file folder seen from the front, its back panel stepped up on the left into a tab above the straight top edge of the front.",
  lightbulb: "A light bulb: a round glass on a short screw base crossed by two bands, with a small filament arc inside.",
  star: "A single five-pointed star with straight edges, drawn as one continuous outline.",
  flag: "A flag: a vertical pole with a rectangular banner attached along its upper half, extending to one side.",
  rocket: "A rocket standing on end, tapering to a nose cone, with two fins flared at its base, a round window in the body, and a flame beneath it.",
  "chart-no-axes-combined": "A chart of bars rising left to right with a trend line drawn across their tops, and no axes around them.",
  calculator: "A calculator: an upright rectangle with a wide display panel across the top and a grid of small square keys below it.",
  coins: "Two coins, one seen face on with a mark stamped in its middle and a second behind it seen at an angle, so the pair reads as a small stack.",
  users: "Two people shown head and shoulders, one drawn in full at the front and a second partly hidden behind its shoulder.",
  "user-search": "One person shown head and shoulders with a magnifying glass beside them, the glass a circle with a short handle.",
  handshake: "Two hands clasped in a handshake, the forearms meeting from opposite sides and the fingers interlocked.",
  megaphone: "A megaphone: a cone widening left to right and tilted upward, open at the wide end, with a small handle beneath it.",
  palette: "An artist's paint palette: a rounded blob with a thumb hole bitten out of one side and four wells of paint spaced around its edge.",
  image: "A framed picture: a square frame with a small sun near one upper corner and a diagonal line rising from the lower edge like a hill horizon.",
  "pen-tool": "A pen nib: two lines converging to a point with a small opening at the tip, and a straight path handle running through it, ending in a point at each side.",
  package: "A shipping box in perspective, a strap running over the top face and down the front, and a seam where the lid meets the body.",
  "building-2": "Two office towers side by side, one taller than the other, each ruled into rows of small square windows.",
  "globe-2": "A globe: a circle crossed by a curved meridian and one or more curved latitude lines, so it reads as a sphere rather than a flat disc.",
  heart: "A single heart drawn as one outline, two lobes meeting in a dip at the top and tapering to a point at the bottom.",
};

export const WorkstreamAppearanceSchema = z.strictObject({
  icon: WorkstreamIconKeySchema.nullable(),
  /** Stable semantic palette key; resolve through the current appearance tokens, never store a CSS color. */
  color: z.enum(PROJECT_COLOR_KEYS).nullable(),
});
export const WorkstreamAppearancePatchSchema = WorkstreamAppearanceSchema.partial();
export type WorkstreamAppearance = z.infer<typeof WorkstreamAppearanceSchema>;
export type WorkstreamAppearancePatch = z.infer<typeof WorkstreamAppearancePatchSchema>;
