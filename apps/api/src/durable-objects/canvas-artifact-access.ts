import { ArtifactAccessSnapshotSchema, PublishedArtifactFileSchema, type ArtifactAccessSnapshot } from '@rally/contracts/artifact-access';
import { WorkspaceRelationshipSchema } from '@rally/contracts/scope-grants';
import { canvasReaderAllows, type CanvasAdmissionRow } from './canvas-sidekick-admission';

export const CANVAS_ARTIFACT_ACCESS_ALARM = 'canvas_artifact_access';

// SQL triggers make source mutation and retry intent one synchronous commit,
// including membership delivery, guest grants and Sidekick audience changes.
const clock = "CAST(strftime('%s', 'now') AS INTEGER) * 1000";
const dirty = (where: string) => `INSERT INTO canvas_artifact_access_state(canvas_id, revision)
  SELECT canvas_id, 1 FROM canvas_directory WHERE ${where}
  ON CONFLICT(canvas_id) DO UPDATE SET revision = revision + 1;`;
const trigger = (name: string, event: string, table: string, where: string, when = '') =>
  `CREATE TRIGGER ${name} AFTER ${event} ON ${table} ${when} BEGIN ${dirty(where)} END`;

export const CANVAS_ARTIFACT_ACCESS_STATEMENTS: readonly string[] = [
  `ALTER TABLE canvas_directory ADD COLUMN sharing_revision INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE canvas_directory ADD COLUMN artifact_visibility TEXT NOT NULL DEFAULT 'editors'
    CHECK(artifact_visibility IN ('editors','participants','workspace','public'))`,
  `CREATE TABLE canvas_artifact_users(canvas_id TEXT NOT NULL, user_id TEXT NOT NULL,
    PRIMARY KEY(canvas_id,user_id)) STRICT`,
  `CREATE TABLE canvas_artifact_access_state(canvas_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision > 0)) STRICT`,
  `CREATE TABLE canvas_artifact_access_bootstrap(id INTEGER PRIMARY KEY CHECK(id=1), completed INTEGER NOT NULL DEFAULT 0) STRICT`,
  `INSERT INTO canvas_artifact_access_bootstrap(id) VALUES(1)`,
  ...['INSERT', 'UPDATE'].map((event) => `CREATE TRIGGER canvas_artifact_access_outbox_${event.toLowerCase()}
    AFTER ${event} ON canvas_artifact_access_state BEGIN
    INSERT INTO _internal_durable_alarms(kind,alarm_key,due_at,repeat_every_ms,retry_at,attempt,payload_json,created_at,updated_at)
      VALUES('${CANVAS_ARTIFACT_ACCESS_ALARM}',NEW.canvas_id,${clock},NULL,0,0,NULL,${clock},${clock})
      ON CONFLICT(kind,alarm_key) DO UPDATE SET due_at=MAX(_internal_durable_alarms.due_at+1,excluded.due_at),
        retry_at=0,attempt=0,updated_at=excluded.updated_at;
    END`),
  ...['canvas_participants','canvas_artifact_users'].flatMap(table=>['INSERT','DELETE'].map(event=>
    `CREATE TRIGGER ${table}_sharing_revision_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN
      UPDATE canvas_directory SET sharing_revision=sharing_revision+1 WHERE canvas_id=${event==='DELETE'?'OLD':'NEW'}.canvas_id;
    END`)),
  `CREATE TRIGGER canvas_sharing_visibility_revision AFTER UPDATE OF visibility,artifact_visibility ON canvas_directory
    WHEN OLD.visibility IS NOT NEW.visibility OR OLD.artifact_visibility IS NOT NEW.artifact_visibility BEGIN
      UPDATE canvas_directory SET sharing_revision=sharing_revision+1 WHERE canvas_id=NEW.canvas_id;
    END`,
  trigger('canvas_access_created', 'INSERT', 'canvas_directory', 'canvas_id=NEW.canvas_id'),
  trigger('canvas_access_policy_changed', 'UPDATE OF visibility, artifact_visibility, archived_at, writer_sidekick_id', 'canvas_directory', 'canvas_id=NEW.canvas_id'),
  ...['canvas_participants','canvas_artifact_users','canvas_artifacts'].flatMap((table) => [
    trigger(`${table}_access_added`, 'INSERT', table, 'canvas_id=NEW.canvas_id'),
    trigger(`${table}_access_removed`, 'DELETE', table, 'canvas_id=OLD.canvas_id'),
  ]),
  ...['INSERT','UPDATE','DELETE'].map((event) => trigger(`canvas_access_membership_${event.toLowerCase()}`, event,
    'workspace_member_status', '1=1', event === 'UPDATE' ? 'WHEN OLD.relationship_json IS NOT NEW.relationship_json OR OLD.active IS NOT NEW.active' : '')),
  ...['INSERT','DELETE'].map((event) => trigger(`canvas_access_sidekick_people_${event.toLowerCase()}`, event,
    'sidekick_audience', `writer_sidekick_id=${event === 'DELETE' ? 'OLD' : 'NEW'}.sidekick_id`)),
  trigger('canvas_access_sidekick_changed', 'UPDATE OF scope,author_user_id,run_as_user_id,lifecycle', 'automation_directory', 'writer_sidekick_id=NEW.automation_id'),
  trigger('canvas_access_site_registered', 'INSERT', 'artifact_registry', 'canvas_id=NEW.workstream_id'),
  trigger('canvas_access_resource_published', 'INSERT', 'resources', 'canvas_id=NEW.publication_parent_id', "WHEN NEW.provider='avalon_generated'"),
  trigger('canvas_access_resource_revised', 'UPDATE OF content_ref,updated_at,title', 'resources', 'canvas_id=NEW.publication_parent_id', "WHEN NEW.provider='avalon_generated'"),
  // The first projection of old publications is deliberately restricted to editors.
  dirty('1=1'),
  `INSERT INTO resource_search_versions(resource_id,revision,pending,not_before)
    SELECT id,1,1,0 FROM resources WHERE provider='avalon_generated'
    ON CONFLICT(resource_id) DO UPDATE SET revision=revision+1,pending=1,not_before=0`,
];

type AccessCanvas = CanvasAdmissionRow & Record<string, SqlStorageValue> & { workspace_id: string; artifact_visibility: string };

export function canvasArtifactAccessSnapshot(sql: SqlStorage, canvasId: string): ArtifactAccessSnapshot | null {
  const row = sql.exec<AccessCanvas>('SELECT * FROM canvas_directory WHERE canvas_id=?',canvasId).toArray()[0];
  if (!row) return null;
  const revision = sql.exec<{revision:number}>('SELECT revision FROM canvas_artifact_access_state WHERE canvas_id=?',canvasId).one().revision;
  const selected = new Set(sql.exec<{user_id:string}>('SELECT user_id FROM canvas_artifact_users WHERE canvas_id=?',canvasId).toArray().map(r=>r.user_id));
  const users: ArtifactAccessSnapshot['users'] = [];
  if (row.archived_at === null) for (const item of sql.exec<{relationship_json:string}>('SELECT relationship_json FROM workspace_member_status WHERE active=1 AND relationship_json IS NOT NULL').toArray()) {
    const person = WorkspaceRelationshipSchema.parse(JSON.parse(item.relationship_json));
    if (person.status !== 'active') continue;
    const editor = canvasReaderAllows(row, {userId:person.userId,actorRole:person.accessClass==='member'?(person.role??'member'):null},sql);
    const allowed = editor || ((row.artifact_visibility==='participants' || row.artifact_visibility==='workspace') && selected.has(person.userId)) || row.artifact_visibility==='public' || (row.artifact_visibility==='workspace' && person.accessClass==='member');
    if (allowed) users.push({userId:person.userId,incarnation:person.incarnation,editor});
  }
  users.sort((a,b)=>a.userId.localeCompare(b.userId));
  return ArtifactAccessSnapshotSchema.parse({workspaceId:row.workspace_id,canvasId,revision,
    public:row.archived_at===null && row.artifact_visibility==='public',archived:row.archived_at!==null,users});
}

/** All published outputs, with sites keeping their existing UUID and routing. */
export function canvasArtifactTargets(sql: SqlStorage, canvasId: string) {
  return sql.exec<{artifactId:string;resourceId:string}>(`SELECT COALESCE(registry.artifact_id,resource.id) AS artifactId, resource.id AS resourceId
    FROM resources resource LEFT JOIN artifact_registry registry ON registry.resource_id=resource.id
    WHERE resource.provider='avalon_generated' AND (resource.resource_type<>'generated_site' OR registry.artifact_id IS NOT NULL) AND (resource.publication_parent_id=? OR
      (resource.publication_parent_id IS NULL AND (SELECT COUNT(*) FROM canvas_artifacts WHERE resource_id=resource.id)=1 AND resource.id IN(SELECT resource_id FROM canvas_artifacts WHERE canvas_id=?)))
    ORDER BY resource.id`,canvasId,canvasId).toArray();
}

export function canvasArtifactFile(sql: SqlStorage, resourceId: string) {
  const row=sql.exec<{id:string;title:string;resource_type:string}>('SELECT id,title,resource_type FROM resources WHERE id=?',resourceId).toArray()[0];
  if(!row || row.resource_type==='generated_site') return null;
  const versions=sql.exec<{version:number;contentRef:string;mimeType:string}>(`SELECT version,content_ref AS contentRef,
    COALESCE(mime_type,'application/octet-stream') AS mimeType FROM resource_versions WHERE resource_id=? AND content_ref IS NOT NULL ORDER BY version`,resourceId).toArray();
  return PublishedArtifactFileSchema.parse({resourceId,title:row.title,versions});
}
