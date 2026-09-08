import { z } from 'zod';

export const PersonalColorSchema = z.enum(['blue', 'teal', 'green', 'amber', 'orange', 'rose', 'violet', 'slate']);
/** Colors a profile picker may offer. `orange` stays valid on the wire. */
export const PERSONAL_COLOR_CHOICES = ['blue', 'teal', 'green', 'amber', 'rose', 'violet', 'slate'] as const;
export type PersonalColor = z.infer<typeof PersonalColorSchema>;
export type PersonalColorChoice = (typeof PERSONAL_COLOR_CHOICES)[number];

export function paintPersonalColor(color: PersonalColor): PersonalColorChoice {
  return color === 'orange' ? 'amber' : color;
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
export const OnboardingConnectorIdSchema = z.enum(['google-mail-calendar', 'google-drive-workspace', 'github', 'granola', 'linear', 'slack', 'notion', 'custom-mcp', 'generic-webhook', 'x']);
export const OnboardingConnectorSelectionSchema = z.templateLiteral([z.enum(['workspace', 'you']), ':', OnboardingConnectorIdSchema]);
export const OnboardingJourneySchema = z.object({
  path: z.enum(['creator', 'member']),
  stage: z.enum(['connectors', 'people', 'profile', 'complete']),
  revision: z.number().int().nonnegative(),
  connectorIds: z.array(OnboardingConnectorSelectionSchema),
});
export const UpdateOnboardingJourneySchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  stage: OnboardingJourneySchema.shape.stage,
  connectorIds: z.array(OnboardingConnectorSelectionSchema).optional(),
});
export type PersonalPresentation = z.infer<typeof PersonalPresentationSchema>;
export type AccountOnboarding = z.infer<typeof AccountOnboardingSchema>;
export type UpdateAccountOnboarding = z.infer<typeof UpdateAccountOnboardingSchema>;
export type OnboardingJourney = z.infer<typeof OnboardingJourneySchema>;
export type UpdateOnboardingJourney = z.infer<typeof UpdateOnboardingJourneySchema>;
