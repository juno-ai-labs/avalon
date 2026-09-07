import { z } from 'zod';

export const PersonalColorSchema = z.enum(['blue', 'teal', 'green', 'amber', 'orange', 'rose', 'violet', 'slate']);
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
export const OnboardingJourneySchema = z.object({
  path: z.enum(['creator', 'member']),
  stage: z.enum(['connectors', 'people', 'profile', 'example', 'complete', 'skipped']),
  revision: z.number().int().nonnegative(),
  starterWorkstreamId: z.string().uuid().nullable(),
  starterMessageId: z.string().uuid(),
  connectorIds: z.array(z.string().min(1)),
});
export const UpdateOnboardingJourneySchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  stage: OnboardingJourneySchema.shape.stage,
  starterWorkstreamId: z.string().uuid().optional(),
  connectorIds: z.array(z.string().min(1)).optional(),
});
export type PersonalPresentation = z.infer<typeof PersonalPresentationSchema>;
export type AccountOnboarding = z.infer<typeof AccountOnboardingSchema>;
export type UpdateAccountOnboarding = z.infer<typeof UpdateAccountOnboardingSchema>;
export type OnboardingJourney = z.infer<typeof OnboardingJourneySchema>;
export type UpdateOnboardingJourney = z.infer<typeof UpdateOnboardingJourneySchema>;

export const DiscoverOnboardingTeammatesSchema = z.strictObject({
  connectionId: z.string().uuid(), timeMin: z.string().datetime(), timeMax: z.string().datetime(),
  pageToken: z.string().optional(),
}).refine((value) => value.timeMin < value.timeMax, { message: 'Choose an end date after the start date.' });
export const OnboardingTeammatesSchema = z.object({
  items: z.array(z.object({ email: z.email(), name: z.string(), meetings: z.array(z.string()) })),
  nextPageToken: z.string().nullable(), partial: z.boolean(),
});
export type OnboardingTeammates = z.infer<typeof OnboardingTeammatesSchema>;
export type DiscoverOnboardingTeammates = z.infer<typeof DiscoverOnboardingTeammatesSchema>;
