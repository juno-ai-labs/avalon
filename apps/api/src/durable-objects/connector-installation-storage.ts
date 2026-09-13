import { uuidV7 } from "../lib/uuid-v7";
import { ConnectorInstallationSchema, type ConnectorInstallation } from "@rally/contracts";
import type { InstallationCreate, InstallationClaim, InstallationDelivery, InstallationSettle, InstallationChange, InstallationRotationPrepare, InstallationMaintenance, InstallationMaintenanceCancel, InstallationCredentialReplace } from "./connector-installation-protocol";

export function readInstallation(storage: DurableObjectStorage, connectionId: string): ConnectorInstallation | null {
  const row = storage.sql.exec<{ document_json: string }>("SELECT document_json FROM connector_installations WHERE connection_id = ?", connectionId).toArray()[0];
  return row ? ConnectorInstallationSchema.parse(JSON.parse(row.document_json)) : null;
}
function save(storage: DurableObjectStorage, installation: ConnectorInstallation) {
  installation.updatedAt = new Date().toISOString();
  storage.sql.exec("UPDATE connector_installations SET document_json = ?, generation = ? WHERE connection_id = ?",
    JSON.stringify(ConnectorInstallationSchema.parse(installation)), installation.generation, installation.connectionId);
}
function enabled(storage: DurableObjectStorage, connectionId: string) {
  const row = storage.sql.exec<{ status: string }>("SELECT status FROM connector_connections WHERE id = ?", connectionId).toArray()[0];
  return Boolean(row && row.status !== "disabled");
}

/** One object transaction binds retries and reserves provider cardinality before I/O. */
export function createInstallation(storage: DurableObjectStorage, input: InstallationCreate): ConnectorInstallation {
  return storage.transactionSync(() => {
    const installation = input.installation;
    const replay = storage.sql.exec<{ connection_id: string; user_id: string; input_hash: string }>(
      "SELECT connection_id, user_id, input_hash FROM connector_installations WHERE attempt_id = ?", installation.attemptId).toArray()[0];
    if (replay) {
      if (replay.user_id !== input.userId || replay.input_hash !== input.inputHash) throw new Error("connector_setup_idempotency_conflict");
      return readInstallation(storage, replay.connection_id)!;
    }
    const existing = storage.sql.exec<{ id: string }>(
      "SELECT id FROM connector_connections WHERE workspace_id = ? AND connector_type = ? AND scope = 'workspace' AND status <> 'disabled'",
      installation.workspaceId, installation.provider).toArray()[0];
    if (input.adopt) {
      if (installation.provider !== "granola" || existing?.id !== installation.connectionId) throw new Error("connector_adoption_invalid");
      const adopted = readInstallation(storage, existing.id);
      if (adopted) return adopted;
      storage.sql.exec("UPDATE connector_connections SET config_json = json_set(config_json, '$.installationLifecycle', 1) WHERE id = ?", existing.id);
    } else if (existing) throw new Error("workspace_connector_installation_exists");
    if (!input.adopt) storage.sql.exec(`INSERT INTO connector_connections
      (id, workspace_id, connector_type, scope, owner_user_id, display_name, encrypted_credentials, credential_iv,
       credential_key_version, granted_scopes_json, model_plugin_id, config_json, created_at, updated_at)
      VALUES (?, ?, ?, 'workspace', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      installation.connectionId, installation.workspaceId, installation.provider,
      input.displayName ?? `${installation.provider === "ashby" ? "Ashby" : "Granola"} workspace events`,
      input.credentials.ciphertext, input.credentials.iv, input.credentials.keyVersion, JSON.stringify([input.capability]),
      `plugin_${installation.provider}_${installation.connectionId.replaceAll("-", "")}`,
      JSON.stringify({ installationLifecycle: 1, selectedEvents: installation.selectedEvents }), installation.createdAt, installation.createdAt);
    storage.sql.exec(`INSERT INTO connector_installations
      (connection_id, workspace_id, attempt_id, user_id, input_hash, generation, document_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      installation.connectionId, installation.workspaceId, installation.attemptId, input.userId, input.inputHash, installation.generation, JSON.stringify(installation));
    return installation;
  });
}

/**
 * Record a verified delivery, and — where nothing else ever could — let it be
 * the evidence that the registration exists.
 *
 * Every other provider proves a registration by inspecting it: the runner reads
 * the webhook back, compares its destination and events, and only then is the
 * registration `current`. A provider whose `create` is manual and whose
 * `inspect` is unsupported offers no such read, so an installation waiting for
 * inspection would sit in **Action required** forever while meetings arrived
 * perfectly well. The delivery itself is better evidence than an inspection
 * anyway — it is signed with the secret Rally generated, so it proves the
 * registration exists, points here, and carries the right key, which is more
 * than reading a row back proves.
 *
 * Keyed on the facet's support declaration, never on a provider name: what
 * makes a delivery sufficient is that nothing else is available, and the facet
 * is where that is stated.
 */
export function recordInstallationDelivery(storage: DurableObjectStorage, input: InstallationDelivery): ConnectorInstallation | null {
  return storage.transactionSync(() => {
    const installation = readInstallation(storage, input.connectionId);
    if (!installation) return null;
    // Deliveries can arrive out of order; the last-received time only moves
    // forward, so a late one never rewinds what Settings shows.
    const advanced = !installation.lastReceivedAt || installation.lastReceivedAt < input.receivedAt;
    if (advanced) installation.lastReceivedAt = input.receivedAt;
    let changed = advanced;
    const verifiableOnlyByDelivery = input.registrationSupport?.create === "manual"
      && input.registrationSupport.inspect === "unsupported";
    // A disabled connection is in cleanup: a delivery that somehow reaches it
    // must not restore an installation the administrator removed.
    if (verifiableOnlyByDelivery && enabled(storage, input.connectionId)) {
      for (const registration of installation.registrations) {
        if (registration.action === "remove" || registration.state === "removed" || registration.state === "current") continue;
        registration.state = "current";
        registration.verifiedAt = input.receivedAt;
        registration.error = null;
        changed = true;
      }
      const coversSelection = installation.selectedEvents.every((event) => installation.registrations
        .some((item) => item.state === "current" && item.events.includes(event)));
      if (coversSelection && installation.registrations.every((item) => item.state === "current" || item.state === "removed")) {
        installation.state = "current";
        installation.error = null;
        installation.appliedVersion = installation.desiredVersion;
      }
    }
    if (!changed) return installation;
    save(storage, installation);
    return installation;
  });
}

export function claimInstallation(storage: DurableObjectStorage, input: InstallationClaim): { claimed: boolean; installation: ConnectorInstallation | null } {
  return storage.transactionSync(() => {
    const installation = readInstallation(storage, input.connectionId);
    if (!installation || installation.maintenanceCancelled || installation.generation !== input.generation) return { claimed: false, installation };
    const registration = installation.registrations.find((item) => item.stepId === input.stepId);
    if (!registration || registration.state !== "pending" || (registration.action === "remove" && !registration.providerIdVerified)) return { claimed: false, installation };
    if (installation.registrations.some((item) => item.state === "dispatched")) return { claimed: false, installation };
    if (registration.afterRegistrationKeys.some((key) => !installation.registrations.some((item) => item.key === key && item.state === "current"))) return { claimed: false, installation };
    if (!enabled(storage, input.connectionId) && registration.action !== "remove") return { claimed: false, installation };
    registration.state = "dispatched";
    if (registration.action === "rotate") registration.rotation = "dispatched";
    storage.sql.exec(`INSERT INTO connector_installation_steps (step_id, connection_id, generation, state, intent_json, created_at)
      VALUES (?, ?, ?, 'dispatched', ?, ?)`, registration.stepId, input.connectionId, input.generation,
      JSON.stringify(registration), new Date().toISOString());
    save(storage, installation);
    return { claimed: true, installation };
  });
}

export function settleInstallation(storage: DurableObjectStorage, input: InstallationSettle): ConnectorInstallation | null {
  return storage.transactionSync(() => {
    const installation = readInstallation(storage, input.connectionId);
    if (!installation) return null;
    const step = storage.sql.exec<{ state: string; intent_json: string }>("SELECT state, intent_json FROM connector_installation_steps WHERE step_id = ? AND connection_id = ? AND generation = ?",
      input.stepId, input.connectionId, input.generation).toArray()[0];
    if (!step || step.state !== "dispatched") return installation;
    storage.sql.exec("UPDATE connector_installation_steps SET state = ?, result_json = ? WHERE step_id = ?", input.registration.state, JSON.stringify(input.registration), input.stepId);
    if (installation.generation !== input.generation) {
      // Repair and credential replacement also advance the generation. A late
      // create still wanted by an enabled installation must not become cleanup.
      if (input.registration.providerId && !installation.registrations.some((item) => item.providerId === input.registration.providerId)) {
        const placeholder = installation.registrations.findIndex((item) => item.key === input.registration.key && !item.providerId);
        const desired = installation.registrations[placeholder];
        if (enabled(storage, input.connectionId) && desired && desired.action !== "remove" && desired.state !== "removed"
          && desired.destination === input.registration.destination
          && JSON.stringify([...desired.events].sort()) === JSON.stringify([...input.registration.events].sort())
          && desired.events.every((event) => installation.selectedEvents.includes(event))) {
          // Provider-generated signing material belongs to the stale envelope.
          // Never restore that envelope over a replacement API key: retain the
          // exact remote identity for manual recovery/removal instead.
          const needsRecovery = installation.provider === "granola" || installation.maintenanceCancelled;
          installation.registrations[placeholder] = { ...desired, providerId: input.registration.providerId,
            providerIdVerified: input.registration.providerIdVerified, action: "inspect", stepId: uuidV7(),
            state: needsRecovery ? "action_required" : "pending", verifiedAt: null,
            error: installation.provider === "granola"
              ? "The webhook was created, but its signing secret could not be saved safely. Disconnect this connection, remove the recorded webhook, then connect workspace events again."
              : needsRecovery ? "Maintenance was cancelled. Use Test to inspect this recorded webhook." : null };
          installation.state = needsRecovery ? "action_required" : "updating";
          save(storage, installation);
          return installation;
        }
        // Disconnected or obsolete registrations still belong to our cleanup.
        const cleanup = { ...input.registration, action: "remove" as const, state: "pending" as const, stepId: uuidV7(), verifiedAt: null };
        if (placeholder >= 0) installation.registrations[placeholder] = cleanup;
        else installation.registrations.push({ ...cleanup, key: `${cleanup.key}:superseded:${input.generation}` });
        installation.state = enabled(storage, input.connectionId) ? "updating" : "cleanup_pending";
        save(storage, installation);
      }
      return installation;
    }
    const index = installation.registrations.findIndex((item) => item.stepId === input.stepId);
    if (index < 0) return installation;
    const previous = installation.registrations[index]!;
    if (input.registration.rotation === "verified" && previous.rotation !== "verified") {
      if (previous.action !== "rotate" || !previous.pendingSecretRef || !input.credentials
        || !input.registration.rotationEvidence || input.registration.rotationGeneration !== previous.rotationGeneration) throw new Error("connector_rotation_verification_required");
      input.registration.activeSecretRef = previous.pendingSecretRef;
      input.registration.pendingSecretRef = null;
      input.registration.verificationPolicy = "active";
    }
    installation.registrations[index] = input.registration;
    if (input.credentials && enabled(storage, input.connectionId)) {
      storage.sql.exec("UPDATE connector_connections SET encrypted_credentials = ?, credential_iv = ?, credential_key_version = ? WHERE id = ? AND status <> 'disabled'",
        input.credentials.ciphertext, input.credentials.iv, input.credentials.keyVersion, input.connectionId);
      // A caller that read the old envelope must lose its replacement CAS even
      // when no administrator action occurred between that read and this write.
      installation.generation += 1;
    }
    const disconnected = !enabled(storage, input.connectionId);
    if (installation.registrations.every((item) => item.state === "removed" || (!disconnected && item.state === "current"))) {
      const coversSelection = installation.selectedEvents.every((event) => installation.registrations.some((item) => item.state === "current" && item.events.includes(event)));
      installation.state = disconnected ? "disconnected" : coversSelection ? "current" : "action_required";
      if (disconnected || coversSelection) installation.error = null;
      if (!disconnected && coversSelection) installation.appliedVersion = installation.desiredVersion;
      if (!disconnected && !coversSelection) installation.error = "Selected events have no active webhook. Disconnect this connection and connect workspace events again.";
      if (disconnected) storage.sql.exec("UPDATE connector_installations SET cleanup_ciphertext = NULL, cleanup_iv = NULL, cleanup_key_version = NULL WHERE connection_id = ?", input.connectionId);
    } else if (disconnected) installation.state = "cleanup_pending";
    else if (installation.registrations.some((item) => ["unknown", "action_required"].includes(item.state))) installation.state = "action_required";
    else if (installation.registrations.some((item) => item.state === "failed")) installation.state = "failed";
    save(storage, installation);
    return installation;
  });
}

export function changeInstallation(storage: DurableObjectStorage, input: InstallationChange): ConnectorInstallation {
  return storage.transactionSync(() => {
    const installation = readInstallation(storage, input.connectionId);
    if (!installation) throw new Error("connector_installation_not_found");
    // HTTP retries must preserve the existing cleanup claim and its receipt,
    // including a completed removal whose credential has already been erased.
    if (input.action === "disconnect" && !enabled(storage, input.connectionId)) return installation;
    if (input.action === 'repair' || input.action === 'disconnect') {
      installation.maintenanceOperationId = null;
      installation.maintenanceCancelled = false;
    }
    if (input.action === "forget_cleanup") {
      installation.cleanupCredentialForgotten = true;
      if (enabled(storage, input.connectionId)) throw new Error("connector_still_enabled");
      storage.sql.exec("UPDATE connector_installations SET cleanup_ciphertext = NULL, cleanup_iv = NULL, cleanup_key_version = NULL WHERE connection_id = ?", input.connectionId);
      installation.generation += 1;
      installation.registrations = installation.registrations.map((item) => item.state === "removed" ? item : { ...item, state: "action_required", stepId: uuidV7() });
      installation.error = "Local cleanup credential removed. Remove remaining registrations in the provider dashboard.";
      save(storage, installation); return installation;
    }
    if (input.action === "rotate") {
      installation.error = "Automatic signing-key cutover is not verified for this provider. To replace the signing key now, disconnect this workspace connection, finish cleanup of the exact recorded webhooks (or remove them in the provider dashboard), then connect workspace events again. Delivery is interrupted until the new registrations are verified. No key has been changed.";
      installation.state = "action_required"; save(storage, installation); return installation;
    }
    if (input.action === "disconnect") {
      storage.sql.exec(`UPDATE connector_installations SET
        cleanup_ciphertext = COALESCE(cleanup_ciphertext, (SELECT encrypted_credentials FROM connector_connections WHERE id = ?)),
        cleanup_iv = COALESCE(cleanup_iv, (SELECT credential_iv FROM connector_connections WHERE id = ?)),
        cleanup_key_version = COALESCE(cleanup_key_version, (SELECT credential_key_version FROM connector_connections WHERE id = ?))
        WHERE connection_id = ?`, input.connectionId, input.connectionId, input.connectionId, input.connectionId);
      storage.sql.exec("UPDATE connector_connections SET status = 'disabled', encrypted_credentials = NULL, credential_iv = NULL, credential_refresh_lease_id = NULL, credential_refresh_lease_expires_at = NULL, updated_at = ? WHERE id = ?", new Date().toISOString(), input.connectionId);
      installation.generation += 1; installation.state = "cleanup_pending";
      installation.registrations = installation.registrations.map((item) => item.state === "removed" ? item : ({ ...item,
        action: "remove", afterRegistrationKeys: [], state: item.providerId ? item.providerIdVerified ? "pending" : "action_required" : item.state === "pending" ? "removed" : "action_required",
        error: !item.providerId && item.state !== "pending" ? "Inspect the provider for a webhook whose create outcome is unknown." : null,
        stepId: uuidV7(),
      }));
    } else {
      if (!enabled(storage, input.connectionId)) {
        if (input.action !== "repair") throw new Error("connector_disabled");
        if (input.action === "repair") {
          const cleanup = storage.sql.exec<{ cleanup_ciphertext: string | null }>("SELECT cleanup_ciphertext FROM connector_installations WHERE connection_id = ?", input.connectionId).one();
          if (!cleanup.cleanup_ciphertext) throw new Error("connector_cleanup_credential_unavailable");
          installation.generation += 1;
          installation.registrations = installation.registrations.map((item) => item.providerId && item.providerIdVerified && item.state !== "removed"
            ? { ...item, action: "remove", state: "pending", stepId: uuidV7() } : item);
          save(storage, installation); return installation;
        }
      }
      // Unknown creates stay unknown. A supplied ID must pass provider inspection
      // against the exact destination and event selection before it is adopted.
      if (input.action === "reconcile") {
        const registration = installation.registrations.find((item) => item.key === input.key);
        if (!registration || !input.providerId || registration.providerId) throw new Error("connector_reconciliation_invalid");
        registration.providerId = input.providerId;
        registration.providerIdVerified = false;
        registration.action = "inspect"; registration.state = "pending"; registration.stepId = uuidV7();
      } else {
        if (installation.registrations.some((item) => item.state === "dispatched")) {
          installation.generation += 1;
          installation.registrations = installation.registrations.map((item) => item.state === "dispatched"
            ? { ...item, state: "unknown", error: "Inspect the provider outcome before retrying.", stepId: uuidV7() } : item);
          installation.error = "An operation was dispatched. Inspect its provider outcome before retrying.";
          installation.state = "action_required"; save(storage, installation); return installation;
        }
        installation.registrations = installation.registrations.map((item) => item.state === "removed" || item.pendingSecretRef ? item : item.providerId
          ? { ...item, action: item.action === "remove" || item.action === "update" ? item.action : "inspect", state: "pending", stepId: uuidV7() }
          : item.state === "failed" && item.action === "create" ? { ...item, state: "pending", stepId: uuidV7() } : item);
      }
      installation.generation += 1;
      installation.state = installation.registrations.some((item) => item.pendingSecretRef && item.state !== "pending") ? "action_required" : "updating";
    }
    if (!enabled(storage, input.connectionId) && installation.registrations.every((item) => item.state === "removed")) {
      installation.state = "disconnected";
      storage.sql.exec("UPDATE connector_installations SET cleanup_ciphertext = NULL, cleanup_iv = NULL, cleanup_key_version = NULL WHERE connection_id = ?", input.connectionId);
    }
    save(storage, installation); return installation;
  });
}

/** Pending material and its acceptance policy commit before a provider can switch keys. */
export function prepareInstallationRotation(storage: DurableObjectStorage, input: InstallationRotationPrepare): ConnectorInstallation {
  return storage.transactionSync(() => {
    const installation = readInstallation(storage, input.connectionId);
    if (!installation || installation.generation !== input.generation || !enabled(storage, input.connectionId)) throw new Error("connector_rotation_superseded");
    const registration = installation.registrations.find((item) => item.key === input.key);
    if (!registration?.providerId || !registration.activeSecretRef || registration.state !== "current"
      || registration.pendingSecretRef || input.pendingSecretRef === registration.activeSecretRef
      || installation.registrations.some((item) => item.state === "dispatched")) throw new Error("connector_rotation_not_ready");
    registration.pendingSecretRef = input.pendingSecretRef;
    registration.rotationGeneration += 1;
    registration.rotation = "prepared"; registration.rotationEvidence = null;
    registration.verificationPolicy = input.verificationPolicy;
    registration.state = "pending"; registration.action = "rotate"; registration.stepId = uuidV7();
    installation.generation += 1; installation.state = "updating";
    storage.sql.exec("UPDATE connector_connections SET encrypted_credentials = ?, credential_iv = ?, credential_key_version = ? WHERE id = ? AND status <> 'disabled'",
      input.credentials.ciphertext, input.credentials.iv, input.credentials.keyVersion, input.connectionId);
    save(storage, installation); return installation;
  });
}

export function prepareInstallationMaintenance(storage: DurableObjectStorage, input: InstallationMaintenance): ConnectorInstallation {
  return storage.transactionSync(() => {
    const installation = readInstallation(storage, input.connectionId);
    if (!installation || !enabled(storage, input.connectionId)) throw new Error('connector_installation_unavailable');
    if (installation.maintenanceOperationId === input.operationId && !input.resume) return installation;
    if (installation.maintenanceOperationId !== input.operationId && installation.generation !== input.generation) throw new Error('connector_installation_superseded');
    let prepared: ConnectorInstallation;
    if (input.configuration && !input.resume) {
      if (input.configuration.selectedEvents.some((event) => !installation.selectedEvents.includes(event))) throw new Error('connector_scope_expansion_requires_customer');
      if (installation.registrations.some((registration) => registration.state === 'dispatched' || registration.state === 'unknown')) throw new Error('connector_provider_outcome_unresolved');
      prepared = { ...installation, ...input.configuration, generation: installation.generation + 1, state: 'updating', error: null };
      storage.sql.exec("UPDATE connector_connections SET config_json = json_set(config_json, '$.selectedEvents', json(?)) WHERE id = ?", JSON.stringify(input.configuration.selectedEvents), input.connectionId);
      if (input.credentials) storage.sql.exec("UPDATE connector_connections SET encrypted_credentials = ?, credential_iv = ?, credential_key_version = ? WHERE id = ?", input.credentials.ciphertext, input.credentials.iv, input.credentials.keyVersion, input.connectionId);
      if (prepared.registrations.every((registration) => registration.state === 'current' || registration.state === 'removed')) {
        prepared.state = 'current'; prepared.appliedVersion = input.version;
      }
    } else prepared = changeInstallation(storage, { workspaceId: input.workspaceId, connectionId: input.connectionId, action: 'repair' });
    prepared.maintenanceOperationId = input.operationId;
    prepared.desiredVersion = input.version;
    prepared.maintenanceCancelled = false;
    save(storage, prepared);
    return prepared;
  });
}

export function cancelInstallationMaintenance(storage: DurableObjectStorage, input: InstallationMaintenanceCancel): ConnectorInstallation | null {
  return storage.transactionSync(() => {
    const installation = readInstallation(storage, input.connectionId);
    if (!installation || installation.maintenanceOperationId !== input.operationId || installation.maintenanceCancelled) return installation;
    installation.generation += 1;
    installation.maintenanceCancelled = true;
    installation.state = 'action_required';
    installation.error = 'Operator maintenance was cancelled. An in-flight provider request may still complete; inspect the recorded state before Test.';
    installation.registrations = installation.registrations.map((item) => item.state === 'pending' || item.state === 'dispatched'
      ? { ...item, state: 'unknown', stepId: uuidV7() } : item);
    save(storage, installation);
    return installation;
  });
}

/** Credential replacement cannot revive a disabled connection or erase unknown provider work. */
export function replaceInstallationCredentials(storage: DurableObjectStorage, input: InstallationCredentialReplace): ConnectorInstallation {
  return storage.transactionSync(() => {
    const installation = readInstallation(storage, input.connectionId);
    if (!installation || !enabled(storage, input.connectionId) || installation.generation !== input.generation) throw new Error('connector_installation_superseded');
    const prepared = changeInstallation(storage, { workspaceId: input.workspaceId, connectionId: input.connectionId, action: 'repair' });
    storage.sql.exec("UPDATE connector_connections SET encrypted_credentials = ?, credential_iv = ?, credential_key_version = ?, status = 'healthy', updated_at = ? WHERE id = ? AND status <> 'disabled'",
      input.credentials.ciphertext, input.credentials.iv, input.credentials.keyVersion, new Date().toISOString(), input.connectionId);
    return prepared;
  });
}
