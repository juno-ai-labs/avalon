/**
 * The colour palette itself: the keys, and which ink reads on each fill.
 *
 * Its own module because it is not about Spaces. Every glyph, avatar, and
 * design token in the product draws from these nineteen keys — a Space, a
 * Channel, a Project, a person's account accent — and the registries that say
 * which of them a *particular* object may hold live with that object, in
 * `spaces.ts` and `projects.ts`. Those import this; this imports nothing.
 *
 * Re-exported from `spaces.ts` and from the package index, so every existing
 * importer is unchanged.
 */

/**
 * The hue ring: fourteen colours in wheel order, `pink` adjacent to `rose` so
 * the sequence closes on itself.
 *
 * The pickers rely on that — each runs its first row left to right and its
 * second right to left, so both seams of the ring meet rather than jumping back
 * across the grid. Reordering this list reorders the swatches and breaks a seam;
 * add a hue where it belongs on the wheel, not at the end.
 */
export const PALETTE_RING = [
  "rose",
  "red",
  "orange",
  "amber",
  "lime",
  "green",
  "emerald",
  "cyan",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
] as const;

/**
 * Keys retired when the palette became the ring. Rows written before that still
 * hold them, and a stored value has to survive a read —
 * `WorkstreamAppearanceSchema.parse` runs on every work-stream read and throws
 * rather than degrading — so they stay storable, keep their design tokens, and
 * keep rendering exactly as they did. Nothing recolours under anyone; the
 * colour simply cannot be chosen again.
 */
export const PALETTE_RETIRED = [
  "gray",
  "brown",
  "yellow",
  "teal",
] as const;

/**
 * Every colour the design system defines a token for: the ring, the `black`
 * neutral, and the retired keys still being rendered for whoever holds one.
 *
 * This is the vocabulary, not a menu. What a *Space* may be and what a
 * *person* may be are narrower lists below, and they are deliberately different
 * — `black` is the account accent's alone.
 */
export const PALETTE_KEYS = [...PALETTE_RING, "black", ...PALETTE_RETIRED] as const;
export type PaletteKey = (typeof PALETTE_KEYS)[number];

/**
 * Which ink reads on each fill.
 *
 * The basis is APCA — the perceptual contrast model the WCAG 3 drafts are built
 * on — together with a look at every fill at the sizes it actually ships. It is
 * deliberately not WCAG 2's relative-luminance ratio, which this table used to
 * follow. WCAG 2 makes black the winner on sixteen of these nineteen fills,
 * `blue`, `red` and `violet` among them, where a white symbol plainly reads
 * better and where every other design system ships white. Thirteen of those
 * sixteen are what this table reversed; the other three still take black. Its luminance curve is
 * known to misjudge saturated mid-tones, and this palette is nothing but
 * saturated mid-tones: on `blue` it scores black 5.71 against white's 3.68,
 * while APCA scores white Lc 69 against black's Lc 40.
 *
 * The boundary sits between `green` and `cyan`, and it was set by review rather
 * than by arithmetic alone. APCA's own crossover is one step further along,
 * between `emerald` and `orange`, but the fills on either side of it are ties in
 * its terms — `cyan` is Lc 52 white against Lc 57 black, `emerald` Lc 54 against
 * Lc 55. Where the two inks tie, the ring reads better with one of them running
 * through it than with two exceptions stranded in the middle.
 *
 * What this knowingly gives up: none of the thirteen fills this change flips to
 * white meets WCAG 2's 4.5:1 for text with that ink — they are scattered around
 * the ring rather than being a run of it — and four of them —
 * `cyan` at 2.43:1, `emerald`, `orange`, `yellow` — are under even the 3:1 that
 * standard asks of a graphical object. An audit run against WCAG 2 will flag
 * them. That is the price of following the model that matches what is on the
 * screen, and it is recorded here so the next person meets it as a decision
 * rather than as a surprise.
 *
 * `emerald` and `orange` are the weakest entries whichever ink they take:
 * neither reaches APCA's Lc 60 for body text on them, and these fills carry
 * message-bubble prose, so that gap is real. It belongs to the fills rather than
 * to this table — darkening those two closes it and no ink choice can.
 *
 * Checked in rather than computed at render, so a value change that flips an ink
 * has to be a visible edit; `palette.css.node.test.ts` holds the readable floor
 * against the tokens in both appearances, and pins both the WCAG 2 shortfall and
 * the two APCA ties by name so neither can grow unnoticed.
 */
export const PALETTE_INK = {
  rose: "white",
  red: "white",
  orange: "white",
  amber: "black",
  lime: "black",
  green: "black",
  emerald: "white",
  cyan: "white",
  blue: "white",
  indigo: "white",
  violet: "white",
  purple: "white",
  fuchsia: "white",
  pink: "white",
  black: "white",
  gray: "white",
  brown: "white",
  yellow: "white",
  teal: "white",
} as const satisfies Record<PaletteKey, "white" | "black">;
