import type { AutomationDeliveryTargetType, Connection, ConnectorUserDelivery } from "@avalon/contracts";

import type { Env } from "../env";
import { connectorRegistryForEnv } from "../lib/connector-registry";

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

export type UserDeliveryByConnectionId = Map<string, Connection["userDelivery"]>;

/** The delivery surface a connector declares, or null when it declares none. */
export function declaredUserDeliveryTargetType(
  env: Env,
  connectorType: string,
): AutomationDeliveryTargetType | null {
  return declaredUserDelivery(env, connectorType)?.targetType ?? null;
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
  const declared = connections.flatMap((connection) => {
    if (connection.status !== "healthy") return [];
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
