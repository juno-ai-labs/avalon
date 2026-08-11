import type { WorkstreamWorkflowInput } from "@avalon/contracts";
import type { HarnessTool } from "@avalon/agent-harness";
import { z } from "zod";
import type { Env } from "../env";

/**
 * The Avalon workspace directory the agent reads: who this run is acting for,
 * and who else it may name. A run knows its work stream and its authority, but
 * nothing about the people behind either, so every identity it wrote — a
 * sign-off, an address, a `person:` mention target — was previously either
 * absent or guessed.
 *
 * These are Avalon accounts, not a connector's contact list. A person who has
 * never signed in to this workspace is deliberately unfindable here.
 */

const MAX_SEARCH_LIMIT = 50;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 50;

const CurrentUserInputSchema = z.object({}).strict();

const SearchUsersInputSchema = z.object({
  query: z.string().trim().min(1).max(200),
  limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).optional(),
}).strict();

const ListUsersInputSchema = z.object({
  limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional(),
  cursor: z.string().min(1).max(500).optional(),
}).strict();

interface MemberRow {
  id: string;
  email: string;
  name: string;
  timezone: string;
  role: string;
  status: string;
  joined_at: string | null;
}

interface WorkspacePerson {
  userId: string;
  name: string;
  email: string;
  timezone: string;
  role: string;
  status: string;
  joinedAt: string | null;
  isCurrentUser: boolean;
}

/**
 * `person:<user-id>` mention targets, sign-offs, and "who should I ask" answers
 * all key off the same identifier, so every person a tool returns carries it
 * under one name in one shape.
 */
function toWorkspacePerson(row: MemberRow, principalUserId: string | null): WorkspacePerson {
  return {
    userId: String(row.id),
    name: String(row.name),
    email: String(row.email),
    timezone: String(row.timezone),
    role: String(row.role),
    status: String(row.status),
    joinedAt: row.joined_at == null ? null : String(row.joined_at),
    isCurrentUser: principalUserId !== null && String(row.id) === principalUserId,
  };
}

/**
 * A suspended member is not a person the agent may mention, address, or count:
 * their account no longer authorizes anything in this workspace.
 */
const ACTIVE_MEMBER_PREDICATE = "m.status != 'suspended'";

/** `%` and `_` inside a fragment are literal characters, not model-supplied wildcards. */
function escapeLikeFragment(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}

function encodeCursor(offset: number): string {
  return btoa(JSON.stringify({ offset }))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const normalized = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const parsed = JSON.parse(
      atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")),
    ) as { offset?: unknown };
    if (!Number.isInteger(parsed.offset) || Number(parsed.offset) < 0) throw new Error("invalid");
    return Number(parsed.offset);
  } catch {
    throw new Error(
      "people_cursor_invalid: pass back the exact nextCursor value a previous people_list_users result returned, or omit cursor to start from the first page",
    );
  }
}

export function createPeopleTools(env: Env, input: WorkstreamWorkflowInput): HarnessTool[] {
  const principalUserId = input.executionPrincipal.type === "user"
    ? input.executionPrincipal.userId
    : null;
  return [
    {
      definition: {
        name: "current_user",
        description:
          "Return who this run is acting for: their Avalon user ID, name, email, timezone, workspace role, and current activity totals, plus this workspace's name, region, and timezone. Use the returned userId as the person: mention target for that person, and their timezone when a time belongs to their day. A workspace-authorized run has no current user and says so instead of naming one.",
        capability: "people.read",
        mode: "read",
        idempotency: "safe",
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
      },
      execute: async (raw) => {
        CurrentUserInputSchema.parse(raw ?? {});
        return await readCurrentUser(env, input, principalUserId);
      },
    },
    {
      definition: {
        name: "search_users",
        description:
          "Find people in this Avalon workspace whose name or email contains the query. Use this to resolve a person named in the request into the exact userId you then mention or address; a query that matches nobody returns no matches rather than a guess. Covers Avalon accounts in this workspace only, not a connector's address book.",
        capability: "people.read",
        mode: "read",
        idempotency: "safe",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: {
              type: "string",
              minLength: 1,
              maxLength: 200,
              description: "Name or email fragment, for example \"dana\" or \"@example.com\".",
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: MAX_SEARCH_LIMIT,
              description: `Maximum matches to return; defaults to ${DEFAULT_SEARCH_LIMIT}.`,
            },
          },
          required: ["query"],
        },
      },
      execute: async (raw) => {
        const args = SearchUsersInputSchema.parse(raw ?? {});
        return await searchUsers(env, input, principalUserId, args);
      },
    },
    {
      definition: {
        name: "list_users",
        description:
          "List everyone in this Avalon workspace by name, with each person's userId, email, timezone, role, and status. Use this to see who is on the team; use people_search_users when you already know part of a name or email. Pass back the returned nextCursor for the next page.",
        capability: "people.read",
        mode: "read",
        idempotency: "safe",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: {
              type: "integer",
              minimum: 1,
              maximum: MAX_LIST_LIMIT,
              description: `Maximum people to return in this page; defaults to ${DEFAULT_LIST_LIMIT}.`,
            },
            cursor: {
              type: "string",
              description: "The nextCursor value from a previous people_list_users result.",
            },
          },
        },
      },
      execute: async (raw) => {
        const args = ListUsersInputSchema.parse(raw ?? {});
        return await listUsers(env, input, principalUserId, args);
      },
    },
  ];
}

async function readCurrentUser(
  env: Env,
  input: WorkstreamWorkflowInput,
  principalUserId: string | null,
) {
  const workspace = await env.DB.prepare(
    `SELECT id, name, slug, region, timezone FROM workspaces WHERE id = ?`,
  ).bind(input.workspaceId).first<Record<string, unknown>>();
  if (!workspace) throw new Error("This workspace is no longer available");
  const workspaceOutput = {
    workspaceId: String(workspace.id),
    name: String(workspace.name),
    slug: String(workspace.slug),
    region: String(workspace.region),
    timezone: String(workspace.timezone),
  };

  // A workspace-authorized run acts for the organization, not for a person.
  // Naming the installer or the requester here would hand it an identity it was
  // deliberately not granted, so it gets an explicit absence instead.
  if (!principalUserId) {
    return {
      output: {
        executionAuthority: "workspace" as const,
        user: null,
        membership: null,
        activity: null,
        workspace: workspaceOutput,
        note: "This run is authorized by the workspace itself and has no current user. Do not attribute it to a member; use people_list_users or people_search_users to name a person, and request input when the task needs one person's authority.",
      },
      summary: "Read the workspace execution authority; this run has no current user",
    };
  }

  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.timezone, u.created_at,
            m.role, m.status, m.joined_at,
            (SELECT COUNT(*) FROM workstreams ws
              WHERE ws.workspace_id = m.workspace_id AND ws.created_by_user_id = u.id
                AND ws.archived_at IS NULL) AS open_workstreams,
            (SELECT COUNT(*) FROM workstreams ws
              WHERE ws.workspace_id = m.workspace_id AND ws.created_by_user_id = u.id
                AND ws.archived_at IS NULL AND ws.harness_status = 'needs_input') AS workstreams_needing_input,
            (SELECT MAX(ws.last_activity_at) FROM workstreams ws
              WHERE ws.workspace_id = m.workspace_id AND ws.created_by_user_id = u.id
                AND ws.archived_at IS NULL) AS last_workstream_activity_at,
            (SELECT COUNT(*) FROM automation_subscriptions asub
              WHERE asub.workspace_id = m.workspace_id AND asub.owner_user_id = u.id
                AND asub.scope = 'personal' AND asub.status = 'active') AS active_personal_automations,
            (SELECT COUNT(*) FROM connector_connections cc
              WHERE cc.workspace_id = m.workspace_id AND cc.owner_user_id = u.id
                AND cc.scope = 'personal' AND cc.status = 'healthy') AS healthy_personal_connections
       FROM users u
       JOIN workspace_members m ON m.user_id = u.id
      WHERE u.id = ? AND m.workspace_id = ?`,
  ).bind(principalUserId, input.workspaceId).first<Record<string, unknown>>();
  // Membership is revalidated around every tool call, so a missing row here is
  // a membership that ended mid-run rather than a lookup the model can retry.
  if (!row) throw new Error("The current user is no longer a member of this workspace");

  return {
    output: {
      executionAuthority: "user" as const,
      user: {
        userId: String(row.id),
        name: String(row.name),
        email: String(row.email),
        timezone: String(row.timezone),
        createdAt: String(row.created_at),
      },
      membership: {
        role: String(row.role),
        status: String(row.status),
        joinedAt: row.joined_at == null ? null : String(row.joined_at),
      },
      activity: {
        openWorkstreams: Number(row.open_workstreams ?? 0),
        workstreamsNeedingInput: Number(row.workstreams_needing_input ?? 0),
        lastWorkstreamActivityAt: row.last_workstream_activity_at == null
          ? null
          : String(row.last_workstream_activity_at),
        activePersonalAutomations: Number(row.active_personal_automations ?? 0),
        healthyPersonalConnections: Number(row.healthy_personal_connections ?? 0),
      },
      workspace: workspaceOutput,
    },
    summary: `Read the current user ${String(row.name)} and their activity totals`,
  };
}

async function searchUsers(
  env: Env,
  input: WorkstreamWorkflowInput,
  principalUserId: string | null,
  args: z.infer<typeof SearchUsersInputSchema>,
) {
  const limit = args.limit ?? DEFAULT_SEARCH_LIMIT;
  const pattern = `%${escapeLikeFragment(args.query.toLowerCase())}%`;
  const [matches, total] = await Promise.all([
    env.DB.prepare(
      `SELECT u.id, u.email, u.name, u.timezone, m.role, m.status, m.joined_at
         FROM workspace_members m JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = ? AND ${ACTIVE_MEMBER_PREDICATE}
          AND (LOWER(u.name) LIKE ? ESCAPE '\\' OR LOWER(u.email) LIKE ? ESCAPE '\\')
        ORDER BY (LOWER(u.email) = ?) DESC, u.name COLLATE NOCASE
        LIMIT ?`,
    ).bind(
      input.workspaceId,
      pattern,
      pattern,
      args.query.toLowerCase(),
      limit,
    ).all<MemberRow>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS total
         FROM workspace_members m JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = ? AND ${ACTIVE_MEMBER_PREDICATE}
          AND (LOWER(u.name) LIKE ? ESCAPE '\\' OR LOWER(u.email) LIKE ? ESCAPE '\\')`,
    ).bind(input.workspaceId, pattern, pattern).first<{ total: number }>(),
  ]);
  const results = (matches.results ?? []).map((row) => toWorkspacePerson(row, principalUserId));
  const totalMatches = Number(total?.total ?? results.length);
  return {
    output: {
      query: args.query,
      matches: results,
      totalMatches,
      truncated: totalMatches > results.length,
    },
    summary: results.length === 0
      ? `No workspace member matches "${args.query}"`
      : `Found ${results.length} of ${totalMatches} workspace member${totalMatches === 1 ? "" : "s"} matching "${args.query}"`,
  };
}

async function listUsers(
  env: Env,
  input: WorkstreamWorkflowInput,
  principalUserId: string | null,
  args: z.infer<typeof ListUsersInputSchema>,
) {
  const limit = args.limit ?? DEFAULT_LIST_LIMIT;
  const offset = decodeCursor(args.cursor);
  const [page, total] = await Promise.all([
    env.DB.prepare(
      `SELECT u.id, u.email, u.name, u.timezone, m.role, m.status, m.joined_at
         FROM workspace_members m JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = ? AND ${ACTIVE_MEMBER_PREDICATE}
        ORDER BY u.name COLLATE NOCASE, u.id
        LIMIT ? OFFSET ?`,
    ).bind(input.workspaceId, limit + 1, offset).all<MemberRow>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS total
         FROM workspace_members m JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = ? AND ${ACTIVE_MEMBER_PREDICATE}`,
    ).bind(input.workspaceId).first<{ total: number }>(),
  ]);
  const rows = page.results ?? [];
  const hasMore = rows.length > limit;
  const users = rows.slice(0, limit).map((row) => toWorkspacePerson(row, principalUserId));
  return {
    output: {
      users,
      totalUsers: Number(total?.total ?? users.length),
      nextCursor: hasMore ? encodeCursor(offset + limit) : null,
    },
    summary: `Listed ${users.length} of ${Number(total?.total ?? users.length)} workspace member${Number(total?.total ?? users.length) === 1 ? "" : "s"}`,
  };
}
