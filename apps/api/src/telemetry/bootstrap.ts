import { newId } from "@rally/db";
import {
  TelemetryBootstrapResponseSchema,
  TelemetryEnvelopeSchema,
  TelemetryRouteResponseSchema,
  type TelemetryBootstrapResponse,
  type TelemetryEnvelope,
  type TelemetryRouteResponse,
} from "@rally/contracts/telemetry";
import type { Env } from "../env";
import { hmacSha256, timingSafeEqualText } from "../lib/crypto";
import { TelemetryCollector, type TelemetryAcceptanceResult } from "./collector";
import type { AnonymousTelemetryProjection } from "./regional-bridge";

const EU_COUNTRIES = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR",
  "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK",
]);
const CAPABILITY_LIFETIME_MS = 60 * 60 * 1_000;
const ROUTE_DECISION_LIFETIME_MS = 5 * 60 * 1_000;
const CONTROL_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const ANONYMOUS_EVENT_NAMES = new Set([
  "screen_viewed",
  "onboarding_region_selected",
  "workspace_create_requested",
  "workspace_activation_requested",
  "site_page_viewed",
  "site_page_left",
  "site_action_selected",
  "desktop_handoff_attempted",
]);

interface CapabilityClaims {
  version: 1;
  journeyId: string;
  anonymousEpochId: string;
  route: "global" | "eu";
  routingBasis: "ip_geolocation" | "geolocation_fallback";
  expiresAt: number;
}

interface RouteDecisionClaims {
  version: 1;
  purpose: "telemetry_route";
  route: "global" | "eu";
  routingBasis: "ip_geolocation" | "geolocation_fallback";
  expiresAt: number;
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): string {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

async function signCapability(secret: string, claims: CapabilityClaims): Promise<string> {
  const payload = base64UrlEncode(JSON.stringify(claims));
  return `${payload}.${await hmacSha256(secret, payload)}`;
}

async function verifyCapability(secret: string, token: string): Promise<CapabilityClaims> {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("telemetry_capability_invalid");
  const expected = await hmacSha256(secret, parts[0]);
  if (!timingSafeEqualText(expected, parts[1])) throw new Error("telemetry_capability_invalid");
  try {
    const claims = JSON.parse(base64UrlDecode(parts[0])) as CapabilityClaims;
    if (
      claims.version !== 1
      || !claims.journeyId
      || !claims.anonymousEpochId
      || (claims.route !== "global" && claims.route !== "eu")
      || (claims.routingBasis !== "ip_geolocation" && claims.routingBasis !== "geolocation_fallback")
      || !Number.isSafeInteger(claims.expiresAt)
    ) throw new Error("invalid");
    return claims;
  } catch {
    throw new Error("telemetry_capability_invalid");
  }
}

async function signRouteDecision(secret: string, claims: RouteDecisionClaims): Promise<string> {
  const payload = base64UrlEncode(JSON.stringify(claims));
  return `${payload}.${await hmacSha256(secret, payload)}`;
}

async function verifyRouteDecision(secret: string, token: string): Promise<RouteDecisionClaims> {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("telemetry_route_decision_invalid");
  const expected = await hmacSha256(secret, parts[0]);
  if (!timingSafeEqualText(expected, parts[1])) throw new Error("telemetry_route_decision_invalid");
  let claims: RouteDecisionClaims;
  try {
    claims = JSON.parse(base64UrlDecode(parts[0])) as RouteDecisionClaims;
  } catch (error) {
    throw new Error("telemetry_route_decision_invalid", { cause: error });
  }
  if (
    claims.version !== 1
    || claims.purpose !== "telemetry_route"
    || (claims.route !== "global" && claims.route !== "eu")
    || (claims.routingBasis !== "ip_geolocation" && claims.routingBasis !== "geolocation_fallback")
    || !Number.isSafeInteger(claims.expiresAt)
  ) throw new Error("telemetry_route_decision_invalid");
  if (Date.now() > claims.expiresAt) throw new Error("telemetry_route_decision_expired");
  return claims;
}

export function coarseTelemetryRoute(country: string | undefined): {
  route: "global" | "eu";
  routingBasis: "ip_geolocation" | "geolocation_fallback";
} {
  const normalized = country?.toUpperCase();
  if (normalized && /^[A-Z]{2}$/u.test(normalized) && normalized !== "XX") {
    return {
      route: EU_COUNTRIES.has(normalized) ? "eu" : "global",
      routingBasis: "ip_geolocation",
    };
  }
  return { route: "global", routingBasis: "geolocation_fallback" };
}

function projectionFor(
  event: TelemetryEnvelope,
  claims: CapabilityClaims,
  installationId: string | undefined,
): AnonymousTelemetryProjection {
  return {
    event,
    route: claims.route,
    routingBasis: claims.routingBasis,
    analyticsSubjectId: event.identityScope === "installation"
      ? installationId!
      : claims.anonymousEpochId,
    subjectUserId: null,
    workspaceAnalyticsId: null,
  };
}

export class TelemetryBootstrapService {
  constructor(private readonly env: Env) {}

  private signingKey(): string {
    return this.env.TELEMETRY_CAPABILITY_SIGNING_KEY ?? this.env.SESSION_SIGNING_KEY;
  }

  async route(country: string | undefined): Promise<TelemetryRouteResponse> {
    if (this.env.AVALON_REGION !== "global") throw new Error("telemetry_bootstrap_global_only");
    const route = coarseTelemetryRoute(country);
    const claims: RouteDecisionClaims = {
      version: 1,
      purpose: "telemetry_route",
      ...route,
      expiresAt: Date.now() + ROUTE_DECISION_LIFETIME_MS,
    };
    return TelemetryRouteResponseSchema.parse({
      ...route,
      routeToken: await signRouteDecision(this.signingKey(), claims),
    });
  }

  async bootstrap(
    anonymousEpochId: string,
    country: string | undefined,
    routeToken?: string,
  ): Promise<TelemetryBootstrapResponse> {
    if (this.env.AVALON_REGION !== "global") throw new Error("telemetry_bootstrap_global_only");
    const now = new Date();
    const verifiedRoute = routeToken
      ? await verifyRouteDecision(this.signingKey(), routeToken)
      : coarseTelemetryRoute(country);
    const requestedRoute = {
      route: verifiedRoute.route,
      routingBasis: verifiedRoute.routingBasis,
    };
    const existing = await this.env.DB.prepare(
      `SELECT journey_id, route, routing_basis, closed_at, delete_at
       FROM telemetry_onboarding_journeys WHERE anonymous_epoch_id = ?`,
    ).bind(anonymousEpochId).first<{
      journey_id: string;
      route: 'global' | 'eu';
      routing_basis: 'ip_geolocation' | 'geolocation_fallback';
      closed_at: string | null;
      delete_at: string;
    }>();
    if (existing && Date.parse(existing.delete_at) > now.getTime()) {
      if (existing.closed_at) throw new Error('telemetry_journey_closed');
      if (routeToken && (
        existing.route !== requestedRoute.route
        || existing.routing_basis !== requestedRoute.routingBasis
      )) throw new Error("telemetry_route_decision_conflict");
      const expiresAt = new Date(Math.min(
        Date.parse(existing.delete_at),
        now.getTime() + CAPABILITY_LIFETIME_MS,
      ));
      await this.env.DB.prepare(
        'UPDATE telemetry_onboarding_journeys SET expires_at = ? WHERE journey_id = ?',
      ).bind(expiresAt.toISOString(), existing.journey_id).run();
      const claims: CapabilityClaims = {
        version: 1,
        journeyId: existing.journey_id,
        anonymousEpochId,
        route: existing.route,
        routingBasis: existing.routing_basis,
        expiresAt: expiresAt.getTime(),
      };
      return TelemetryBootstrapResponseSchema.parse({
        journeyId: existing.journey_id,
        route: existing.route,
        routingBasis: existing.routing_basis,
        capability: await signCapability(this.signingKey(), claims),
        expiresAt: expiresAt.toISOString(),
      });
    }
    if (existing) {
      await this.env.DB.prepare(
        `DELETE FROM telemetry_onboarding_journeys
         WHERE anonymous_epoch_id = ? AND delete_at <= ?`,
      ).bind(anonymousEpochId, now.toISOString()).run();
    }
    const journeyId = newId(now.getTime());
    const route = requestedRoute;
    const expiresAt = new Date(now.getTime() + CAPABILITY_LIFETIME_MS);
    const deleteAt = new Date(now.getTime() + CONTROL_RETENTION_MS);
    const inserted = await this.env.DB.prepare(
      `INSERT INTO telemetry_onboarding_journeys
        (journey_id, anonymous_epoch_id, route, routing_basis, created_at, expires_at, delete_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(anonymous_epoch_id) DO NOTHING`,
    ).bind(
      journeyId,
      anonymousEpochId,
      route.route,
      route.routingBasis,
      now.toISOString(),
      expiresAt.toISOString(),
      deleteAt.toISOString(),
    ).run();
    if (Number(inserted.meta.changes ?? 0) !== 1) {
      // A concurrent bootstrap won the anonymous-epoch uniqueness race. Reuse
      // its fixed route rather than returning a capability for an unpersisted
      // journey or replacing its coarse-location decision.
      return this.bootstrap(anonymousEpochId, country, routeToken);
    }
    const claims: CapabilityClaims = {
      version: 1,
      journeyId,
      anonymousEpochId,
      route: route.route,
      routingBasis: route.routingBasis,
      expiresAt: expiresAt.getTime(),
    };
    return TelemetryBootstrapResponseSchema.parse({
      journeyId,
      ...route,
      capability: await signCapability(this.signingKey(), claims),
      expiresAt: expiresAt.toISOString(),
    });
  }

  async accept(
    capability: string,
    candidates: TelemetryEnvelope[],
    installationId?: string,
  ): Promise<TelemetryAcceptanceResult[]> {
    if (this.env.AVALON_REGION !== "global") throw new Error("telemetry_bootstrap_global_only");
    const claims = await verifyCapability(this.signingKey(), capability);
    if (Date.now() > claims.expiresAt) throw new Error("telemetry_capability_expired");
    const journey = await this.env.DB.prepare(
      `SELECT anonymous_epoch_id, route, routing_basis, expires_at, closed_at
       FROM telemetry_onboarding_journeys WHERE journey_id = ?`,
    ).bind(claims.journeyId).first<{
      anonymous_epoch_id: string;
      route: "global" | "eu";
      routing_basis: "ip_geolocation" | "geolocation_fallback";
      expires_at: string;
      closed_at: string | null;
    }>();
    if (
      !journey
      || journey.anonymous_epoch_id !== claims.anonymousEpochId
      || journey.route !== claims.route
      || journey.routing_basis !== claims.routingBasis
      || journey.closed_at !== null
    ) throw new Error("telemetry_capability_invalid");
    if (Date.now() > Date.parse(journey.expires_at)) throw new Error("telemetry_capability_expired");

    const events = candidates.map((candidate) => {
      const anonymousProduct = candidate.identityScope === "anonymous-epoch"
        && candidate.category === "product"
        && ANONYMOUS_EVENT_NAMES.has(candidate.name)
        && candidate.context.onboardingJourneyId === claims.journeyId;
      const installationHealth = candidate.identityScope === "installation"
        && candidate.category === "essential"
        && installationId !== undefined;
      if (!anonymousProduct && !installationHealth) throw new Error("telemetry_anonymous_event_forbidden");
      return TelemetryEnvelopeSchema.parse(candidate) as TelemetryEnvelope;
    });
    if (claims.route === "eu") {
      if (!this.env.EU_TELEMETRY_BRIDGE) throw new Error("telemetry_eu_bridge_unavailable");
      return Promise.all(events.map((event) => this.env.EU_TELEMETRY_BRIDGE!.acceptAnonymous(
        projectionFor(event, claims, installationId),
      )));
    }
    const collector = new TelemetryCollector(this.env);
    return Promise.all(events.map((event) => collector.accept(
      event,
      projectionFor(event, claims, installationId),
    )));
  }

  async authorizeCrash(capability: string): Promise<{
    route: 'global';
    anonymousEpochId: string;
    journeyId: string;
  }> {
    if (this.env.AVALON_REGION !== 'global') throw new Error('telemetry_bootstrap_global_only');
    const claims = await verifyCapability(this.signingKey(), capability);
    if (Date.now() > claims.expiresAt) throw new Error('telemetry_capability_expired');
    // An affirmative EU coarse result never starts Crashpad. Refusing it here
    // is defense in depth against a modified client moving a dump to Global or
    // creating an EU onboarding dump the product promised not to save.
    if (claims.route !== 'global') throw new Error('crash_route_forbidden');
    const journey = await this.env.DB.prepare(
      `SELECT anonymous_epoch_id, route, expires_at, closed_at
       FROM telemetry_onboarding_journeys WHERE journey_id = ?`,
    ).bind(claims.journeyId).first<{
      anonymous_epoch_id: string;
      route: 'global' | 'eu';
      expires_at: string;
      closed_at: string | null;
    }>();
    if (!journey
      || journey.anonymous_epoch_id !== claims.anonymousEpochId
      || journey.route !== 'global'
      || journey.closed_at !== null
      || Date.now() > Date.parse(journey.expires_at)) throw new Error('telemetry_capability_invalid');
    return {
      route: 'global',
      anonymousEpochId: claims.anonymousEpochId,
      journeyId: claims.journeyId,
    };
  }

  async authorizeLink(
    capability: string,
    expectedRoute: 'global' | 'eu',
  ): Promise<{ route: 'global' | 'eu'; anonymousEpochId: string; closed: boolean }> {
    if (this.env.AVALON_REGION !== 'global') throw new Error('telemetry_link_global_verifier_required');
    const claims = await verifyCapability(this.signingKey(), capability);
    if (Date.now() > claims.expiresAt) throw new Error('telemetry_capability_expired');
    if (claims.route !== expectedRoute) {
      throw new Error('telemetry_link_route_mismatch');
    }
    const journey = await this.env.DB.prepare(
      `SELECT anonymous_epoch_id, route, expires_at, closed_at
       FROM telemetry_onboarding_journeys WHERE journey_id = ?`,
    ).bind(claims.journeyId).first<{
      anonymous_epoch_id: string;
      route: 'global' | 'eu';
      expires_at: string;
      closed_at: string | null;
    }>();
    if (!journey
      || journey.anonymous_epoch_id !== claims.anonymousEpochId
      || journey.route !== claims.route
      || Date.now() > Date.parse(journey.expires_at)) throw new Error('telemetry_capability_invalid');
    return {
      route: claims.route,
      anonymousEpochId: claims.anonymousEpochId,
      closed: journey.closed_at !== null,
    };
  }

  async closeJourney(capability: string, expectedRoute: 'global' | 'eu'): Promise<void> {
    const claims = await this.authorizeLink(capability, expectedRoute);
    if (claims.closed) return;
    await this.env.DB.prepare(
      `UPDATE telemetry_onboarding_journeys
       SET closed_at = COALESCE(closed_at, ?)
       WHERE anonymous_epoch_id = ? AND route = ? AND closed_at IS NULL`,
    ).bind(
      new Date().toISOString(),
      claims.anonymousEpochId,
      expectedRoute,
    ).run();
  }
}
