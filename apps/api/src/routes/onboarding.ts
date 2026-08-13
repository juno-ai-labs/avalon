import { zValidator } from "../middleware/validation";
import {
  ActivateWorkspaceRequestSchema,
  CreateWorkspaceRequestSchema,
  IdSchema,
  OnboardingRegionRequestSchema,
  SessionSchema,
  WorkspaceOnboardingStateSchema,
  type Session,
} from "@avalon/contracts";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { HonoAppEnv, IdentityAuthContext } from "../env";
import { getIdentityAuth } from "../middleware/auth";
import { PlatformOnboardingService } from "../services/platform-onboarding-service";
import { requestDeferral } from '../lib/defer';
import { apiTelemetryEnvelope, emitAuthenticatedApiTelemetry, telemetryOperationId } from '../telemetry/api-emitter';

const invitationParam = z.object({ id: IdSchema });

export const onboardingRoutes = new Hono<HonoAppEnv>();

function deferOnboardingOutcome(
  c: Context<HonoAppEnv>,
  auth: IdentityAuthContext,
  session: Session,
  name: 'workspace_create_completed' | 'workspace_activation_completed',
  selectedRegion: 'global' | 'eu',
  operationId: string | null,
): void {
  if (!operationId || !session.workspace) return;
  const event = apiTelemetryEnvelope(
    c.env,
    name,
    { selectedRegion, result: 'success' },
    operationId,
    name === 'workspace_create_completed' ? 'platform-user' : 'workspace-user',
    selectedRegion,
    operationId,
  );
  const outcomeAuth: IdentityAuthContext = name === 'workspace_activation_completed'
    ? {
        sessionId: auth.sessionId,
        userId: session.user.id,
        workspaceId: session.workspace.id,
        region: selectedRegion,
        role: session.workspace.role,
      }
    : auth;
  const work = selectedRegion === 'eu'
    ? c.env.EU_TELEMETRY_BRIDGE?.acceptApiOutcome({
      event,
      route: 'eu',
      subjectUserId: session.user.id,
      workspaceId: name === 'workspace_activation_completed' ? session.workspace.id : null,
    }) ?? Promise.reject(new Error('telemetry_eu_bridge_unavailable'))
    : emitAuthenticatedApiTelemetry(c.env, outcomeAuth, event);
  requestDeferral(c)(Promise.resolve(work).catch(() => undefined));
}

onboardingRoutes.get("/", async (c) =>
  c.json(WorkspaceOnboardingStateSchema.parse(
    await new PlatformOnboardingService(c.env, getIdentityAuth(c)).state())),
);

onboardingRoutes.post("/workspace", zValidator("json", CreateWorkspaceRequestSchema), async (c) => {
  const body = c.req.valid("json");
  const auth = getIdentityAuth(c);
  const session = SessionSchema.parse(await new PlatformOnboardingService(c.env, auth)
    .createWorkspace(body.name, body.region));
  deferOnboardingOutcome(c, auth, session, 'workspace_create_completed', body.region,
    telemetryOperationId(c.req.header('x-avalon-operation-id')));
  return c.json(SessionSchema.parse(session), 201);
});

onboardingRoutes.post(
  "/workspace/activate",
  zValidator("json", ActivateWorkspaceRequestSchema),
  async (c) => {
    const body = c.req.valid("json");
    const auth = getIdentityAuth(c);
    const session = SessionSchema.parse(await new PlatformOnboardingService(c.env, auth)
      .activate(body.region, body.workspaceId));
    deferOnboardingOutcome(c, auth, session, 'workspace_activation_completed', body.region,
      telemetryOperationId(c.req.header('x-avalon-operation-id')));
    return c.json(SessionSchema.parse(session));
  },
);

onboardingRoutes.post(
  "/invitations/:id/accept",
  zValidator("param", invitationParam),
  zValidator("json", OnboardingRegionRequestSchema),
  async (c) => {
    const auth = getIdentityAuth(c);
    const region = c.req.valid("json").region;
    const session = SessionSchema.parse(await new PlatformOnboardingService(c.env, auth)
      .acceptInvitation(c.req.valid("param").id, region));
    deferOnboardingOutcome(c, auth, session, 'workspace_activation_completed', region,
      telemetryOperationId(c.req.header('x-avalon-operation-id')));
    return c.json(SessionSchema.parse(session));
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
