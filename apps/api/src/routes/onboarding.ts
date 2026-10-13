import { observeSignupProgress, requestSignupPlatform } from '../telemetry/signup';
import { regionalBindings } from "../lib/regional-bindings";
import type { Region } from "@rally/contracts/regions";
import { publishWorkspaceSync } from '../services/workspace-realtime-service';
import { AccountOnboardingService } from '../services/account-onboarding-service';
import { AccountOnboardingSchema, UpdateAccountOnboardingSchema } from '@rally/contracts';
import { RALLY_HEADERS, readRallyHeader } from "@rally/contracts/http-headers";
import { clientOpensGuestWorkspaces } from "../lib/client-contract";
import { zValidator } from "../middleware/validation";
import {
  ActivateWorkspaceRequestSchema,
  CreateWorkspaceRequestSchema,
  IdSchema,
  OnboardingRegionRequestSchema,
  OrganizationNameSuggestionSchema,
  SessionSchema,
  WorkspaceOnboardingStateSchema,
  asUserId,
  asWorkspaceId,
  type Session,
} from "@rally/contracts";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { HonoAppEnv, IdentityAuthContext } from "../env";
import { getIdentityAuth } from "../middleware/auth";
import { PlatformOnboardingService } from "../services/platform-onboarding-service";
import { suggestOrganizationName } from "../services/organization-name-suggestion";
import { requestDeferral } from '../lib/defer';
import { ApiError } from '../lib/api-error';
import { apiTelemetryEnvelope, emitAuthenticatedApiTelemetry, telemetryOperationId } from '../telemetry/api-emitter';

const invitationParam = z.object({ id: IdSchema });

export const onboardingRoutes = new Hono<HonoAppEnv>();

export function deferOnboardingOutcome(
  c: Context<HonoAppEnv>,
  auth: IdentityAuthContext,
  session: Session | null,
  name: 'workspace_create_completed' | 'workspace_activation_completed',
  selectedRegion: Region,
  operationId: string | null,
  result: 'success' | 'validation_error' | 'conflict' | 'denied' | 'unavailable' | 'failed',
): void {
  if (!operationId) return;
  const workspaceIdentity = name === 'workspace_activation_completed' ? session?.workspace ?? null : null;
  const event = apiTelemetryEnvelope(
    c.env,
    name,
    { selectedRegion, result },
    operationId,
    workspaceIdentity ? 'workspace-user' : 'platform-user',
    selectedRegion,
    operationId,
  );
  const outcomeAuth: IdentityAuthContext = workspaceIdentity && session
    ? {
        sessionId: auth.sessionId,
        userId: asUserId(session.user.id),
        workspaceId: asWorkspaceId(workspaceIdentity.id),
        region: selectedRegion,
        role: workspaceIdentity.role,
      }
    : auth;
  const work = selectedRegion !== c.env.AVALON_REGION
    ? regionalBindings(c.env, selectedRegion).telemetry?.acceptApiOutcome({
      event,
      route: selectedRegion,
      subjectUserId: session?.user.id ?? auth.userId,
      workspaceId: workspaceIdentity?.id ?? null,
    }) ?? Promise.reject(new Error('telemetry_region_unavailable'))
    : emitAuthenticatedApiTelemetry(c.env, outcomeAuth, event);
  requestDeferral(c)(Promise.resolve(work).catch(() => undefined));
}

export function onboardingFailureResult(
  error: unknown,
): 'validation_error' | 'conflict' | 'denied' | 'unavailable' | 'failed' {
  if (!(error instanceof ApiError)) return 'failed';
  if ([400, 413, 422, 426, 429].includes(error.status)) return 'validation_error';
  if (error.status === 409) return 'conflict';
  if ([401, 403, 404].includes(error.status)) return 'denied';
  if ([502, 503].includes(error.status)) return 'unavailable';
  return 'failed';
}

onboardingRoutes.get("/", async (c) =>
  c.json(WorkspaceOnboardingStateSchema.parse(
    await new PlatformOnboardingService(c.env, getIdentityAuth(c))
      .state({ guests: clientOpensGuestWorkspaces((name) => c.req.header(name)) }))),
);

// Read from the homepage of the person's email domain. The create screen does
// not wait for it: it fills the name only if the person has not typed one.
onboardingRoutes.get("/organization-suggestion", async (c) => {
  const user = await c.env.DB.prepare("SELECT email FROM users WHERE id = ?")
    .bind(getIdentityAuth(c).userId).first<{ email: string }>();
  return c.json(OrganizationNameSuggestionSchema.parse({
    name: user ? await suggestOrganizationName(user.email) : null,
  }));
});

onboardingRoutes.post("/workspace", zValidator("json", CreateWorkspaceRequestSchema), async (c) => {
  const body = c.req.valid("json");
  const auth = getIdentityAuth(c);
  const operationId = telemetryOperationId(readRallyHeader((name) => c.req.header(name), RALLY_HEADERS.OPERATION_ID));
  observeSignupProgress(c.env, auth.userId, 'signup_organization_requested', 'new_organization', requestSignupPlatform(c));
  try {
    const session = SessionSchema.parse(await new PlatformOnboardingService(c.env, auth)
      .createWorkspace(body.name, body.region, c.req.raw.cf, operationId ?? undefined));
    observeSignupProgress(c.env, auth.userId, 'signup_organization_ready', 'new_organization', requestSignupPlatform(c));
    deferOnboardingOutcome(c, auth, session, 'workspace_create_completed', body.region, operationId, 'success');
    return c.json(SessionSchema.parse(session), 201);
  } catch (error) {
    deferOnboardingOutcome(
      c, auth, null, 'workspace_create_completed', body.region, operationId, onboardingFailureResult(error),
    );
    throw error;
  }
});

onboardingRoutes.post(
  "/workspace/activate",
  zValidator("json", ActivateWorkspaceRequestSchema),
  async (c) => {
    const body = c.req.valid("json");
    const auth = getIdentityAuth(c);
    const operationId = telemetryOperationId(readRallyHeader((name) => c.req.header(name), RALLY_HEADERS.OPERATION_ID));
    observeSignupProgress(c.env, auth.userId, 'signup_organization_requested', 'existing_organization', requestSignupPlatform(c));
    try {
      const session = SessionSchema.parse(await new PlatformOnboardingService(c.env, auth)
        .activate(body.region, body.workspaceId, { guests: clientOpensGuestWorkspaces((name) => c.req.header(name)) }));
      observeSignupProgress(c.env, auth.userId, 'signup_organization_ready', 'existing_organization', requestSignupPlatform(c));
      deferOnboardingOutcome(c, auth, session, 'workspace_activation_completed', body.region, operationId, 'success');
      return c.json(SessionSchema.parse(session));
    } catch (error) {
      deferOnboardingOutcome(
        c, auth, null, 'workspace_activation_completed', body.region, operationId, onboardingFailureResult(error),
      );
      throw error;
    }
  },
);

onboardingRoutes.post(
  "/invitations/:id/accept",
  zValidator("param", invitationParam),
  zValidator("json", OnboardingRegionRequestSchema),
  async (c) => {
    const auth = getIdentityAuth(c);
    const region = c.req.valid("json").region;
    const operationId = telemetryOperationId(readRallyHeader((name) => c.req.header(name), RALLY_HEADERS.OPERATION_ID));
    observeSignupProgress(c.env, auth.userId, 'signup_organization_requested', 'existing_organization', requestSignupPlatform(c));
    try {
      const session = SessionSchema.parse(await new PlatformOnboardingService(c.env, auth)
        .acceptInvitation(c.req.valid("param").id, region, operationId ?? undefined));
      observeSignupProgress(c.env, auth.userId, 'signup_organization_ready', 'existing_organization', requestSignupPlatform(c));
      deferOnboardingOutcome(c, auth, session, 'workspace_activation_completed', region, operationId, 'success');
      return c.json(SessionSchema.parse(session));
    } catch (error) {
      deferOnboardingOutcome(
        c, auth, null, 'workspace_activation_completed', region, operationId, onboardingFailureResult(error),
      );
      throw error;
    }
  },
);

onboardingRoutes.post(
  "/invitations/:id/decline",
  zValidator("param", invitationParam),
  zValidator("json", OnboardingRegionRequestSchema),
  async (c) => {
    await new PlatformOnboardingService(c.env, getIdentityAuth(c))
      .declineInvitation(c.req.valid("param").id, c.req.valid("json").region);
    return c.body(null, 204);
  },
);


onboardingRoutes.get('/account', async (c) =>
  c.json(AccountOnboardingSchema.parse(await new AccountOnboardingService(c.env, getIdentityAuth(c)).get())));
onboardingRoutes.patch('/account', zValidator('json', UpdateAccountOnboardingSchema), async (c) => {
  const auth = getIdentityAuth(c);
  const observedAt = new Date().toISOString();
  const result = await new AccountOnboardingService(c.env, auth).update(c.req.valid('json'), () =>
    observeSignupProgress(c.env, auth.userId, 'signup_onboarding_completed', undefined, requestSignupPlatform(c), observedAt));
  // Notify Global members independently: an unavailable regional discovery must not
  // suppress realtime delivery for an already-committed Global profile.
  requestDeferral(c)((async () => {
    const memberships = await c.env.DB.prepare(
      "SELECT m.workspace_id FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? AND m.status = 'active' AND w.region = 'global' AND w.abandoned_at IS NULL",
    ).bind(auth.userId).all<{ workspace_id: string }>();
    await Promise.all(memberships.results.map((workspace) =>
      publishWorkspaceSync(c.env, workspace.workspace_id, ['workspace_profile', 'member_directory'])));
  })());
  // Discovery projects the narrow identity preferences into regional and publishes
  // that region's member invalidations after its projection commits.
  requestDeferral(c)(new PlatformOnboardingService(c.env, auth).state());
  return c.json(AccountOnboardingSchema.parse(result));
});
