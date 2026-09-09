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
 * The icon nobody has to argue for.
 *
 * Something has to be chosen when no subject in the catalog matches the work,
 * and it is named here rather than in the prompt so the prompt's fallback and
 * the deterministic one a caller reaches for cannot drift apart.
 */
export const DEFAULT_WORKSTREAM_ICON_KEY = "sparkles" satisfies WorkstreamIconKey;

/**
 * What each icon draws, and the work it suits.
 *
 * These are written for a model rather than for a reader: the naming pass
 * chooses an icon alongside the name, and a key on its own — `spline`,
 * `aperture`, `component` — says nothing about what a person will see in the
 * sidebar. The first sentence is the drawing, so the choice is made against the
 * mark rather than against a word that happens to appear in the request; the
 * second is the kind of work it fits, so a model that recognizes the drawing
 * still knows when to reach for it. A `Record` keyed by the icon type is what
 * makes this exhaustive: adding a key to {@link WORKSTREAM_ICON_KEYS} without
 * describing it fails to compile rather than shipping a choice the model is
 * asked to make blind.
 *
 * They are shown to a model and must stay in the plain vocabulary
 * [`writing-prompts.md`](../../../docs/writing-prompts.md) asks for — no icon
 * library names, no internal terms. The keys themselves are stored values and
 * cannot change without a migration; the descriptions can be reworded freely,
 * which is the point of keeping them apart from the keys.
 */
export const WORKSTREAM_ICON_DESCRIPTIONS: Record<WorkstreamIconKey, string> = {
  aperture: "A camera aperture: a ring crossed by angled blades that spiral in toward the centre. Fits looking closely at something — an investigation, an audit, or a review of how something currently works.",
  atom: "An atomic nucleus with two elliptical electron paths crossing around it. Fits research, experiments, and scientific or deeply technical study.",
  boxes: "Three stacked cubes, one resting on the two beneath it. Fits inventory, collections of things, and work that assembles many parts into one whole.",
  "circle-dot": "A small filled dot centred inside an open ring, like a target seen head on. Fits a single focused item, one open question, or one status being tracked.",
  "circuit-board": "A printed circuit board: straight traces branching between small round contact pads. Fits hardware, infrastructure, and wiring systems together.",
  component: "Four small squares arranged as a diamond, the pieces of one modular part. Fits design systems, reusable building blocks, and work on one part of a larger product.",
  dices: "Two dice drawn in perspective with their pips showing. Fits chance, games, and exploratory bets whose outcome is genuinely uncertain.",
  orbit: "A small circle travelling along an elliptical path around a larger one. Fits recurring cycles, watching something over time, and work that revolves around one subject.",
  sparkles: "One large four-pointed star with two smaller ones beside it. The general-purpose mark: fits anything new, open-ended, or creative that no other icon describes.",
  spline: "A curve drawn between two square control handles, as in a drawing program. Fits smoothing, tuning, and adjusting the shape of a path or a plan.",
  "wand-sparkles": "A magic wand held at an angle, throwing off small sparks. Fits generating something, transforming existing material, and automatic cleanups.",
  workflow: "Two boxes joined by an elbow connector to a third, the shape of a flow chart. Fits processes, pipelines, and multi-step procedures.",
  briefcase: "A business case with a handle above and a clasp across the middle. Fits company operations, client accounts, employment, and general professional business.",
  target: "Concentric rings with a filled bullseye at the centre. Fits goals, numbers to hit, and a priority stated precisely enough to aim at.",
  "calendar-days": "A month grid beneath a header bar with two hanging rings, dots marking the days. Fits scheduling, meetings, dates, and deadlines.",
  "list-checks": "Two ticked lines above a third still waiting, a checklist part way done. Fits to-do lists, tracked tasks, and step-by-step work with progress to record.",
  "clipboard-list": "A clipboard with a clip at the top and ruled lines with bullets on it. Fits intake forms, requirements gathering, surveys, and structured notes.",
  "file-text": "A single page with a folded corner and lines of writing across it. Fits documents, drafts, reports, specifications, and written deliverables.",
  folder: "A closed file folder with a raised tab on the left. Fits filing, organizing, archives, and work that gathers many materials in one place.",
  lightbulb: "A light bulb with a filament inside and a screw base below. Fits ideas, brainstorming, proposals, and early concept work.",
  star: "A single five-pointed star. Fits favourites, highlights, quality and reputation, and work about what stands out.",
  flag: "A rectangular banner flying from a vertical pole. Fits milestones, launches, escalations, and anything marked for attention.",
  rocket: "A rocket standing on its fins with exhaust beneath it. Fits launches, releases, growth pushes, and getting something new off the ground.",
  "chart-no-axes-combined": "A rising line drawn over ascending bars, with no axes around them. Fits analytics, reporting, and performance measured over time.",
  calculator: "A pocket calculator with a display panel above a grid of keys. Fits arithmetic, budgets, pricing, estimates, and quantitative checks.",
  coins: "Two overlapping coins, one face on and one seen edge on behind it. Fits money, revenue, costs, invoices, payments, and finance.",
  users: "Two people shown head and shoulders, one standing slightly behind the other. Fits teams, groups, hiring, community, and work about people together.",
  "user-search": "One person beside a magnifying glass. Fits recruiting, looking into a particular person or account, and background research on someone.",
  handshake: "Two hands clasped together. Fits deals, partnerships, negotiations, agreements, and customer relationships.",
  megaphone: "A cone-shaped bullhorn with a handle, pointing up and to the right. Fits announcements, marketing, campaigns, and outbound communication.",
  palette: "An artist's palette with a thumb hole and four wells of paint. Fits visual design, branding, colour, and creative direction.",
  image: "A picture frame with a small sun and a mountain horizon inside it. Fits photographs, screenshots, galleries, and image production or editing.",
  "pen-tool": "A drawing pen nib with a path handle running through it. Fits illustration, precise drawing, editing artwork, and hands-on authoring.",
  package: "A closed shipping box with a strap over its lid. Fits shipping, deliveries, orders, and released bundles of work.",
  "building-2": "Two office buildings side by side, the taller one with rows of windows. Fits companies, offices, property, and institutional or organizational work.",
  "globe-2": "A globe with meridian and latitude lines curving across it. Fits international work, travel, the public web, and anything worldwide.",
  heart: "A single heart outline. Fits well-being, personal and family matters, and work driven by care rather than obligation.",
};

export const WorkstreamAppearanceSchema = z.strictObject({
  icon: WorkstreamIconKeySchema.nullable(),
  /** Stable semantic palette key; resolve through the current appearance tokens, never store a CSS color. */
  color: z.enum(PROJECT_COLOR_KEYS).nullable(),
});
export const WorkstreamAppearancePatchSchema = WorkstreamAppearanceSchema.partial();
export type WorkstreamAppearance = z.infer<typeof WorkstreamAppearanceSchema>;
export type WorkstreamAppearancePatch = z.infer<typeof WorkstreamAppearancePatchSchema>;
