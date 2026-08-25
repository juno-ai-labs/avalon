import type { AutomationDeliveryTargetType, Connection, ConnectorUserDelivery } from "@rally/contracts";

import type { Env } from "../env";
import { connectorRegistryForEnv } from "../lib/connector-registry";
import { withWorkspaceRuntimeDatabase } from "./workspace-runtime-database";

/**
 * Where a connector's `requiresPersonalIdentityLink` declaration is actually
 * answered. A workspace-wide installation addresses nobody on its own, so each
 * delivery target type names the table that records "this Avalon user is this
 * provider user, on this connection". A target type absent from this map needs
 * no link — its connection is already owned by one person.
 */
const PERSONAL_IDENTITY_LINKS: Partial<Record<AutomationDeliveryTargetType, string>> = {
  slack_agent_dm: `SELECT connection_id FROM slack_user_links
     WHERE workspace_id = ? AND user_id = ? AND status = 'active'`,
};

/**
 * The provider identity a saved connector target is frozen against. The columns
 * behind these are still named `slack_team_id` and `slack_user_id`; they hold
 * the provider's tenant and user for whichever connector the target belongs to.
 */
export interface FrozenDeliveryIdentity {
  connectionId: string;
  providerTenantId: string;
  providerUserId: string;
}

/**
 * Per target type: turn an offered connection into the identity to freeze. A
 * target type is saveable only if it appears here, so a connector that declares
 * a surface Avalon cannot yet address is rejected rather than half-stored.
 */
const FROZEN_IDENTITY_RESOLVERS: Partial<Record<
  AutomationDeliveryTargetType,
  (env: Env, input: DeliveryIdentityInput) => Promise<FrozenDeliveryIdentity | null>
>> = {
  slack_agent_dm: async (env, input) => {
    const row = await env.DB.prepare(
      `SELECT cc.id, cc.provider_account_id, l.slack_user_id
       FROM connector_connections cc
       JOIN slack_user_links l ON l.connection_id = cc.id
         AND l.workspace_id = cc.workspace_id AND l.user_id = ? AND l.status = 'active'
       WHERE cc.id = ? AND cc.workspace_id = ?`,
    ).bind(input.userId, input.connectionId, input.workspaceId).first<{
      id: string;
      provider_account_id: string;
      slack_user_id: string;
    }>();
    return row
      ? { connectionId: row.id, providerTenantId: row.provider_account_id, providerUserId: row.slack_user_id }
      : null;
  },
};

interface DeliveryIdentityInput {
  workspaceId: string;
  userId: string;
  connectionId: string;
}

export type UserDeliveryByConnectionId = Map<string, Connection["userDelivery"]>;

/** The delivery surface a connector declares, or null when it declares none. */
export function declaredUserDeliveryTargetType(
  env: Env,
  connectorType: string,
): AutomationDeliveryTargetType | null {
  return declaredUserDelivery(env, connectorType)?.targetType ?? null;
}

/**
 * Resolves a destination the creator chose into the identity to store, using
 * exactly the eligibility the create screen was offered — same declaration,
 * same health, same identity link. Read and write cannot disagree about which
 * connections are personal destinations, because they answer it here together.
 */
export async function resolveFrozenDeliveryIdentity(
  env: Env,
  input: DeliveryIdentityInput & { targetType: AutomationDeliveryTargetType },
): Promise<FrozenDeliveryIdentity | null> {
  env = withWorkspaceRuntimeDatabase(env, input.workspaceId);
  const connection = await env.DB.prepare(
    "SELECT id, connector_type, status FROM connector_connections WHERE id = ? AND workspace_id = ?",
  ).bind(input.connectionId, input.workspaceId).first<{
    id: string;
    connector_type: string;
    status: string;
  }>();
  if (!connection) return null;
  const offered = await resolveUserDelivery(env, input, [connection]);
  if (offered.get(connection.id)?.targetType !== input.targetType) return null;
  return await FROZEN_IDENTITY_RESOLVERS[input.targetType]?.(env, input) ?? null;
}

function declaredUserDelivery(env: Env, connectorType: string): ConnectorUserDelivery | null {
  try {
    return connectorRegistryForEnv(env).get(connectorType).manifest.userDelivery ?? null;
  } catch {
    // A connection whose connector is not registered in this region simply has
    // no declared delivery surface.
    return null;
  }
}

/**
 * Resolves, for one user, which of the given connections can hand them an
 * automation result right now. Connections that are unhealthy, whose connector
 * declares no delivery surface, or whose required identity link is missing are
 * left out of the returned map.
 */
export async function resolveUserDelivery(
  env: Env,
  input: { workspaceId: string; userId: string },
  connections: Array<{ id: string; connector_type: unknown; status: unknown }>,
): Promise<UserDeliveryByConnectionId> {
  env = withWorkspaceRuntimeDatabase(env, input.workspaceId);
  const declared = connections.flatMap((connection) => {
    // Only a person's decision removes a surface. A `needs_reconnect` belief
    // used to silently drop the destination, so an automation delivered
    // nowhere and said nothing about it; the send itself is what discovers
    // whether the credential still works.
    if (connection.status === "disabled") return [];
    const delivery = declaredUserDelivery(env, String(connection.connector_type));
    return delivery ? [{ connectionId: connection.id, delivery }] : [];
  });
  if (declared.length === 0) return new Map();

  const linkedByTargetType = new Map<AutomationDeliveryTargetType, Set<string>>();
  const linkedTargetTypes = [...new Set(declared
    .filter((candidate) => candidate.delivery.requiresPersonalIdentityLink)
    .map((candidate) => candidate.delivery.targetType))];
  await Promise.all(linkedTargetTypes.map(async (targetType) => {
    const statement = PERSONAL_IDENTITY_LINKS[targetType];
    // A connector that requires a link Avalon has no registry for can never be
    // resolved to a person, so it is not offered as a destination.
    if (!statement) return linkedByTargetType.set(targetType, new Set());
    const rows = await env.DB.prepare(statement)
      .bind(input.workspaceId, input.userId)
      .all<{ connection_id: string }>();
    linkedByTargetType.set(targetType, new Set((rows.results ?? []).map((row) => row.connection_id)));
  }));

  const resolved: UserDeliveryByConnectionId = new Map();
  for (const { connectionId, delivery } of declared) {
    if (delivery.requiresPersonalIdentityLink
      && !linkedByTargetType.get(delivery.targetType)?.has(connectionId)) continue;
    resolved.set(connectionId, {
      targetType: delivery.targetType,
      label: delivery.label,
      description: delivery.description,
    });
  }
  return resolved;
}
