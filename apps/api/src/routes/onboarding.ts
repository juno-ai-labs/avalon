import { RALLY_HEADERS, readRallyHeader } from "@rally/contracts/http-headers";
import { zValidator } from "../middleware/validation";
import {
  ActivateWorkspaceRequestSchema,
  CreateWorkspaceRequestSchema,
  IdSchema,
  OnboardingRegionRequestSchema,
  SessionSchema,
  WorkspaceOnboardingStateSchema,
  asUserId,
  asWorkspaceId,
  type Session,
} from "@rally/contracts";
import { Hono, type Context } from "hono";
import { z } from "zod/v3";
import type { HonoAppEnv, IdentityAuthContext } from "../env";
import { getIdentityAuth } from "../middleware/auth";
import { PlatformOnboardingService } from "../services/platform-onboarding-service";
import { requestDeferral } from '../lib/defer';
import { ApiError } from '../lib/api-error';
import { apiTelemetryEnvelope, emitAuthenticatedApiTelemetry, telemetryOperationId } from '../telemetry/api-emitter';

const invitationParam = z.object({ id: IdSchema });

export const onboardingRoutes = new Hono<HonoAppEnv>();

function deferOnboardingOutcome(
  c: Context<HonoAppEnv>,
  auth: IdentityAuthContext,
  session: Session | null,
  name: 'workspace_create_completed' | 'workspace_activation_completed',
  selectedRegion: 'global' | 'eu',
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
  const work = selectedRegion === 'eu'
    ? c.env.EU_TELEMETRY_BRIDGE?.acceptApiOutcome({
      event,
      route: 'eu',
      subjectUserId: session?.user.id ?? auth.userId,
      workspaceId: workspaceIdentity?.id ?? null,
    }) ?? Promise.reject(new Error('telemetry_eu_bridge_unavailable'))
    : emitAuthenticatedApiTelemetry(c.env, outcomeAuth, event);
  requestDeferral(c)(Promise.resolve(work).catch(() => undefined));
}

function onboardingFailureResult(
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
    await new PlatformOnboardingService(c.env, getIdentityAuth(c)).state())),
);

onboardingRoutes.post("/workspace", zValidator("json", CreateWorkspaceRequestSchema), async (c) => {
  const body = c.req.valid("json");
  const auth = getIdentityAuth(c);
  const operationId = telemetryOperationId(readRallyHeader((name) => c.req.header(name), RALLY_HEADERS.OPERATION_ID));
  try {
    const session = SessionSchema.parse(await new PlatformOnboardingService(c.env, auth)
      .createWorkspace(body.name, body.region, c.req.raw.cf, operationId ?? undefined));
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
    try {
      const session = SessionSchema.parse(await new PlatformOnboardingService(c.env, auth)
        .activate(body.region, body.workspaceId));
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
    try {
      const session = SessionSchema.parse(await new PlatformOnboardingService(c.env, auth)
        .acceptInvitation(c.req.valid("param").id, region, operationId ?? undefined));
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
