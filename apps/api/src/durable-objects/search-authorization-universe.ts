import { asSubstreamId, asUserId, asWorkspaceId } from '@rally/contracts';
import type { AuthorizationResource, AuthorizationSubject } from '../services/authorization-policy';

/**
 * The subjects and resources a search projection target reaches, read from
 * the WorkspaceDO's own directories. This is discovery for registration,
 * never a grant: every pair still gets its canonical decision through
 * `project()`. It over-approximates on purpose (a writer Sidekick's whole
 * audience for a Canvas it writes, every administrator for every Canvas),
 * because a registered denial costs one key and a missing grant costs a
 * search result.
 */
export type SearchAuthorizationTarget =
  | { kind: 'parent'; id: string } | { kind: 'resource'; id: string }
  | { kind: 'connection'; id: string } | { kind: 'member'; id: string };

export interface SearchAuthorizationPair { subject: AuthorizationSubject; resources: AuthorizationResource[] }

interface CanvasRow extends Record<string, SqlStorageValue> {
  canvas_id: string; visibility: string; created_by_user_id: string; writer_sidekick_id: string | null;
}
interface AutomationRow extends Record<string, SqlStorageValue> {
  automation_id: string; scope: string; author_user_id: string; run_as_user_id: string | null; lifecycle: string;
}

/**
 * `members` is every active member; `administrators` the owners and
 * administrators among them, who open every Canvas.
 */
export function enumerateSearchAuthorizationUniverse(sql: SqlStorage, workspaceId: string, members: readonly string[],
  administrators: readonly string[], target: SearchAuthorizationTarget): SearchAuthorizationPair[] {
  const workspace = asWorkspaceId(workspaceId);
  const active = new Set(members);
  const subject = (userId: string): AuthorizationSubject => ({ workspaceId: workspace, userId: asUserId(userId), delegation: null });
  const conversation = (parentId: string, substreamId: string): AuthorizationResource =>
    ({ kind: 'conversation', workspaceId: workspace, parentId, substreamId: asSubstreamId(substreamId) });
  const resource = (resourceId: string): AuthorizationResource => ({ kind: 'resource', workspaceId: workspace, resourceId });
  const connection = (connectionId: string): AuthorizationResource => ({ kind: 'connection', workspaceId: workspace, connectionId });

  const canvas = (parentId: string) => sql.exec<CanvasRow>(
    'SELECT canvas_id, visibility, created_by_user_id, writer_sidekick_id FROM canvas_directory WHERE canvas_id = ?',
    parentId).toArray()[0];
  const automation = (parentId: string) => sql.exec<AutomationRow>(
    'SELECT automation_id, scope, author_user_id, run_as_user_id, lifecycle FROM automation_directory WHERE automation_id = ?', parentId).toArray()[0];
  const canvasParticipants = (canvasId: string) => sql.exec<{ user_id: string }>(
    'SELECT user_id FROM canvas_participants WHERE canvas_id = ?', canvasId).toArray().map((row) => row.user_id);
  /** Who could read a parent, before its canonical owner decides. Unknown parents reach nobody. */
  const parentSubjects = (parentId: string): string[] => {
    const board = canvas(parentId);
    if (board) {
      if (board.visibility === 'workspace') return [...active];
      return [...new Set([board.created_by_user_id, ...canvasParticipants(parentId), ...administrators,
        ...(board.writer_sidekick_id ? parentSubjects(board.writer_sidekick_id) : [])])].filter((userId) => active.has(userId));
    }
    const auto = automation(parentId);
    if (!auto || auto.lifecycle === 'deleted') return [];
    if (auto.scope === 'workspace') return [...active];
    // Its author, who it runs as, and who it is shared with: `sidekickAdmits`.
    const shared = sql.exec<{ user_id: string }>('SELECT user_id FROM sidekick_audience WHERE sidekick_id = ?', parentId)
      .toArray().map((row) => row.user_id);
    return [...new Set([auto.author_user_id, ...(auto.run_as_user_id ? [auto.run_as_user_id] : []), ...shared])].filter((userId) => active.has(userId));
  };
  /** Every conversation the WorkspaceDO knows under a parent: the main feed and the delivered or registered children. */
  const parentConversations = (parentId: string): AuthorizationResource[] => {
    const children = sql.exec<{ substream_id: string }>(`SELECT substream_id FROM authorization_inventories WHERE parent_id = ?
      UNION SELECT substream_id FROM authorization_backfill_children WHERE parent_id = ?`, parentId, parentId).toArray()
      .map((row) => row.substream_id);
    const substreams = new Set(canvas(parentId) ? ['0', ...children] : children);
    return [...substreams].map((substreamId) => conversation(parentId, substreamId));
  };
  /** Attachment-admitted resources located under a parent; connector resources are admitted by their connection instead. */
  const parentResources = (parentId: string): AuthorizationResource[] => sql.exec<{ resource_id: string }>(
    `SELECT DISTINCT l.resource_id FROM authorization_locations l JOIN resources r ON r.id = l.resource_id
     WHERE l.parent_id = ? AND r.connection_id IS NULL`, parentId).toArray().map((row) => resource(row.resource_id));
  const pairs = (subjects: readonly string[], resources: AuthorizationResource[]): SearchAuthorizationPair[] =>
    resources.length ? [...new Set(subjects)].map((userId) => ({ subject: subject(userId), resources })) : [];

  switch (target.kind) {
    case 'parent':
      return pairs(parentSubjects(target.id), [...parentConversations(target.id), ...parentResources(target.id)]);
    case 'connection':
      return sql.exec('SELECT 1 FROM connector_connections WHERE id = ?', target.id).toArray().length
        ? pairs([...active], [connection(target.id)]) : [];
    case 'resource': {
      const row = sql.exec<{ provider: string; connection_id: string | null; uploaded_by_user_id: string | null }>(
        'SELECT provider, connection_id, uploaded_by_user_id FROM resources WHERE id = ?', target.id).toArray()[0];
      if (!row || row.connection_id) return [];
      const located = sql.exec<{ parent_id: string }>('SELECT DISTINCT parent_id FROM authorization_locations WHERE resource_id = ?', target.id)
        .toArray().flatMap((location) => parentSubjects(location.parent_id));
      const owner = row.uploaded_by_user_id && active.has(row.uploaded_by_user_id) ? [row.uploaded_by_user_id] : [];
      return row.provider === 'avalon_note' ? [] : pairs([...located, ...owner], [resource(target.id)]);
    }
    case 'member': {
      if (!active.has(target.id)) return [];
      const resources: AuthorizationResource[] = [];
      for (const board of sql.exec<{ canvas_id: string }>('SELECT canvas_id FROM canvas_directory').toArray()) {
        if (!parentSubjects(board.canvas_id).includes(target.id)) continue;
        resources.push(...parentConversations(board.canvas_id), ...parentResources(board.canvas_id));
      }
      for (const auto of sql.exec<AutomationRow>("SELECT automation_id, scope, author_user_id, run_as_user_id, lifecycle FROM automation_directory WHERE lifecycle <> 'deleted'").toArray()) {
        if (!parentSubjects(auto.automation_id).includes(target.id)) continue;
        resources.push(...parentConversations(auto.automation_id), ...parentResources(auto.automation_id));
      }
      for (const row of sql.exec<{ id: string }>('SELECT id FROM connector_connections').toArray()) resources.push(connection(row.id));
      for (const row of sql.exec<{ id: string }>(
        "SELECT id FROM resources WHERE connection_id IS NULL AND provider != 'avalon_note' AND uploaded_by_user_id = ?", target.id).toArray()) {
        resources.push(resource(row.id));
      }
      const unique = new Map(resources.map((item) => [JSON.stringify(item), item]));
      return pairs([target.id], [...unique.values()]);
    }
  }
}
