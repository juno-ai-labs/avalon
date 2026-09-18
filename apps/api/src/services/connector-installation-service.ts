import { diagnosticErrorCode, logWarn } from "../observability/logger";
import { RegionSchema } from "@rally/contracts/regions";
import { isRetirementRefusal } from "../durable-objects/object-retirement";
import { publishWorkspaceSync } from "./workspace-realtime-service";
import { uuidV7 } from "../lib/uuid-v7";
import { workspaceDOName } from "../durable-objects/names";
import { asWorkspaceId, ConnectorInstallationSchema, type ConnectorInstallation, type InstallationRegistration } from "@rally/contracts";
import { ConnectorError, type ConnectorConnectionContext } from "@rally/connectors";
import { z } from "zod";
import type { Env } from "../env";
import { connectorRegistryForEnv } from "../lib/connector-registry";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { encryptString } from "../lib/crypto";
import { decryptVersionedConnectorCredentials } from "./connector-credential-envelope";
import { removeAuthorizedConnectorRegistration, withAuthorizedConnection } from "./connector-connection-access";
import { withWorkspaceRuntimeDatabase } from "./workspace-runtime-database";

export const ConnectorInstallationQueueSchema = z.strictObject({ kind: z.literal("connector_installation"), workspaceId: z.string().uuid(), connectionId: z.string().uuid(), region: RegionSchema });

export async function runConnectorInstallation(env: Env, workspace: string, connectionId: string, signal: AbortSignal): Promise<ConnectorInstallation | null> {
  const workspaceId = asWorkspaceId(workspace);
  const object = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, workspaceId, workspaceDOName(env.AVALON_REGION, workspaceId));
  const localEnv = withWorkspaceRuntimeDatabase(env, workspaceId);
  let installation = await object.connectorInstallation({ workspaceId, connectionId });
  while (installation) {
    signal.throwIfAborted();
    if (installation.maintenanceCancelled) return installation;
    const registration = installation.registrations.find((item) => item.state === "pending" && item.afterRegistrationKeys.every((key) => installation!.registrations.some((dependency) => dependency.key === key && dependency.state === "current")));
    if (!registration) return installation;
    const management = connectorRegistryForEnv(env).get(installation.provider).installationManagement;
    const request = { workspaceId, connectionId, generation: installation.generation, stepId: registration.stepId };
    const claim = await object.claimConnectorInstallationStep(request);
    if (!claim.claimed) return claim.installation;
    if (!management || management.version !== installation.desiredVersion) {
      installation = await object.settleConnectorInstallationStep({ ...request, registration: {
        ...registration, state: "failed", error: "The installed Worker does not support this configuration version. Use Test after the matching version is available.",
      } });
      await publishWorkspaceSync(localEnv, workspaceId, ["connector_connections"]);
      return installation;
    }
    if (management.support[registration.action] !== "automatic") {
      installation = await object.settleConnectorInstallationStep({ ...request, registration: {
        ...registration, state: "action_required", error: management.manualInstructions,
      } });
      await publishWorkspaceSync(localEnv, workspaceId, ["connector_connections"]);
      return installation;
    }
    let result: InstallationRegistration = { ...registration };
    let writeDispatched = false;
    let replacement: { ciphertext: string; iv: string; keyVersion: number } | undefined;
    try {
      const active = await localEnv.DB.prepare("SELECT id FROM connector_connections WHERE id = ? AND workspace_id = ? AND status <> 'disabled'").bind(connectionId, workspaceId).first();
      if (registration.action === "remove" && !active) {
        await removeAuthorizedConnectorRegistration(env, request, management, signal, () => { writeDispatched = true; });
        result = { ...registration, state: "removed", enabled: false, error: null };
      } else {
        const row = await localEnv.DB.prepare("SELECT * FROM connector_connections WHERE id = ? AND workspace_id = ? AND status <> 'disabled'").bind(connectionId, workspaceId).first<{
          encrypted_credentials: string; credential_iv: string; credential_key_version: number; granted_scopes_json: string; config_json: string;
        }>();
        if (!row) throw new Error("connector_disabled");
        const credentials = z.record(z.string(), z.unknown()).parse(JSON.parse(await decryptVersionedConnectorCredentials(localEnv, { ...row, id: connectionId })));
        const context: ConnectorConnectionContext = { id: connectionId, workspaceId, scope: "workspace", ownerUserId: null,
          credentials, grantedScopes: z.array(z.string()).parse(JSON.parse(row.granted_scopes_json)),
          config: z.record(z.string(), z.unknown()).parse(JSON.parse(row.config_json)), cursor: {} };
        await withAuthorizedConnection(localEnv, { connection: context, adapter: connectorRegistryForEnv(env).get(installation.provider), signal }, async (authorized) => {
          const current = await object.connectorInstallation({ workspaceId, connectionId });
          if (current?.generation !== request.generation) throw new Error("connector_installation_superseded");
          signal.throwIfAborted();
          if (registration.action === "remove") {
            if (!registration.providerId || !registration.providerIdVerified) throw new Error("connector_cleanup_not_authorized");
            signal.throwIfAborted(); writeDispatched = true;
            await management.remove(authorized, registration.providerId, signal);
            result = { ...registration, state: "removed", enabled: false, error: null };
          } else if (registration.action === "create") {
            await management.validate(authorized, signal);
            const fence = await object.connectorInstallation({ workspaceId, connectionId });
            if (fence?.generation !== request.generation) throw new Error("connector_installation_superseded");
            const secret = registration.activeSecretRef ? credentials[registration.activeSecretRef] : null;
            signal.throwIfAborted();
            writeDispatched = true;
            const created = await management.create(authorized, registration, typeof secret === "string" ? secret : null, signal);
            if (created.signingSecret && registration.activeSecretRef) {
              // Persist through the generation-fenced settlement, never through
              // the normal credential door's mutable credentials observation.
              const nextCredentials = { ...credentials, [registration.activeSecretRef]: created.signingSecret,
                webhookEndpointId: created.providerId, webhookSigningSecret: created.signingSecret };
              replacement = { ...await encryptString(JSON.stringify(nextCredentials), env.CONNECTOR_CREDENTIALS_KEY, connectionId), keyVersion: Number(env.CONNECTOR_CREDENTIALS_KEY_VERSION || 1) };
            }
            result = { ...registration, providerId: created.providerId, state: "pending", action: "inspect", stepId: uuidV7(), error: null };
          } else if (registration.action === "rotate") {
            const rotation = management.rotation;
            const pending = registration.pendingSecretRef ? credentials[registration.pendingSecretRef] : null;
            if (management.support.rotate !== "automatic" || !rotation || typeof pending !== "string") {
              result = { ...registration, state: "action_required", error: management.manualInstructions }; return;
            }
            signal.throwIfAborted(); writeDispatched = true;
            await rotation.dispatch(authorized, registration, pending, signal);
            const verification = await rotation.verify(authorized, registration, pending, signal);
            if (!verification.verified || !verification.evidence) {
              result = { ...registration, state: "unknown", rotation: "unknown", error: "Signing-key cutover could not be verified. Active material is retained." }; return;
            }
            const nextCredentials = { ...credentials };
            if (registration.activeSecretRef) delete nextCredentials[registration.activeSecretRef];
            replacement = { ...await encryptString(JSON.stringify(nextCredentials), env.CONNECTOR_CREDENTIALS_KEY, connectionId), keyVersion: Number(env.CONNECTOR_CREDENTIALS_KEY_VERSION || 1) };
            result = { ...registration, state: "current", rotation: "verified", rotationEvidence: verification.evidence, verifiedAt: new Date().toISOString(), error: null };
          } else if (registration.action === "update") {
            if (!management.update || management.support.update !== "automatic") {
              result = { ...registration, state: "action_required", error: management.manualInstructions }; return;
            }
            signal.throwIfAborted();
            writeDispatched = true;
            await management.update(authorized, registration, signal);
            result = { ...registration, state: "pending", action: "inspect", stepId: uuidV7(), error: "enable_attempted" };
          } else {
            const observed = await management.inspect(authorized, registration, signal);
            if (registration.adoptingExistingDestination && observed && installation?.provider === "granola") {
              const destination = new URL(observed.destination);
              const expected = new URL(registration.destination);
              const legacyHost = expected.hostname.replace("rallywith.ai", "with-avalon.com");
              if (destination.protocol === "https:" && destination.pathname === expected.pathname
                && (destination.host === expected.host || destination.hostname === legacyHost)
                && !destination.username && !destination.password && !destination.search && !destination.hash) {
                registration.destination = observed.destination;
                registration.adoptingExistingDestination = false;
              }
            }
            if (!observed || observed.providerId !== registration.providerId || observed.destination !== registration.destination
              || JSON.stringify([...observed.events].sort()) !== JSON.stringify([...registration.events].sort())) {
              result = { ...registration, state: "action_required", error: "The recorded webhook does not match the approved destination and events. Inspect it in the provider dashboard." };
            } else if (!registration.activeSecretRef || typeof authorized.credentials[registration.activeSecretRef] !== "string"
              || !authorized.credentials[registration.activeSecretRef]
              || (installation?.provider === "granola" && (authorized.credentials.webhookSigningSecret !== authorized.credentials[registration.activeSecretRef]
                || authorized.credentials.webhookEndpointId !== observed.providerId))) {
              result = { ...registration, providerIdVerified: true, state: "action_required",
                error: "The recorded webhook matches, but its signing credential is unavailable. Disconnect this connection, remove the recorded webhook, then connect workspace events again." };
            } else if (!observed.enabled) {
              result = registration.error === "enable_attempted"
                ? { ...registration, state: "action_required", error: "The provider kept the webhook disabled. Check its ping delivery before testing again." }
                : { ...registration, providerIdVerified: true, state: "pending", action: "update", stepId: uuidV7(), error: "enable_attempted" };
            } else result = { ...registration, enabled: true, providerIdVerified: true, state: "current", verifiedAt: new Date().toISOString(), error: null };
          }
        });
      }
    } catch (error) {
      if (isRetirementRefusal(error)) throw error;
      // A create the provider answered with a 4xx was refused: nothing was
      // registered, so there is nothing to inspect and Test may retry it. Only
      // an outcome the provider did not answer — a timeout, a 5xx, a response
      // that could not be read — is unknown, because a registration may exist
      // that a blind retry would duplicate. `writeDispatched` is set on the
      // line before `management.create`, so requiring it keeps the validation
      // read that precedes the create out of this: a key refused there is a
      // failed inspection, not a refused registration, and says so.
      // The receipt carries a sentence for the person; the log carries the
      // step and the provider's own code, which the sentence does not.
      logWarn(env, "connector_installation_step_failed", {
        workspace_id: workspaceId,
        connection_id: connectionId,
        provider: installation?.provider ?? null,
        action: registration.action,
        step_id: registration.stepId ?? null,
        write_dispatched: writeDispatched,
        code: diagnosticErrorCode(error, "connector_installation_step_failed"),
      });
      const refusal = registration.action === "create" && writeDispatched ? providerRefusal(error) : null;
      result = { ...result, ...(registration.action === "rotate" && writeDispatched ? { rotation: "unknown" as const } : {}),
        state: refusal || !writeDispatched ? "failed" : "unknown",
        error: refusal ?? (!writeDispatched ? "Provider inspection failed. Check credentials and test again." : "The provider operation may have completed. Inspect the exact recorded webhook before retrying.") };
    }
    installation = await object.settleConnectorInstallationStep({ ...request, registration: result, ...(replacement ? { credentials: replacement } : {}) });
    await publishWorkspaceSync(localEnv, workspaceId, ["connector_connections"]);
  }
  return installation;
}

export async function enqueueConnectorInstallation(env: Env, installation: ConnectorInstallation) {
  await env.ACTIVITY_QUEUE.send(ConnectorInstallationQueueSchema.parse({ kind: "connector_installation", workspaceId: installation.workspaceId, connectionId: installation.connectionId, region: env.AVALON_REGION }));
}

export function installationView(value: unknown) { return ConnectorInstallationSchema.parse(value); }

const PROVIDER_REFUSAL_STATUSES = new Set([400, 401, 403, 404, 422]);

/**
 * The text a refused create leaves on its registration, or null when the
 * failure says nothing about whether the provider acted.
 *
 * `ConnectorError.details.status` is set only from a provider's own response,
 * so one of these statuses is the provider declining the request before doing
 * anything: a body its schema does not admit, a key without the permission, an
 * API the workspace's plan does not include. The provider's sentence is kept,
 * bounded: it is the one diagnosis an administrator can act on, and it is
 * shown in Settings rather than written to a log.
 */
function providerRefusal(error: unknown): string | null {
  if (!(error instanceof ConnectorError) || typeof error.details !== "object" || error.details === null) return null;
  const status = Number((error.details as { status?: unknown }).status);
  if (!PROVIDER_REFUSAL_STATUSES.has(status)) return null;
  const detail = error.message.replace(/\s+/gu, " ").trim().slice(0, 200);
  return `The provider refused the webhook registration (HTTP ${status}${detail ? `: ${detail}` : ""}). Fix the cause, then test again.`;
}
