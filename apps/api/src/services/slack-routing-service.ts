import type { Region } from "@rally/contracts";
import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { SlackAgentService } from "./slack-agent-service";

export const DEFAULT_SLACK_INGRESS_BASE_URL = "https://slack.rallywith.ai";

export interface SlackRouteInput {
  teamId: string;
  region: Region;
  workspaceId: string;
  connectionId: string;
}

export interface SlackRouteStatusInput extends SlackRouteInput {
  status: "active" | "disabled";
}

export type SlackRpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { status: ApiError["status"]; code: string; message: string } };

export interface SlackRegionalBridgeRpcBinding {
  processSlackEvent(input: { payload: unknown; bodyHash: string }): Promise<SlackRpcResult<{ ok: true; duplicate?: boolean }>>;
  processSlackInteraction(input: { payload: Record<string, unknown>; bodyHash: string }): Promise<SlackRpcResult<Record<string, unknown>>>;
  processSlackCommand(input: { form: Record<string, string>; bodyHash: string }): Promise<SlackRpcResult<Record<string, unknown>>>;
}

export interface GlobalSlackRouterRpcBinding {
  registerSlackRoute(input: SlackRouteInput): Promise<SlackRpcResult<{ registered: true }>>;
  setSlackRouteStatus(input: SlackRouteStatusInput): Promise<SlackRpcResult<{ updated: true }>>;
}

export async function serializeSlackRpcResult<T>(operation: () => Promise<T>): Promise<SlackRpcResult<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    if (error instanceof ApiError) return { ok: false, error: { status: error.status, code: error.code, message: error.message } };
    throw error;
  }
}

export class SlackRoutingService {
  constructor(private readonly env: Env) {}

  async registerConnection(input: SlackRouteInput): Promise<void> {
    validate(input);
    if (this.env.AVALON_REGION === "global") {
      await this.registerInGlobal(input);
      return;
    }
    if (!this.env.GLOBAL_SLACK_ROUTER) throw new ApiError(503, "slack_router_unavailable", "The shared Slack router is unavailable");
    unwrap(await this.env.GLOBAL_SLACK_ROUTER.registerSlackRoute(input));
  }

  async setConnectionStatus(input: SlackRouteStatusInput): Promise<void> {
    validate(input);
    if (this.env.AVALON_REGION === "global") {
      await this.setStatusInGlobal(input);
      return;
    }
    if (!this.env.GLOBAL_SLACK_ROUTER) throw new ApiError(503, "slack_router_unavailable", "The shared Slack router is unavailable");
    unwrap(await this.env.GLOBAL_SLACK_ROUTER.setSlackRouteStatus(input));
  }

  async registerInGlobal(input: SlackRouteInput): Promise<{ registered: true }> {
    this.assertGlobal();
    validate(input);
    const at = new Date().toISOString();
    const registered = await this.env.DB.prepare(
      `INSERT INTO slack_installation_routes
       (team_id, region, workspace_id, connection_id, status, created_at, updated_at, disabled_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, NULL)
       ON CONFLICT(team_id) DO UPDATE SET region = excluded.region,
         workspace_id = excluded.workspace_id, connection_id = excluded.connection_id,
         status = 'active', updated_at = excluded.updated_at, disabled_at = NULL
       WHERE slack_installation_routes.status = 'disabled'
          OR slack_installation_routes.workspace_id = excluded.workspace_id
       RETURNING team_id`,
    ).bind(input.teamId, input.region, input.workspaceId, input.connectionId, at, at).first<{ team_id: string }>();
    if (!registered) throw new ApiError(409, "slack_workspace_already_connected", "This Slack workspace is already connected to another Rally workspace");
    return { registered: true };
  }

  async setStatusInGlobal(input: SlackRouteStatusInput): Promise<{ updated: true }> {
    this.assertGlobal();
    validate(input);
    const at = new Date().toISOString();
    const result = await this.env.DB.prepare(
      `UPDATE slack_installation_routes SET status = ?, updated_at = ?, disabled_at = ?
       WHERE team_id = ? AND region = ? AND workspace_id = ? AND connection_id = ?`,
    ).bind(input.status, at, input.status === "disabled" ? at : null, input.teamId, input.region, input.workspaceId, input.connectionId).run();
    if (Number(result.meta.changes ?? 0) !== 1) throw new ApiError(409, "slack_route_not_found", "The Slack installation route could not be updated");
    return { updated: true };
  }

  async processEvent(payload: unknown, bodyHash: string) {
    const teamId = teamFromEvent(payload);
    return this.dispatch(teamId, (service) => service.processEvent(payload, bodyHash), (bridge) => bridge.processSlackEvent({ payload, bodyHash }));
  }

  async processInteraction(payload: Record<string, unknown>, bodyHash: string) {
    const teamId = nestedTeam(payload);
    return this.dispatch(teamId, (service) => service.processInteraction(payload, bodyHash), (bridge) => bridge.processSlackInteraction({ payload, bodyHash }));
  }

  async processCommand(form: Record<string, string>, bodyHash: string) {
    if (!form.team_id) throw new ApiError(422, "slack_command_invalid", "Slack command team identity is missing");
    return this.dispatch(form.team_id, (service) => service.processCommand(form, bodyHash), (bridge) => bridge.processSlackCommand({ form, bodyHash }));
  }

  private async dispatch<T>(
    teamId: string,
    local: (service: SlackAgentService) => Promise<T>,
    remote: (bridge: SlackRegionalBridgeRpcBinding) => Promise<SlackRpcResult<T>>,
  ): Promise<T> {
    this.assertGlobal();
    const route = await this.env.DB.prepare(
      `SELECT region FROM slack_installation_routes WHERE team_id = ? AND status = 'active'`,
    ).bind(teamId).first<{ region: Region }>();
    if (!route) throw new ApiError(404, "slack_installation_not_found", "Slack workspace is not connected to Rally");
    if (route.region === "global") return local(new SlackAgentService(this.env));
    if (route.region === "eu" && this.env.EU_SLACK_BRIDGE) return unwrap(await remote(this.env.EU_SLACK_BRIDGE));
    throw new ApiError(503, "slack_region_unavailable", `The ${route.region} Slack connector service is unavailable`);
  }

  private assertGlobal(): void {
    if (this.env.AVALON_REGION !== "global") throw new ApiError(503, "slack_ingress_misconfigured", "The shared Slack ingress must run in the Global control plane");
  }
}

export function isSharedSlackIngress(env: Env, requestUrl: string | URL): boolean {
  return new URL(requestUrl).hostname.toLowerCase() === new URL(env.SLACK_INGRESS_BASE_URL || DEFAULT_SLACK_INGRESS_BASE_URL).hostname.toLowerCase();
}

export function isAllowedSlackIngressRoute(method: string, pathname: string): boolean {
  return (method === "GET" && (pathname === "/health" || pathname === "/health/"))
    || (method === "POST" && ["/slack/events", "/slack/interactivity", "/slack/commands"].includes(pathname));
}

function validate(input: SlackRouteInput): void {
  if (!input.teamId || input.teamId.length > 100 || !input.workspaceId || !input.connectionId || !["global", "eu"].includes(input.region)) {
    throw new ApiError(422, "invalid_slack_route", "The Slack installation route is invalid");
  }
}

function teamFromEvent(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || typeof (payload as Record<string, unknown>).team_id !== "string") {
    throw new ApiError(422, "slack_event_invalid", "Slack event team identity is missing");
  }
  return String((payload as Record<string, unknown>).team_id);
}

function nestedTeam(payload: Record<string, unknown>): string {
  const team = payload.team;
  if (!team || typeof team !== "object" || Array.isArray(team) || typeof (team as Record<string, unknown>).id !== "string") {
    throw new ApiError(422, "slack_interaction_invalid", "Slack interaction team identity is missing");
  }
  return String((team as Record<string, unknown>).id);
}

function unwrap<T>(result: SlackRpcResult<T>): T {
  if (result.ok) return result.value;
  throw new ApiError(result.error.status, result.error.code, result.error.message);
}
