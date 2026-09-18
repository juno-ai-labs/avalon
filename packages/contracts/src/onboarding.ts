import { z } from 'zod';
import { ConnectorConnectionCardIds } from './connector-connection-card';

/**
 * What a person may be: every other colour around the ring, plus `black`.
 *
 * Stepping the ring in twos is what makes eight accents tell each other apart —
 * adjacent hues are neighbours by construction, so a contiguous eight would put
 * the least distinguishable colours in the same picker. `black` is here and not
 * in the project palette because a person appears once on a screen, where an
 * absence of colour reads as a deliberate choice rather than as an object that
 * failed to get one.
 */
export const PERSONAL_COLOR_KEYS = [
  'rose', 'orange', 'lime', 'emerald', 'blue', 'violet', 'fuchsia', 'black',
] as const;

/**
 * Accent names retired when the set above replaced them. They stay parseable —
 * a stored presentation is read back on every session — and resolve to the
 * nearest colour still offered, so nobody's avatar fails to render.
 */
export const PERSONAL_COLOR_KEYS_RETIRED = ['teal', 'green', 'amber', 'slate'] as const;

/**
 * Where a retired accent name lands. `teal` and `green` both sit closest to
 * `emerald` on the wheel, `amber` to `orange`, and `slate` was the neutral, so
 * it becomes the one the palette still has.
 */
export const PERSONAL_COLOR_ALIASES = {
  teal: 'emerald',
  green: 'emerald',
  amber: 'orange',
  slate: 'black',
} as const satisfies Record<(typeof PERSONAL_COLOR_KEYS_RETIRED)[number], (typeof PERSONAL_COLOR_KEYS)[number]>;

export const PersonalColorSchema = z.enum([...PERSONAL_COLOR_KEYS, ...PERSONAL_COLOR_KEYS_RETIRED]);

/** The palette key an accent paints with, following a retired name to its replacement. */
export function personalColorKey(color: z.infer<typeof PersonalColorSchema>): (typeof PERSONAL_COLOR_KEYS)[number] {
  return color in PERSONAL_COLOR_ALIASES
    ? PERSONAL_COLOR_ALIASES[color as keyof typeof PERSONAL_COLOR_ALIASES]
    : (color as (typeof PERSONAL_COLOR_KEYS)[number]);
}
export const PersonalAvatarSchema = z.enum(['circle', 'rounded', 'diamond', 'flower', 'spark', 'arch']);
export const PersonalPresentationSchema = z.object({
  // The regional identity bridge already requires names of at most 255 characters.
  displayName: z.string().trim().min(1).max(255).optional(),
  initials: z.string().trim().min(1).optional(),
  color: PersonalColorSchema,
  avatar: PersonalAvatarSchema,
  revision: z.number().int().nonnegative(),
});
export const AccountOnboardingSchema = z.object({
  eligible: z.boolean(),
  introduced: z.boolean(),
  presentation: PersonalPresentationSchema.nullable(),
  revision: z.number().int().nonnegative(),
});
export const UpdateAccountOnboardingSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  introduced: z.literal(true).optional(),
  presentation: PersonalPresentationSchema.omit({ revision: true }).optional(),
});
/**
 * Connectors the onboarding picker may offer, derived from the connection-card
 * catalog plus the three identities that have no card because they are not a
 * named provider: a Custom MCP server, an inbound webhook, and Rally's own
 * read-only X access.
 *
 * Derived rather than listed: this enum was a hand-kept copy of those ids, and
 * when Fireflies was added to the catalog and to the picker it was not added
 * here, so anyone who chose Fireflies during onboarding had their whole
 * selection rejected and could connect nothing at all. A new connection card is
 * now selectable in onboarding by construction.
 */
export const OnboardingConnectorIdSchema = z.enum([...ConnectorConnectionCardIds, 'custom-mcp', 'generic-webhook', 'x']);
export const OnboardingConnectorSelectionSchema = z.templateLiteral([z.enum(['workspace', 'you']), ':', OnboardingConnectorIdSchema]);
export const OnboardingJourneySchema = z.object({
  path: z.enum(['creator', 'member']),
  stage: z.enum(['connectors', 'people', 'profile', 'complete']),
  revision: z.number().int().nonnegative(),
  connectorIds: z.array(OnboardingConnectorSelectionSchema),
});
/**
 * A stored selection list, minus any id this build no longer offers.
 *
 * Reads are deliberately more forgiving than writes. The stored array is parsed
 * on every read of a journey, and `update` reads before it writes, so a
 * connector id that leaves the catalog would otherwise make an existing
 * journey unreadable rather than merely unsaveable: the person could not see or
 * advance their own onboarding, and the rejection would cross the workspace
 * object's RPC hop as a bare `Error`. Retired accent names are kept parseable
 * above for the same reason. A selection nobody can act on any more is noise, so
 * it is dropped on the way out; a write still has to name ids that exist, at the
 * boundary that can report which one did not.
 */
export const StoredOnboardingConnectorSelectionsSchema = z.array(z.unknown()).transform((values) =>
  values.filter((value): value is z.infer<typeof OnboardingConnectorSelectionSchema> =>
    OnboardingConnectorSelectionSchema.safeParse(value).success));
export const UpdateOnboardingJourneySchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  stage: OnboardingJourneySchema.shape.stage,
  connectorIds: z.array(OnboardingConnectorSelectionSchema).optional(),
});
export type PersonalPresentation = z.infer<typeof PersonalPresentationSchema>;
export type AccountOnboarding = z.infer<typeof AccountOnboardingSchema>;
export type UpdateAccountOnboarding = z.infer<typeof UpdateAccountOnboardingSchema>;
export type OnboardingConnectorId = z.infer<typeof OnboardingConnectorIdSchema>;
export type OnboardingJourney = z.infer<typeof OnboardingJourneySchema>;
export type UpdateOnboardingJourney = z.infer<typeof UpdateOnboardingJourneySchema>;
