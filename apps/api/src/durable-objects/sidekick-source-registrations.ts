import { ExternalEventEvaluatorV1Schema, type ExternalEventEvaluatorV1 } from "@rally/contracts";
import type { ConnectorRegistry } from "@rally/connectors";
import { connectorActivityTriggerDescriptors, storedConnectionScope } from "../lib/connector-activity-triggers";
import { uuidV7 } from "../lib/uuid-v7";
import { resolveWorkspaceConnectorResource } from "./workspace-resources-storage";

function sourceWake(predicate = ""): string {
  return `INSERT INTO _internal_durable_alarms(kind,alarm_key,due_at,created_at,updated_at)
  SELECT 'sidekick_delegation_sources',automation_id || ':sources',
    unixepoch()*1000,unixepoch()*1000,unixepoch()*1000 FROM automation_directory
    WHERE lifecycle='active' AND region IS NOT NULL AND evaluator_projection_json<>'[]' ${predicate}
  ON CONFLICT(kind,alarm_key) DO UPDATE SET
    due_at=MAX(excluded.due_at,_internal_durable_alarms.due_at+1),
    retry_at=0,attempt=0,updated_at=excluded.updated_at`;
}

/** One pending refresh per Sidekick. Moving the instant fences an older handler's settlement. */
export function queueSidekickSourceReconciliation(storage: DurableObjectStorage, sidekickId: string): void {
  storage.sql.exec(sourceWake("AND automation_id=?"), sidekickId);
}

/** Connection authority changes wake configured sources; cursor/token renewal does not. */
export const SIDEKICK_SOURCE_CONNECTION_SCHEMA_STATEMENTS = [
  `CREATE TRIGGER sidekick_sources_connection_insert AFTER INSERT ON connector_connections BEGIN ${sourceWake()}; END`,
  `CREATE TRIGGER sidekick_sources_connection_delete AFTER DELETE ON connector_connections BEGIN ${sourceWake()}; END`,
  `CREATE TRIGGER sidekick_sources_connection_update
    AFTER UPDATE OF connector_type,scope,owner_user_id,model_plugin_id,granted_scopes_json,status,config_json ON connector_connections
    WHEN NEW.connector_type IS NOT OLD.connector_type OR NEW.scope IS NOT OLD.scope
      OR NEW.owner_user_id IS NOT OLD.owner_user_id OR NEW.model_plugin_id IS NOT OLD.model_plugin_id
      OR NEW.granted_scopes_json IS NOT OLD.granted_scopes_json OR NEW.status IS NOT OLD.status OR NEW.config_json IS NOT OLD.config_json
    BEGIN ${sourceWake()}; END`,
  sourceWake(),
] as const;

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** What a person lets in from one connection, already checked as still theirs to give. */
export interface EligibleSidekickSource {
  userId: string;
  connectionId: string;
  eventType: string;
  /**
   * The request the person approved for this event type, if they did. Only
   * that is an answer to "may events from your account start this Sidekick":
   * a source a saved rule or the migration made stands for the rule it came
   * from and no other.
   */
  requestId: string | null;
}

/**
 * The connections each configured rule is registered on.
 *
 * An Organization connection needs nobody: the Sidekick watches it as itself.
 * A person's connection needs that person's source for the event type, and a
 * source is what extends a rule beyond the connection it was configured on: a
 * rule about a whole account reaches every person's connection of that
 * connector whose owner approved a request for the event, and a rule about
 * one globally addressed resource (a Google file) reaches every connection
 * that can open it. A rule about an account-relative resource (a mail thread)
 * stays on its own connection.
 *
 * Only a requested source carries a whole-account rule to another account. A
 * source a person's own saved rule made, or the migration made from one,
 * records that rule's event type and not its scope: read as account-wide it
 * would turn somebody's rule about one thread into all of their mail. Each
 * event type is its own source, so a request approved for one never lends
 * that standing to another.
 *
 * Delegation is not consulted: who a run may act as says nothing about whose
 * events may start it.
 *
 * Runs inside the owning WorkspaceDO's registration transaction; no provider I/O.
 */
export function sidekickSourceRegistrations(input: {
  storage: DurableObjectStorage; workspaceId: string; sidekickId: string;
  evaluators: readonly ExternalEventEvaluatorV1[]; sources: readonly EligibleSidekickSource[];
  registry: ConnectorRegistry;
}): ExternalEventEvaluatorV1[] {
  const { storage, workspaceId, sidekickId, registry } = input;
  const connections = storage.sql.exec<{
    id: string; connector_type: string; scope: string; owner_user_id: string | null;
    model_plugin_id: string | null; granted_scopes_json: string; config_json: string | null;
  }>(`SELECT id,connector_type,scope,owner_user_id,model_plugin_id,granted_scopes_json,config_json
        FROM connector_connections WHERE workspace_id=? AND status<>'disabled' ORDER BY id`, workspaceId).toArray();
  // Aliases are reused only on a live connection, so only those rows are read,
  // and a row whose stored evaluator no longer parses is passed over rather
  // than refusing every reconciliation of that Sidekick: a retired
  // connector's rows (Canva, the generic webhook) name a `connectorType` the
  // evaluator schema no longer admits, and the next retirement's will too.
  // Passing one over only means its id is not reused.
  const existing = storage.sql.exec<{ registration_id: string; evaluator_json: string }>(
    `SELECT registration_id,evaluator_json FROM workspace_external_event_registrations
      WHERE automation_id=? AND connection_id IN (SELECT id FROM connector_connections WHERE status<>'disabled')
      ORDER BY state='active' DESC,updated_at DESC,registration_id`, sidekickId,
  ).toArray().flatMap((row) => {
    const evaluator = ExternalEventEvaluatorV1Schema.safeParse(parsedJson(row.evaluator_json));
    return evaluator.success ? [{ id: row.registration_id, evaluator: evaluator.data }] : [];
  });
  const registeredTypes = new Set(registry.list().map((manifest) => manifest.type));
  const letsIn = (connection: { id: string; owner_user_id: string | null }, eventType: string, requested = false) =>
    connection.owner_user_id !== null
    && input.sources.some((source) => source.userId === connection.owner_user_id && source.connectionId === connection.id
      && source.eventType === eventType && (!requested || source.requestId !== null));
  const expanded: ExternalEventEvaluatorV1[] = [];
  for (const evaluator of input.evaluators) {
    if (!registeredTypes.has(evaluator.source.connectorType)) continue;
    const adapter = registry.get(evaluator.source.connectorType);
    const resource = evaluator.source.resourceId ? storage.sql.exec<{
      id: string; connection_id: string | null; provider: string; provider_resource_id: string | null;
      resource_type: string; title: string; canonical_url: string | null;
    }>(`SELECT id,connection_id,provider,provider_resource_id,resource_type,title,canonical_url
         FROM resources WHERE id=? AND workspace_id=?`, evaluator.source.resourceId, workspaceId).toArray()[0] : null;
    if (evaluator.source.resourceId && !resource) throw new Error("sidekick_source_resource_unavailable");
    if (resource?.connection_id && resource.connection_id !== evaluator.source.connectionId) throw new Error("sidekick_source_resource_connection_changed");
    const portable = resource && adapter.isPortableActivityResource?.({ provider: resource.provider,
      resourceType: resource.resource_type, providerResourceId: resource.provider_resource_id,
    });
    for (const connection of connections) {
      if (connection.connector_type !== evaluator.source.connectorType) continue;
      const personal = connection.scope === "personal";
      if (personal && !letsIn(connection, evaluator.source.eventType)) continue;
      const configured = connection.id === evaluator.source.connectionId;
      // Beyond its own connection a rule reaches a person's account when it is
      // about the whole account, and any connection when its resource is the
      // same thing everywhere.
      if (!configured && !portable && !(personal && !resource && letsIn(connection, evaluator.source.eventType, true))) continue;
      const capabilities = JSON.parse(connection.granted_scopes_json) as string[];
      const descriptor = connectorActivityTriggerDescriptors(adapter, connection.config_json, storedConnectionScope(connection.scope), capabilities)
        .find((candidate) => candidate.eventType === evaluator.source.eventType);
      if (!descriptor || (resource && !descriptor.resourceRelationships.some((relationship) => relationship.resourceType === resource.resource_type))) continue;
      if (configured) {
        expanded.push(evaluator);
        continue;
      }
      const alias = existing.find((entry) => entry.evaluator.sourceEvaluatorId === evaluator.evaluatorId
        && entry.evaluator.source.connectionId === connection.id);
      if (!resource) {
        expanded.push(ExternalEventEvaluatorV1Schema.parse({ ...evaluator, evaluatorId: alias?.id ?? uuidV7(),
          sourceEvaluatorId: evaluator.evaluatorId, source: { ...evaluator.source, connectionId: connection.id } }));
        continue;
      }
      if (!resource.provider_resource_id) continue;
      // This is the already configured, globally addressed provider resource.
      // Register its connection-specific Rally identity using the normal authority.
      const resolved = resolveWorkspaceConnectorResource(storage, {
        workspaceId, candidateResourceId: uuidV7(), connectionId: connection.id,
        provider: resource.provider, providerResourceId: resource.provider_resource_id,
        resourceType: resource.resource_type, title: resource.title, canonicalUrl: resource.canonical_url,
        connectionAuthority: { connectorType: connection.connector_type, scope: storedConnectionScope(connection.scope),
          ownerUserId: connection.owner_user_id, modelPluginId: connection.model_plugin_id, requiredCapabilities: capabilities },
        at: new Date().toISOString(),
      });
      if (resolved.outcome === "connection_unavailable") continue;
      const actual = storage.sql.exec<{ resource_type: string }>("SELECT resource_type FROM resources WHERE id=?", resolved.resourceId).one();
      if (actual.resource_type !== resource.resource_type) throw new Error("sidekick_source_resource_type_mismatch");
      expanded.push(ExternalEventEvaluatorV1Schema.parse({ ...evaluator, evaluatorId: alias?.id ?? uuidV7(),
        sourceEvaluatorId: evaluator.evaluatorId, source: { ...evaluator.source, connectionId: connection.id, resourceId: resolved.resourceId } }));
    }
  }
  return expanded;
}
