import { z } from "zod";
import { IdSchema, UserIdSchema, WorkspaceIdSchema } from "@rally/contracts";
import { ParentEffectEnvelopeSchema, conversationEffectHash, type ParentEffectEnvelope } from "@rally/contracts/conversation-effects";

export const ScopeGrantCandidatesRequestSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema, userId: UserIdSchema, membershipIncarnation: z.string().min(1),
  accessClass: z.enum(["member", "guest"]),
});
export const ScopeGrantCandidatesSchema = z.array(IdSchema);

/** Discovery only. A candidate still needs a current owner authorization read. */
export const SCOPE_GRANT_DIRECTORY_SCHEMA = [
  `CREATE TABLE scope_grant_directory (
    parent_id TEXT NOT NULL, user_id TEXT NOT NULL, scope_kind TEXT NOT NULL,
    substream_id TEXT NOT NULL, membership_incarnation TEXT,
    active INTEGER NOT NULL CHECK(active IN (0,1)),
    generation INTEGER NOT NULL, source_version INTEGER NOT NULL, payload_hash TEXT NOT NULL,
    PRIMARY KEY(parent_id,user_id,scope_kind,substream_id)
  ) STRICT`,
  `CREATE INDEX scope_grant_directory_viewer ON scope_grant_directory(user_id,membership_incarnation,active,parent_id)`,
] as const;

export function applyScopeGrantDirectory(storage: DurableObjectStorage, input: ParentEffectEnvelope): boolean {
  const envelope = ParentEffectEnvelopeSchema.parse(input);
  // Only a Canvas grants a `workstream` target; a Thread parent retired.
  if (envelope.parentKind !== "canvas" || envelope.effect.kind !== "scope_grant_directory") throw new Error("scope_grant_directory_effect_invalid");
  const { grant } = envelope.effect;
  if (grant.target.workspaceId !== envelope.workspaceId || grant.target.parentId !== envelope.parentId
    || conversationEffectHash(envelope.effect) !== envelope.payloadHash) throw new Error("scope_grant_directory_address_invalid");
  const substreamId = grant.target.kind === "workstream" ? "" : grant.target.substreamId;
  return storage.transactionSync(() => {
    const existing = storage.sql.exec<{ generation: number; source_version: number; payload_hash: string }>(
      `SELECT generation,source_version,payload_hash FROM scope_grant_directory
       WHERE parent_id=? AND user_id=? AND scope_kind=? AND substream_id=?`,
      envelope.parentId,grant.userId,grant.target.kind,substreamId,
    ).toArray()[0];
    if (existing) {
      if (existing.generation > envelope.generation || (existing.generation === envelope.generation && existing.source_version > envelope.sourceVersion)) return false;
      if (existing.generation === envelope.generation && existing.source_version === envelope.sourceVersion) {
        if (existing.payload_hash !== envelope.payloadHash) throw new Error("scope_grant_directory_version_conflict");
        return false;
      }
    }
    storage.sql.exec(`INSERT INTO scope_grant_directory(parent_id,user_id,scope_kind,substream_id,membership_incarnation,active,generation,source_version,payload_hash)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(parent_id,user_id,scope_kind,substream_id) DO UPDATE SET
      membership_incarnation=excluded.membership_incarnation,active=excluded.active,generation=excluded.generation,
      source_version=excluded.source_version,payload_hash=excluded.payload_hash`,
    envelope.parentId,grant.userId,grant.target.kind,substreamId,grant.membershipIncarnation,grant.active ? 1 : 0,
    envelope.generation,envelope.sourceVersion,envelope.payloadHash);
    return true;
  });
}

export function scopeGrantCandidates(storage: DurableObjectStorage, userId: string, membershipIncarnation: string): string[] {
  return ScopeGrantCandidatesSchema.parse(storage.sql.exec<{ parent_id: string }>(
    `SELECT DISTINCT parent_id FROM scope_grant_directory WHERE user_id=? AND membership_incarnation=? AND active=1 ORDER BY parent_id`,
    userId,membershipIncarnation,
  ).toArray().map((row) => row.parent_id));
}
