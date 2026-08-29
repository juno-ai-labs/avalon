import {
  WorkspaceTerminalNetworkModeSchema,
  WorkspaceTerminalNetworkSettingsSchema,
  WorkspaceTerminalPolicyClaimResultSchema,
  WorkspaceTerminalPolicySettlementResultSchema,
  type WorkspaceTerminalNetworkMode,
  type WorkspaceTerminalNetworkSettings,
  type WorkspaceTerminalNetworkSettingsRequest,
  type WorkspaceTerminalPolicyClaimRequest,
  type WorkspaceTerminalPolicyClaimResult,
  type WorkspaceTerminalPolicyCommitRequest,
  type WorkspaceTerminalPolicyFailRequest,
  type WorkspaceTerminalPolicyPreviewRequest,
  type WorkspaceTerminalPolicySettlementResult,
} from "./workspace-terminal-network-protocol";

interface PolicyRow extends Record<string, SqlStorageValue> {
  mode: "trusted_only" | "full_internet";
  revision: number;
  verification_state: "pending" | "verified" | "failed";
  baseline_manifest_version: string;
  failure_code: string | null;
  effective_domains_json: string;
}

interface MutationRow extends Record<string, SqlStorageValue> {
  id: string;
  expected_revision: number;
  proposed_mode: "trusted_only" | "full_internet";
  proposed_domains_json: string;
  effective_domains_json: string;
  state: "preview" | "pending" | "verified" | "failed" | "conflict";
}

function policyOf(storage: DurableObjectStorage, workspaceId: string): PolicyRow | undefined {
  return storage.sql.exec<PolicyRow>(
    `SELECT mode, revision, verification_state, baseline_manifest_version,
            failure_code, effective_domains_json
       FROM workspace_sandbox_network_policies WHERE workspace_id = ?`,
    workspaceId,
  ).toArray()[0];
}

function domainsOf(storage: DurableObjectStorage, workspaceId: string): string[] {
  return storage.sql.exec<{ domain: string }>(
    `SELECT domain FROM workspace_sandbox_network_domains
      WHERE workspace_id = ? ORDER BY domain`,
    workspaceId,
  ).toArray().map((row) => row.domain);
}

function policyView(row: PolicyRow) {
  return {
    mode: row.mode,
    revision: row.revision,
    verificationState: row.verification_state,
    baselineManifestVersion: row.baseline_manifest_version,
    failureCode: row.failure_code,
    effectiveDomains: JSON.parse(row.effective_domains_json) as string[],
  };
}

/**
 * Read the policy and its domains, creating the workspace's default first.
 *
 * The insert is `ON CONFLICT DO NOTHING` and the read follows it in the same
 * transaction, so two settings screens opening at once cannot both decide they
 * are the one creating the row.
 */
export function workspaceTerminalNetworkSettings(
  storage: DurableObjectStorage,
  request: WorkspaceTerminalNetworkSettingsRequest,
): WorkspaceTerminalNetworkSettings {
  return storage.transactionSync(() => {
    storage.sql.exec(
      `INSERT INTO workspace_sandbox_network_policies
         (workspace_id, mode, revision, verification_state, baseline_manifest_version,
          effective_domains_json, last_verified_at, created_at, updated_at)
       VALUES (?, 'trusted_only', 1, 'verified', ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id) DO NOTHING`,
      request.workspaceId,
      request.baselineManifestVersion,
      JSON.stringify(request.defaultEffectiveDomains),
      request.at,
      request.at,
      request.at,
    );
    const row = policyOf(storage, request.workspaceId);
    if (!row) throw new Error("terminal_network_policy_missing");
    return WorkspaceTerminalNetworkSettingsSchema.parse({
      policy: policyView(row),
      customDomains: domainsOf(storage, request.workspaceId),
    });
  });
}

/** The mode alone, for the agent path — a read that writes nothing. */
export function workspaceTerminalNetworkMode(
  storage: DurableObjectStorage,
  workspaceId: string,
): WorkspaceTerminalNetworkMode {
  return WorkspaceTerminalNetworkModeSchema.parse({
    mode: policyOf(storage, workspaceId)?.mode ?? null,
  });
}

/** Record a previewed change, so confirming it can be checked against what was shown. */
export function recordWorkspaceTerminalPolicyPreview(
  storage: DurableObjectStorage,
  request: WorkspaceTerminalPolicyPreviewRequest,
): void {
  storage.sql.exec(
    `INSERT INTO workspace_sandbox_network_policy_mutations
       (id, workspace_id, expected_revision, proposed_mode, proposed_domains_json,
        effective_domains_json, affected_sandboxes_json, state, requested_by_user_id,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'preview', ?, ?, ?)`,
    request.mutationId,
    request.workspaceId,
    request.expectedRevision,
    request.proposedMode,
    JSON.stringify(request.proposedDomains),
    JSON.stringify(request.effectiveDomains),
    JSON.stringify(request.affectedWorkstreamIds),
    request.requestedByUserId,
    request.at,
    request.at,
  );
}

/**
 * Take the policy and its preview together, or take neither.
 *
 * This was four statements through the facade: read the mutation, read the
 * policy, claim the policy with a conditional `UPDATE … RETURNING`, then claim
 * the mutation the same way. Claiming the policy and failing to claim the
 * mutation left the workspace in `pending` with nobody applying anything, so
 * the service carried a `restoreCurrentPolicy` compensation for exactly that
 * window — and a compensation is itself a write that can fail. One transaction
 * removes the window and the compensation with it: a refusal here wrote
 * nothing.
 */
export function claimWorkspaceTerminalPolicyApplication(
  storage: DurableObjectStorage,
  request: WorkspaceTerminalPolicyClaimRequest,
): WorkspaceTerminalPolicyClaimResult {
  return storage.transactionSync(() => {
    const current = policyOf(storage, request.workspaceId);
    // A refusal carries nothing but its reason: the union says so, and the
    // caller narrows on `outcome` rather than asserting past two nulls.
    const refusal = (outcome: "preview_stale" | "revision_conflict") =>
      WorkspaceTerminalPolicyClaimResultSchema.parse({ outcome });

    const mutation = storage.sql.exec<MutationRow>(
      `SELECT id, expected_revision, proposed_mode, proposed_domains_json,
              effective_domains_json, state
         FROM workspace_sandbox_network_policy_mutations
        WHERE workspace_id = ? AND id = ? AND requested_by_user_id = ?`,
      request.workspaceId,
      request.mutationId,
      request.requestedByUserId,
    ).toArray()[0];
    if (
      !mutation
      || mutation.state !== "preview"
      || mutation.expected_revision !== request.expectedRevision
    ) return refusal("preview_stale");

    if (!current || current.revision !== request.expectedRevision) {
      // The policy moved under the preview. Mark the preview so it cannot be
      // confirmed later, and refuse — the same outcome the service used to
      // produce with a separate `markMutation` write.
      storage.sql.exec(
        `UPDATE workspace_sandbox_network_policy_mutations
            SET state = 'conflict', failure_code = 'revision_conflict',
                completed_at = ?, updated_at = ?
          WHERE workspace_id = ? AND id = ?`,
        request.at,
        request.at,
        request.workspaceId,
        request.mutationId,
      );
      return refusal("revision_conflict");
    }

    // A returned witness rather than a row count, per
    // `docs/durable-object-sqlite.md`: the statement says which revision it
    // took, so the check is on the fact the statement reports rather than on a
    // row count. This also refuses a policy already `pending` — a
    // preview taken before an application started can still be confirmed while
    // one is in flight, and the second confirm must not join it.
    const claimed = storage.sql.exec<{ revision: number }>(
      `UPDATE workspace_sandbox_network_policies
          SET verification_state = 'pending', failure_code = NULL, updated_at = ?
        WHERE workspace_id = ? AND revision = ? AND verification_state = 'verified'
        RETURNING revision`,
      request.at,
      request.workspaceId,
      request.expectedRevision,
    ).toArray()[0];
    if (claimed?.revision !== request.expectedRevision) return refusal("revision_conflict");

    storage.sql.exec(
      `UPDATE workspace_sandbox_network_policy_mutations
          SET state = 'pending', resulting_revision = ?, confirmed_at = ?, updated_at = ?
        WHERE workspace_id = ? AND id = ? AND state = 'preview'`,
      current.revision + 1,
      request.at,
      request.at,
      request.workspaceId,
      request.mutationId,
    );
    return WorkspaceTerminalPolicyClaimResultSchema.parse({
      outcome: "claimed",
      mutation: {
        proposedMode: mutation.proposed_mode,
        proposedDomains: JSON.parse(mutation.proposed_domains_json) as string[],
        effectiveDomains: JSON.parse(mutation.effective_domains_json) as string[],
      },
      current: policyView(current),
      currentCustomDomains: domainsOf(storage, request.workspaceId),
    });
  });
}

/**
 * Give the claim back with a reason, keeping the last verified policy.
 *
 * Fenced on the mutation, not on the revision. A failed application leaves the
 * revision unchanged, so the next preview claims the same number — and a
 * retried failure for the first would otherwise release the second's claim,
 * putting the policy back to `verified` while its application is still
 * reconciling sandboxes.
 */
export function failWorkspaceTerminalPolicyApplication(
  storage: DurableObjectStorage,
  request: WorkspaceTerminalPolicyFailRequest,
): WorkspaceTerminalPolicySettlementResult {
  return storage.transactionSync(() => {
    const settled = storage.sql.exec<{ id: string }>(
      `UPDATE workspace_sandbox_network_policy_mutations
          SET state = 'failed', failure_code = ?, completed_at = ?, updated_at = ?
        WHERE workspace_id = ? AND id = ? AND state = 'pending'
        RETURNING id`,
      request.failureCode,
      request.at,
      request.at,
      request.workspaceId,
      request.mutationId,
    ).toArray()[0];
    if (settled?.id !== request.mutationId) {
      return WorkspaceTerminalPolicySettlementResultSchema.parse({ outcome: "stale" });
    }
    storage.sql.exec(
      `UPDATE workspace_sandbox_network_policies
          SET verification_state = 'verified', failure_code = ?, updated_at = ?
        WHERE workspace_id = ? AND revision = ? AND verification_state = 'pending'`,
      request.failureCode,
      request.at,
      request.workspaceId,
      request.revision,
    );
    return WorkspaceTerminalPolicySettlementResultSchema.parse({ outcome: "settled" });
  });
}

/**
 * Publish the applied policy: the domain list, the new revision, and the ledger.
 *
 * The mutation is settled first and the policy second, both on returned
 * witnesses, and the domain rows are replaced only once both have said yes. A
 * replayed commit therefore changes nothing: it finds its mutation already out
 * of `pending`, returns `stale`, and leaves the domains a person is looking at
 * agreeing with the revision that published them.
 */
export function commitWorkspaceTerminalPolicyApplication(
  storage: DurableObjectStorage,
  request: WorkspaceTerminalPolicyCommitRequest,
): WorkspaceTerminalPolicySettlementResult {
  return storage.transactionSync(() => {
    const stale = () =>
      WorkspaceTerminalPolicySettlementResultSchema.parse({ outcome: "stale" });
    const settled = storage.sql.exec<{ id: string }>(
      `UPDATE workspace_sandbox_network_policy_mutations
          SET state = 'verified', completed_at = ?, updated_at = ?
        WHERE workspace_id = ? AND id = ? AND state = 'pending'
          AND resulting_revision = ?
        RETURNING id`,
      request.at,
      request.at,
      request.workspaceId,
      request.mutationId,
      request.resultingRevision,
    ).toArray()[0];
    if (settled?.id !== request.mutationId) return stale();

    const published = storage.sql.exec<{ revision: number }>(
      `UPDATE workspace_sandbox_network_policies
          SET mode = ?, revision = ?, verification_state = 'verified',
              effective_domains_json = ?, failure_code = NULL,
              last_verified_at = ?, updated_at = ?
        WHERE workspace_id = ? AND revision = ? AND verification_state = 'pending'
        RETURNING revision`,
      request.mode,
      request.resultingRevision,
      JSON.stringify(request.effectiveDomains),
      request.at,
      request.at,
      request.workspaceId,
      request.claimedRevision,
    ).toArray()[0];
    // The mutation was `pending` and the policy was not, which the claim makes
    // impossible: they are taken together. Refusing the whole transaction is
    // the only answer that leaves the two agreeing.
    if (published?.revision !== request.resultingRevision) {
      throw new Error("terminal_policy_commit_policy_missing");
    }

    storage.sql.exec(
      `DELETE FROM workspace_sandbox_network_domains WHERE workspace_id = ?`,
      request.workspaceId,
    );
    for (const domain of request.customDomains) {
      storage.sql.exec(
        `INSERT INTO workspace_sandbox_network_domains
           (workspace_id, domain, created_by_user_id, created_at) VALUES (?, ?, ?, ?)`,
        request.workspaceId,
        domain,
        request.createdByUserId,
        request.at,
      );
    }
    return WorkspaceTerminalPolicySettlementResultSchema.parse({ outcome: "settled" });
  });
}
