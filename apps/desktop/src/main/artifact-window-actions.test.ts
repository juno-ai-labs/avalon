import { annotationDraftKeyForScope } from '../common/draft-keys';
import { describe, expect, it } from 'vitest';
import { artifactWindowActionRequest, artifactWindowSessionMatches } from './artifact-window-actions';
import type { DesktopArtifactWindowRequest } from '../common/desktop';

const preview: DesktopArtifactWindowRequest = {
  kind: 'site', resourceId: '00000000-0000-4000-8000-000000000001', version: 2,
  artifactId: 'site', url: 'https://site.example', title: 'Plan',
  editable: true, annotationScope: '00000000-0000-4000-8000-000000000002:0',
};

describe('detached artifact commands', () => {
  it('derives mutation targets from the window record', () => {
    expect(artifactWindowActionRequest(preview, { type: 'rename', title: '  New plan  ' })).toMatchObject({
      path: '/conversations/00000000-0000-4000-8000-000000000002/resources/00000000-0000-4000-8000-000000000001',
      method: 'PATCH', body: { title: 'New plan' },
    });
    expect(artifactWindowActionRequest(preview, { type: 'pin', pinned: true })).toMatchObject({
      path: '/navigation/artifact-pins/00000000-0000-4000-8000-000000000001', method: 'PUT',
      body: { threadId: '00000000-0000-4000-8000-000000000002' },
    });
  });
  it('refuses caller-selected resources and mutations outside Main', () => {
    expect(() => artifactWindowActionRequest({ ...preview, editable: false }, { type: 'rename', title: 'Other' })).toThrow('editable thread context');
    expect(() => artifactWindowActionRequest(preview, { type: 'archive', resourceId: 'other' })).toThrow();
    expect(() => artifactWindowActionRequest({ ...preview, annotationScope: '00000000-0000-4000-8000-000000000002:private' }, { type: 'archive' })).toThrow('editable thread context');
    expect(() => artifactWindowActionRequest({ ...preview, annotationScope: undefined }, { type: 'pin', pinned: false })).toThrow('editable thread context');
  });
  it('confines historical page previews to the registered artifact', () => {
    expect(artifactWindowActionRequest(preview,{type:'site-preview',version:3,pagePath:'/pricing?q=team'})).toMatchObject({path:'/resources/00000000-0000-4000-8000-000000000001/versions/3/site-preview?path=%2Fpricing%3Fq%3Dteam',method:'GET',binary:true});
    expect(()=>artifactWindowActionRequest(preview,{type:'site-preview',version:3,pagePath:'/',resourceId:'other'})).toThrow();
  });
  it('encodes table names and selects the requested historical representation', () => {
    expect(artifactWindowActionRequest(preview, { type: 'table', table: '../users' })).toMatchObject({
      path: '/resources/00000000-0000-4000-8000-000000000001/artifact/data/..%2Fusers', method: 'GET',
    });
    expect(artifactWindowActionRequest(preview, { type: 'content', version: 1, original: true })).toMatchObject({
      path: '/resources/00000000-0000-4000-8000-000000000001/versions/1/content', method: 'GET', binary: true,
    });
  });
});

it('rejects another region even with identical user and Organization IDs', () => {
  const opening = { userId: 'person', workspaceId: 'org', region: 'global' };
  expect(artifactWindowSessionMatches(opening, { userId: 'person', workspaceId: 'org', region: 'global' })).toBe(true);
  expect(artifactWindowSessionMatches(opening, { userId: 'person', workspaceId: 'org', region: 'enterprise' })).toBe(false);
  expect(artifactWindowSessionMatches({ userId: 'person', workspaceId: 'org' }, { userId: 'person', workspaceId: 'org', region: 'global' })).toBe(false);
});

it('derives detached cache keys with the same workspace and breakout identity as composers',()=>{
  expect(annotationDraftKeyForScope('global','org','thread:0')).toBe('workspace:global:org:workstream:thread');
  expect(annotationDraftKeyForScope('enterprise','org','thread:private')).toBe('workspace:enterprise:org:workstream:thread:substream:private');
  expect(annotationDraftKeyForScope('global','org','channel:channel-id')).toBe('workspace:global:org:new-workstream:space:channel-id');
});
