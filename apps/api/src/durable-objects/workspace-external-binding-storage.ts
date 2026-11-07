import type {
  ExternalBinding,
  ExternalBindingClaim,
  ExternalBindingConversationTarget,
  ExternalBindingResolution,
  ExternalBindingSuspensionReason,
  ExternalBindingTarget,
  ExternalPath,
} from "./workspace-external-binding-protocol";

/**
 * WorkspaceDO migration 85: the binding table, and every existing Slack Agent
 * session's thread key carried into it as an active thread binding.
 *
 * The key is installation + path. The installation is the provider
 * installation, not the `connector_connections` row: a Slack workspace that is
 * disconnected and reconnected may get a new connection row, and a suspension
 * has to keep the binding's identity so that reconnecting brings it back. For
 * the same reason the table has no foreign key to `connector_connections`.
 *
 * `path_json` is the canonical `JSON.stringify` of the segment array (SQLite's
 * `json_array` writes the same bytes for the plain provider identifiers it
 * holds), so a key compares and prefixes as text.
 *
 * The migrated rows are exact: the session's own team, channel and root
 * timestamp, pointing at the session's own Channel. Nothing is rebound by title
 * or thread text, and no room binding is inferred for an old thread.
 */
export const EXTERNAL_CONVERSATION_BINDINGS_MIGRATION: readonly string[] = [
  `CREATE TABLE external_conversation_bindings (
    installation_id TEXT NOT NULL,
    path_json TEXT NOT NULL CHECK (
      json_valid(path_json) AND json_type(path_json) = 'array' AND json_array_length(path_json) > 0
    ),
    target_kind TEXT NOT NULL CHECK (target_kind IN ('space', 'conversation')),
    space_id TEXT,
    parent_kind TEXT CHECK (parent_kind IS NULL OR parent_kind IN ('workstream', 'automation')),
    parent_id TEXT,
    substream_id TEXT,
    state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'suspended')),
    suspended_reason TEXT CHECK (suspended_reason IS NULL OR suspended_reason IN (
      'provider_membership_ended', 'provider_room_archived', 'connection_disconnected',
      'sidekick_deleted', 'closed'
    )),
    claim_key TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (installation_id, path_json),
    CHECK (
      (target_kind = 'space' AND space_id IS NOT NULL
        AND parent_kind IS NULL AND parent_id IS NULL AND substream_id IS NULL)
      OR (target_kind = 'conversation' AND space_id IS NULL
        AND parent_kind IS NOT NULL AND parent_id IS NOT NULL AND substream_id IS NOT NULL)
    ),
    CHECK ((state = 'suspended') = (suspended_reason IS NOT NULL)),
    CHECK ((state = 'pending') = (claim_key IS NOT NULL))
  ) STRICT`,
  // Suspending every binding to one Sidekick's runs, and closing one run's.
  `CREATE INDEX external_conversation_bindings_target_idx
    ON external_conversation_bindings(parent_kind, parent_id, substream_id)
    WHERE target_kind = 'conversation'`,
  `INSERT OR IGNORE INTO external_conversation_bindings
     (installation_id, path_json, target_kind, space_id, parent_kind, parent_id, substream_id,
      state, suspended_reason, claim_key, created_at, updated_at)
   SELECT 'slack:' || slack_team_id, json_array(slack_channel_id, slack_thread_ts),
          'conversation', NULL, 'workstream', workstream_id, '0',
          'active', NULL, NULL, created_at, updated_at
     FROM slack_agent_sessions`,
];

/**
 * What a lasting suspension (a person closing, a deletion, the bot leaving or
 * the room being archived) may overwrite: an active row, or one only a
 * disconnect suspended, which a reconnect would otherwise reactivate.
 */
const REPLACEABLE_BY_LASTING_SUSPENSION =
  "(state = 'active' OR (state = 'suspended' AND suspended_reason = 'connection_disconnected'))";

/**
 * Migration 90: whether a room's Space is one it joined by name rather than
 * its own. Recorded at link time because nothing else can say later: the
 * room-derived id stops matching once Slack renumbers a room, and a Space's
 * scope can be changed. Every row before this one is a room's own Space or a
 * conversation, since matching did not exist, so the default is the truth for
 * them.
 */
export const EXTERNAL_BINDING_SPACE_MATCHED_MIGRATION: readonly string[] = [
  `ALTER TABLE external_conversation_bindings
     ADD COLUMN space_matched INTEGER NOT NULL DEFAULT 0 CHECK (space_matched IN (0, 1))`,
];

interface BindingRow extends Record<string, SqlStorageValue> {
  installation_id: string;
  path_json: string;
  target_kind: "space" | "conversation";
  space_id: string | null;
  parent_kind: "workstream" | "automation" | null;
  parent_id: string | null;
  substream_id: string | null;
  state: "pending" | "active" | "suspended";
  suspended_reason: ExternalBindingSuspensionReason | null;
  claim_key: string | null;
  created_at: string;
  updated_at: string;
  /** Read only where it is selected: `resolve`. */
}

const COLUMNS = `installation_id, path_json, target_kind, space_id, parent_kind, parent_id,
  substream_id, state, suspended_reason, claim_key, created_at, updated_at`;

/** The one spelling of a path as a key. */
export function externalPathKey(path: ExternalPath): string {
  return JSON.stringify(path);
}

/**
 * The text every descendant key of `path` starts with, and the first key past
 * them all. A descendant's canonical JSON is the ancestor's with its closing
 * `]` replaced by `,` and more segments, so the descendants are exactly the
 * keys in `[lower, upper)` under SQLite's binary collation.
 */
function descendantRange(path: ExternalPath): { lower: string; upper: string } {
  const key = externalPathKey(path);
  const lower = `${key.slice(0, -1)},`;
  return { lower, upper: `${key.slice(0, -1)}-` };
}

function pathOf(row: BindingRow): ExternalPath {
  return JSON.parse(row.path_json) as ExternalPath;
}

function targetOf(row: BindingRow): ExternalBindingTarget {
  return row.target_kind === "space"
    ? { kind: "space", spaceId: row.space_id! }
    : {
        kind: "conversation",
        parentKind: row.parent_kind!,
        parentId: row.parent_id!,
        substreamId: row.substream_id!,
      };
}

function sameConversation(row: BindingRow, target: ExternalBindingConversationTarget): boolean {
  return row.target_kind === "conversation"
    && row.parent_kind === target.parentKind
    && row.parent_id === target.parentId
    && row.substream_id === target.substreamId;
}

export type ExternalBindingClaimOutcome =
  | { outcome: "claimed" }
  /** Another live attempt holds the path. */
  | { outcome: "held" }
  /** The path is already active or suspended; a second conversation must not be made. */
  | { outcome: "bound" };

/**
 * The binding table's statements. Every method is synchronous, so a caller may
 * run it inside a transaction it already holds (`reserveChannelInSpaces`,
 * `reserveSpace`'s link); a method that needs several statements to be one
 * decision opens its own `transactionSync`, which nests.
 */
export class ExternalConversationBindingStorage {
  constructor(private readonly storage: DurableObjectStorage) {}

  private get sql(): SqlStorage {
    return this.storage.sql;
  }

  read(installationId: string, path: ExternalPath): ExternalBinding | null {
    const row = this.row(installationId, path);
    return row ? this.binding(row) : null;
  }

  private row(installationId: string, path: ExternalPath): BindingRow | undefined {
    return this.sql.exec<BindingRow>(
      `SELECT ${COLUMNS} FROM external_conversation_bindings
        WHERE installation_id = ? AND path_json = ?`,
      installationId,
      externalPathKey(path),
    ).toArray()[0];
  }

  private binding(row: BindingRow): ExternalBinding {
    return {
      installationId: row.installation_id,
      path: pathOf(row),
      target: targetOf(row),
      state: row.state,
      suspendedReason: row.suspended_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * The resolution rule, over the exact path and every ancestor in one read.
   *
   * A suspended binding anywhere on the path stops everything under it, which
   * is how suspending a room stops each of its threads without touching their
   * rows. A pending exact path holds a second event rather than creating a
   * second conversation; the attempt that claimed it (same `claimKey`), or any
   * attempt once the claim is older than `pendingStaleBefore`, may resume it.
   */
  resolve(input: {
    installationId: string;
    path: ExternalPath;
    addressed: boolean;
    claimKey: string | null;
    pendingStaleBefore: string;
  }): ExternalBindingResolution {
    const keys = input.path.map((_, index) => externalPathKey(input.path.slice(0, index + 1)));
    const rows = this.sql.exec<BindingRow>(
      `SELECT ${COLUMNS} FROM external_conversation_bindings
        WHERE installation_id = ? AND path_json IN (${keys.map(() => "?").join(", ")})`,
      input.installationId,
      ...keys,
    ).toArray();
    const byKey = new Map(rows.map((row) => [row.path_json, row]));
    const chain = keys.map((key) => byKey.get(key));
    for (const row of chain) {
      if (row?.state === "suspended") {
        return { outcome: "suspended", path: pathOf(row), reason: row.suspended_reason! };
      }
    }
    const exact = chain.at(-1);
    if (exact?.state === "active" && exact.target_kind === "conversation") {
      return { outcome: "deliver", target: targetOf(exact) as ExternalBindingConversationTarget };
    }
    const reclaimable = exact?.state === "pending"
      && (exact.claim_key === input.claimKey || exact.updated_at < input.pendingStaleBefore);
    if (exact?.state === "pending" && !reclaimable) return { outcome: "hold" };
    // A room bound to a Space opened Channels for its addressed threads; Spaces
    // and Channels are retired (plan step C-4), so such a room routes nowhere.
    return { outcome: "none" };
  }

  /**
   * Claim a thread path `pending` for the conversation `target` names.
   *
   * The upsert takes the row when there is none, and takes over only a pending
   * claim that is this attempt's own or has been abandoned. The witness is the
   * returned row compared to the claim just made, never a write count.
   */
  claim(claim: ExternalBindingClaim, target: ExternalBindingConversationTarget, at: string): ExternalBindingClaimOutcome {
    const claimed = this.sql.exec<{ claim_key: string; parent_id: string }>(
      `INSERT INTO external_conversation_bindings
         (${COLUMNS})
       VALUES (?, ?, 'conversation', NULL, ?, ?, ?, 'pending', NULL, ?, ?, ?)
       ON CONFLICT(installation_id, path_json) DO UPDATE SET
         parent_kind = excluded.parent_kind,
         parent_id = excluded.parent_id,
         substream_id = excluded.substream_id,
         claim_key = excluded.claim_key,
         updated_at = excluded.updated_at
       WHERE external_conversation_bindings.state = 'pending'
         AND (external_conversation_bindings.claim_key = excluded.claim_key
           OR external_conversation_bindings.updated_at < ?)
       RETURNING claim_key, parent_id`,
      claim.installationId,
      externalPathKey(claim.path),
      target.parentKind,
      target.parentId,
      target.substreamId,
      claim.claimKey,
      at,
      at,
      claim.pendingStaleBefore,
    ).toArray()[0];
    if (claimed?.claim_key === claim.claimKey && claimed.parent_id === target.parentId) {
      return { outcome: "claimed" };
    }
    const existing = this.row(claim.installationId, claim.path);
    return existing?.state === "pending" ? { outcome: "held" } : { outcome: "bound" };
  }

  /** The creation finished: the pending claim for exactly this target turns active. */
  activate(installationId: string, path: ExternalPath, target: ExternalBindingConversationTarget, at: string):
    "activated" | "already_active" | "missing" | "conflict" {
    const activated = this.sql.exec<{ path_json: string }>(
      `UPDATE external_conversation_bindings
          SET state = 'active', claim_key = NULL, updated_at = ?
        WHERE installation_id = ? AND path_json = ? AND state = 'pending'
          AND target_kind = 'conversation' AND parent_kind = ? AND parent_id = ? AND substream_id = ?
        RETURNING path_json`,
      at,
      installationId,
      externalPathKey(path),
      target.parentKind,
      target.parentId,
      target.substreamId,
    ).toArray()[0];
    if (activated) return "activated";
    const existing = this.row(installationId, path);
    if (!existing) return "missing";
    return existing.state === "active" && sameConversation(existing, target) ? "already_active" : "conflict";
  }

  /** The creation failed: its pending claim goes, so no binding names an absent conversation. */
  release(installationId: string, path: ExternalPath, target: ExternalBindingConversationTarget): boolean {
    return this.sql.exec<{ path_json: string }>(
      `DELETE FROM external_conversation_bindings
        WHERE installation_id = ? AND path_json = ? AND state = 'pending'
          AND target_kind = 'conversation' AND parent_kind = ? AND parent_id = ? AND substream_id = ?
        RETURNING path_json`,
      installationId,
      externalPathKey(path),
      target.parentKind,
      target.parentId,
      target.substreamId,
    ).toArray().length > 0;
  }

  /**
   * An outbound send's reply thread, bound to the run child that sent it.
   *
   * The first binding of a path wins: no model-proposed target overrides a
   * recorded one, so a send into a thread another conversation already owns
   * leaves that thread where it is.
   */
  recordOutbound(installationId: string, path: ExternalPath, target: ExternalBindingConversationTarget, at: string):
    "bound" | "already_bound" | "conflict" {
    const inserted = this.sql.exec<{ path_json: string }>(
      `INSERT INTO external_conversation_bindings (${COLUMNS})
       VALUES (?, ?, 'conversation', NULL, ?, ?, ?, 'active', NULL, NULL, ?, ?)
       ON CONFLICT(installation_id, path_json) DO NOTHING
       RETURNING path_json`,
      installationId,
      externalPathKey(path),
      target.parentKind,
      target.parentId,
      target.substreamId,
      at,
      at,
    ).toArray()[0];
    if (inserted) return "bound";
    const existing = this.row(installationId, path);
    return existing && sameConversation(existing, target) ? "already_bound" : "conflict";
  }

  /** The most recent active outbound (run-child) binding under a room. */
  latestOutboundUnder(
    installationId: string,
    prefix: ExternalPath,
  ): { path: ExternalPath; sidekickId: string; runId: string } | null {
    const range = descendantRange(prefix);
    const row = this.sql.exec<{ path_json: string; parent_id: string; substream_id: string }>(
      `SELECT path_json, parent_id, substream_id FROM external_conversation_bindings
        WHERE installation_id = ? AND path_json >= ? AND path_json < ?
          AND state = 'active' AND target_kind = 'conversation' AND parent_kind = 'automation'
        ORDER BY created_at DESC, path_json DESC LIMIT 1`,
      installationId,
      range.lower,
      range.upper,
    ).toArray()[0];
    return row
      ? { path: JSON.parse(row.path_json) as ExternalPath, sidekickId: row.parent_id, runId: row.substream_id }
      : null;
  }

  /**
   * Suspend one binding, or every active binding of an installation.
   *
   * The row and its target stay: a suspended room stops its threads through
   * resolution, and the binding's identity is what a re-invitation or a
   * reconnect reactivates.
   */
  suspend(input: {
    installationId: string;
    path?: ExternalPath | undefined;
    reason: ExternalBindingSuspensionReason;
    at: string;
  }): ExternalPath[] {
    // A disconnect only suspends what is active. Any other reason is lasting,
    // so it also replaces a disconnect's suspension: left in place, the
    // reconnect would bring back a room the bot has since left.
    const replaceable = input.reason === "connection_disconnected"
      ? "state = 'active'"
      : REPLACEABLE_BY_LASTING_SUSPENSION;
    const rows = input.path
      ? this.sql.exec<{ path_json: string }>(
        `UPDATE external_conversation_bindings
            SET state = 'suspended', suspended_reason = ?, claim_key = NULL, updated_at = ?
          WHERE installation_id = ? AND path_json = ? AND ${replaceable}
          RETURNING path_json`,
        input.reason,
        input.at,
        input.installationId,
        externalPathKey(input.path),
      ).toArray()
      : this.sql.exec<{ path_json: string }>(
        `UPDATE external_conversation_bindings
            SET state = 'suspended', suspended_reason = ?, claim_key = NULL, updated_at = ?
          WHERE installation_id = ? AND ${replaceable}
          RETURNING path_json`,
        input.reason,
        input.at,
        input.installationId,
      ).toArray();
    return rows.map((row) => JSON.parse(row.path_json) as ExternalPath);
  }

  /**
   * Bring back what the provider side suspended, and nothing a person or a
   * deletion did. Without a path: what a disconnect suspended across the
   * installation. With one: that room, suspended because the bot left or the
   * room was archived, now that the bot is back in it.
   */
  reactivate(installationId: string, at: string, path?: ExternalPath): ExternalPath[] {
    const rows = path
      ? this.sql.exec<{ path_json: string }>(
        `UPDATE external_conversation_bindings
            SET state = 'active', suspended_reason = NULL, updated_at = ?
          WHERE installation_id = ? AND path_json = ? AND state = 'suspended'
            AND suspended_reason IN ('provider_membership_ended', 'provider_room_archived', 'connection_disconnected')
          RETURNING path_json`,
        at,
        installationId,
        externalPathKey(path),
      ).toArray()
      : this.sql.exec<{ path_json: string }>(
        `UPDATE external_conversation_bindings
            SET state = 'active', suspended_reason = NULL, updated_at = ?
          WHERE installation_id = ? AND state = 'suspended' AND suspended_reason = 'connection_disconnected'
          RETURNING path_json`,
        at,
        installationId,
      ).toArray();
    return rows.map((row) => JSON.parse(row.path_json) as ExternalPath);
  }

  /** Suspend every binding to a deleted Sidekick's runs. */
  suspendDeletedSidekick(sidekickId: string, at: string): ExternalPath[] {
    return this.sql.exec<{ path_json: string }>(
      `UPDATE external_conversation_bindings
          SET state = 'suspended', suspended_reason = 'sidekick_deleted', claim_key = NULL, updated_at = ?
        WHERE target_kind = 'conversation' AND parent_kind = 'automation' AND parent_id = ?
          AND (state = 'pending' OR ${REPLACEABLE_BY_LASTING_SUSPENSION})
        RETURNING path_json`,
      at,
      sidekickId,
    ).toArray().map((row) => JSON.parse(row.path_json) as ExternalPath);
  }

  /**
   * Move a room's path and every path beneath it to the room's new identifier,
   * atomically and keeping every target and state. If any destination key is
   * already bound, nothing moves: two sources are never merged.
   */
  move(installationId: string, from: ExternalPath, to: ExternalPath, at: string): { outcome: "moved"; count: number } | { outcome: "conflict" } {
    return this.storage.transactionSync(() => {
      const fromKey = externalPathKey(from);
      const toKey = externalPathKey(to);
      const range = descendantRange(from);
      const rows = this.sql.exec<{ path_json: string }>(
        `SELECT path_json FROM external_conversation_bindings
          WHERE installation_id = ? AND (path_json = ? OR (path_json >= ? AND path_json < ?))`,
        installationId,
        fromKey,
        range.lower,
        range.upper,
      ).toArray();
      const rename = (key: string) => `${toKey.slice(0, -1)}${key.slice(fromKey.length - 1)}`;
      for (const row of rows) {
        const taken = this.sql.exec<{ path_json: string }>(
          `SELECT path_json FROM external_conversation_bindings WHERE installation_id = ? AND path_json = ?`,
          installationId,
          rename(row.path_json),
        ).toArray().length > 0;
        if (taken) return { outcome: "conflict" as const };
      }
      for (const row of rows) {
        this.sql.exec(
          `UPDATE external_conversation_bindings SET path_json = ?, updated_at = ?
            WHERE installation_id = ? AND path_json = ?`,
          rename(row.path_json),
          at,
          installationId,
          row.path_json,
        );
      }
      return { outcome: "moved" as const, count: rows.length };
    });
  }
}
