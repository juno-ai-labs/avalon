import { asSubstreamId, asWorkspaceId } from '@rally/contracts';
import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import { workspaceDOName } from '../src/durable-objects/names';
import { AuthorizationStorage } from '../src/durable-objects/authorization-storage';
import { prepareResourceSearch } from '../src/durable-objects/resource-search-projection';

// A resource's search rows carry who may read it (docs/PRDs/2026-09-26_search-audience-filtering),
// so every input to that audience must rewrite them, and nothing else may.

const workspaceId = asWorkspaceId('00000000-0000-7000-8000-00000000b711');
const resourceId = '00000000-0000-7000-8000-00000000b712';
const otherResourceId = '00000000-0000-7000-8000-00000000b713';
const parentId = '00000000-0000-7000-8000-00000000b714';
const uploaderId = '00000000-0000-7000-8000-00000000b715';
const at = '2026-09-26T00:00:00Z';

function seed(sql: SqlStorage, provider = 'avalon_upload', attachmentStatus = 'attached') {
  sql.exec("INSERT INTO workspace_identity VALUES (1, ?, 'global', 'wnam', 0, 0)", workspaceId);
  for (const id of [resourceId, otherResourceId]) sql.exec(`INSERT INTO resources
    (id, workspace_id, resource_type, provider, title, metadata_json, uploaded_by_user_id, attachment_status, created_at, updated_at)
    VALUES (?, ?, 'file', ?, 'Plan', '{}', ?, ?, ?, ?)`, id, workspaceId, provider, uploaderId, attachmentStatus, at, at);
}
function revision(sql: SqlStorage, id = resourceId) {
  return sql.exec<{ revision: number }>('SELECT revision FROM resource_search_versions WHERE resource_id = ?', id).one().revision;
}
function inventory(revisionNumber: number, resourceIds: string[]) {
  return { workspaceId, parentId, substreamId: asSubstreamId('0'), parentKind: 'workstream' as const, revision: revisionNumber,
    validatedAt: revisionNumber, resourceIds };
}
const workspace = () => env.WORKSPACE_DOS.getByName(workspaceDOName('global', workspaceId));
beforeEach(async () => { await reset(); });

it('rewrites a resource when its uploader, attachment status, email-ness or connection changes', async () => {
  await runInDurableObject(workspace(), (_instance, state) => {
    const sql = state.storage.sql;
    seed(sql, 'avalon_upload', 'draft');
    let expected = revision(sql);
    for (const edit of ["attachment_status = 'attached'", `uploaded_by_user_id = NULL`, "provider = 'resend'",
      "resource_type = 'email'", "connection_id = 'connection-1'"]) {
      sql.exec(`UPDATE resources SET ${edit} WHERE id = ?`, resourceId);
      expect(revision(sql), edit).toBe(++expected);
    }
  });
});

it('rewrites only the resources an inventory attaches or detaches', async () => {
  await runInDurableObject(workspace(), (_instance, state) => {
    const sql = state.storage.sql;
    seed(sql);
    const locations = new AuthorizationStorage(state.storage);
    const before = [revision(sql), revision(sql, otherResourceId)];
    locations.replaceLocations(inventory(1, [resourceId]));
    expect([revision(sql), revision(sql, otherResourceId)]).toEqual([before[0]! + 1, before[1]]);
    // The same inventory delivered again changes no location, so rewrites nothing.
    locations.replaceLocations(inventory(2, [resourceId]));
    expect([revision(sql), revision(sql, otherResourceId)]).toEqual([before[0]! + 1, before[1]]);
    // Moving the attachment rewrites both: one gained a reader set, one lost it.
    locations.replaceLocations(inventory(3, [otherResourceId]));
    expect([revision(sql), revision(sql, otherResourceId)]).toEqual([before[0]! + 2, before[1]! + 1]);
    // A newer inventory that says the conversation is a Sidekick's changes who the location admits.
    locations.replaceLocations({ ...inventory(4, [otherResourceId]), parentKind: 'automation' });
    expect([revision(sql), revision(sql, otherResourceId)]).toEqual([before[0]! + 2, before[1]! + 2]);
  });
});

it('gives each kind of resource the groups the canonical resource check admits', async () => {
  await runInDurableObject(workspace(), async (_instance, state) => {
    const sql = state.storage.sql;
    seed(sql);
    new AuthorizationStorage(state.storage).replaceLocations(inventory(1, [resourceId]));
    const audience = async () => (await prepareResourceSearch(sql, env, workspaceId, resourceId)).documents
      .find((document) => document.text !== null)?.audience;
    // An attached upload: its uploader, and whoever may read the conversation it is attached in.
    expect(await audience()).toEqual([`user:${uploaderId}`, `conversation:${parentId}/0`]);
    // A draft: its uploader alone, whatever the inventory says.
    sql.exec("UPDATE resources SET attachment_status = 'draft' WHERE id = ?", resourceId);
    expect(await audience()).toEqual([`user:${uploaderId}`]);
    // A provider every member may read: members too, and the location for guests.
    sql.exec("UPDATE resources SET provider = 'web', canonical_url = 'https://example.com/a', attachment_status = 'attached' WHERE id = ?", resourceId);
    expect(await audience()).toEqual([`user:${uploaderId}`, `members:${workspaceId}`, `conversation:${parentId}/0`]);
    // A connector's resource: its connection's readers only.
    sql.exec("UPDATE resources SET connection_id = 'connection-1' WHERE id = ?", resourceId);
    expect(await audience()).toEqual(['connection:connection-1']);
  });
});
