import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { AgentIdSchema, type AgentId } from "@rally/contracts";

/** Workspace-local communication scope. Ownership is separate from membership. */

/** An agent id is `<parentKind>/<parentId>/<substreamId>`; a Thread's or Space's names a retired parent. */
function retiredAgentKind(value: string): string | null {
  const kind = value.split("/", 1)[0];
  return kind === "workstream" || kind === "space" ? kind : null;
}

/**
 * A stored agent id that must be live. A Thread-era row (an agent of a
 * retired Thread or Space) is refused by name, as a domain result, rather than
 * as a schema failure.
 */
function storedAgentId(value: string): AgentId {
  const retired = retiredAgentKind(value);
  if (retired) throw new AgentTeamError(`conversation_parent_kind_retired:${retired}`);
  return AgentIdSchema.parse(value);
}

/** A listed member: a Thread-era row is left out, since its agent can no longer be reached. */
function liveAgentId(value: string): AgentId[] {
  return retiredAgentKind(value) ? [] : [AgentIdSchema.parse(value)];
}

export const AGENT_TEAM_SCHEMA = [
  `CREATE TABLE agent_teams (
    team_id TEXT PRIMARY KEY,
    origin_agent_id TEXT NOT NULL UNIQUE
  ) STRICT`,
  `CREATE TABLE agent_team_members (
    team_id TEXT NOT NULL REFERENCES agent_teams(team_id),
    agent_id TEXT NOT NULL,
    PRIMARY KEY (team_id, agent_id)
  ) STRICT`,
  `CREATE INDEX agent_team_members_agent_idx ON agent_team_members(agent_id, team_id)`,
  `CREATE TABLE agent_delegations (
    agent_id TEXT PRIMARY KEY,
    owner_agent_id TEXT NOT NULL,
    team_id TEXT NOT NULL REFERENCES agent_teams(team_id),
    CHECK (agent_id <> owner_agent_id)
  ) STRICT`,
  `CREATE INDEX agent_delegations_owner_idx ON agent_delegations(owner_agent_id, agent_id)`,
  `CREATE TABLE agent_message_routes (
    message_id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES agent_teams(team_id),
    sender_agent_id TEXT NOT NULL,
    recipient_agent_id TEXT NOT NULL
  ) STRICT`,
] as const;

export interface AgentMessageRoute {
  messageId: string;
  teamId: string;
  senderAgentId: AgentId;
  recipientAgentId: AgentId;
}

type AgentTeamErrorCode = "agent_ownership_conflict" | "agent_ownership_cycle" | "agent_not_teammate"
  | "agent_message_identity_conflict" | "agent_message_not_received"
  | `conversation_parent_kind_retired:${string}`;
class AgentTeamError extends Error {
  constructor(readonly code: AgentTeamErrorCode) { super(code); }
}
export type AgentTeamResult<T> = { ok: true; value: T } | { ok: false; code: AgentTeamErrorCode };

/** Expected domain refusals are data across RPC, not transport exceptions. */
export function agentTeamResult<T>(operation: () => T): AgentTeamResult<T> {
  try { return { ok: true, value: operation() }; }
  catch (error) {
    if (error instanceof AgentTeamError) return { ok: false, code: error.code };
    throw error;
  }
}

export class AgentTeamStorage {
  constructor(private readonly storage: DurableObjectStorage) {}

  /** The originating conversation already supplies a stable, workspace-local identity. */
  ensureTeam(origin: AgentId): string {
    return this.storage.transactionSync(() => {
      this.storage.sql.exec("INSERT OR IGNORE INTO agent_teams VALUES (?, ?)", origin, origin);
      this.addMember(origin, origin);
      return origin;
    });
  }

  /** Host callers authorize a Sidekick contact before invoking this operation. */
  addMember(teamId: string, agentId: AgentId): void {
    this.storage.sql.exec("INSERT OR IGNORE INTO agent_team_members VALUES (?, ?)", teamId, agentId);
  }

  recordDelegation(teamId: string, owner: AgentId, child: AgentId): void {
    this.storage.transactionSync(() => {
      this.assertMember(teamId, owner);
      const existing = this.storage.sql.exec<{ owner_agent_id: string; team_id: string }>(
        "SELECT owner_agent_id, team_id FROM agent_delegations WHERE agent_id = ?", child,
      ).toArray()[0];
      if (existing) {
        if (existing.owner_agent_id !== owner || existing.team_id !== teamId) {
          throw new AgentTeamError("agent_ownership_conflict");
        }
        return;
      }
      if (child === owner || this.ownedDescendants(child).includes(owner)) {
        throw new AgentTeamError("agent_ownership_cycle");
      }
      this.storage.sql.exec("INSERT INTO agent_delegations VALUES (?, ?, ?)", child, owner, teamId);
      this.addMember(teamId, child);
    });
  }

  members(teamId: string, requester: AgentId): AgentId[] {
    this.assertMember(teamId, requester);
    return this.storage.sql.exec<{ agent_id: string }>(
      "SELECT agent_id FROM agent_team_members WHERE team_id = ? ORDER BY agent_id", teamId,
    ).toArray().flatMap((row) => liveAgentId(row.agent_id));
  }

  /** A shared member never joins the rosters of the teams it belongs to. */
  sharedTeam(sender: AgentId, recipient: AgentId, preferredTeamId?: string): string {
    if (preferredTeamId !== undefined && this.isMember(preferredTeamId, sender)
      && this.isMember(preferredTeamId, recipient)) return preferredTeamId;
    const row = this.storage.sql.exec<{ team_id: string }>(
      `SELECT source.team_id FROM agent_team_members source
        JOIN agent_team_members target ON target.team_id = source.team_id
        WHERE source.agent_id = ? AND target.agent_id = ? ORDER BY source.team_id LIMIT 1`,
      sender, recipient,
    ).toArray()[0];
    if (!row) throw new AgentTeamError("agent_not_teammate");
    return row.team_id;
  }

  recordMessage(route: AgentMessageRoute): AgentMessageRoute {
    return this.storage.transactionSync(() => {
      this.assertMember(route.teamId, route.senderAgentId);
      this.assertMember(route.teamId, route.recipientAgentId);
      const existing = this.message(route.messageId);
      if (existing) {
        if (existing.teamId !== route.teamId || existing.senderAgentId !== route.senderAgentId
          || existing.recipientAgentId !== route.recipientAgentId) throw new AgentTeamError("agent_message_identity_conflict");
        return existing;
      }
      this.storage.sql.exec("INSERT INTO agent_message_routes VALUES (?, ?, ?, ?)",
        route.messageId, route.teamId, route.senderAgentId, route.recipientAgentId);
      return route;
    });
  }

  replyRoute(receivedMessageId: string, sender: AgentId): Omit<AgentMessageRoute, "messageId"> {
    const received = this.message(receivedMessageId);
    if (!received || received.recipientAgentId !== sender) throw new AgentTeamError("agent_message_not_received");
    this.assertMember(received.teamId, sender);
    this.assertMember(received.teamId, received.senderAgentId);
    return { teamId: received.teamId, senderAgentId: sender, recipientAgentId: received.senderAgentId };
  }

  owner(agent: AgentId): AgentId | null {
    const row = this.storage.sql.exec<{ owner_agent_id: string }>(
      "SELECT owner_agent_id FROM agent_delegations WHERE agent_id = ?", agent,
    ).toArray()[0];
    return row ? storedAgentId(row.owner_agent_id) : null;
  }

  ownedDescendants(owner: AgentId): AgentId[] {
    return this.storage.sql.exec<{ agent_id: string }>(
      `WITH RECURSIVE owned(agent_id) AS (
        SELECT agent_id FROM agent_delegations WHERE owner_agent_id = ?
        UNION
        SELECT child.agent_id FROM agent_delegations child JOIN owned ON child.owner_agent_id = owned.agent_id
      ) SELECT agent_id FROM owned ORDER BY agent_id`, owner,
    ).toArray().flatMap((row) => liveAgentId(row.agent_id));
  }

  private message(messageId: string): AgentMessageRoute | null {
    const row = this.storage.sql.exec<{
      team_id: string; sender_agent_id: string; recipient_agent_id: string;
    }>("SELECT team_id, sender_agent_id, recipient_agent_id FROM agent_message_routes WHERE message_id = ?", messageId).toArray()[0];
    return row ? {
      messageId, teamId: row.team_id, senderAgentId: storedAgentId(row.sender_agent_id),
      recipientAgentId: storedAgentId(row.recipient_agent_id),
    } : null;
  }

  private isMember(teamId: string, agentId: AgentId): boolean {
    return this.storage.sql.exec("SELECT 1 FROM agent_team_members WHERE team_id = ? AND agent_id = ?", teamId, agentId).toArray().length > 0;
  }

  private assertMember(teamId: string, agentId: AgentId): void {
    if (!this.isMember(teamId, agentId)) throw new AgentTeamError("agent_not_teammate");
  }
}
