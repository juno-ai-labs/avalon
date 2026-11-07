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
    expect(() => artifactWindowActionRequest({ ...preview, editable: false }, { type: 'rename', title: 'Other' })).toThrow('cannot be edited here');
    expect(() => artifactWindowActionRequest(preview, { type: 'archive', resourceId: 'other' })).toThrow();
    expect(() => artifactWindowActionRequest({ ...preview, annotationScope: '00000000-0000-4000-8000-000000000002:private' }, { type: 'archive' })).toThrow('cannot be edited here');
    expect(() => artifactWindowActionRequest({ ...preview, annotationScope: undefined }, { type: 'pin', pinned: false })).toThrow('cannot be edited here');
  });
  it("renames and deletes a Canvas artifact through the Canvas's conversation, names its Canvas for a link, and refuses pin with a reason", () => {
    const canvas = { ...preview, annotationScope: 'canvas:00000000-0000-4000-8000-0000000000c1' };
    expect(artifactWindowActionRequest(canvas, { type: 'rename', title: 'Q1 plan' })).toMatchObject({
      path: '/conversations/00000000-0000-4000-8000-0000000000c1/resources/00000000-0000-4000-8000-000000000001',
      method: 'PATCH', body: { title: 'Q1 plan' },
    });
    expect(artifactWindowActionRequest(canvas, { type: 'archive' })).toMatchObject({
      path: '/conversations/00000000-0000-4000-8000-0000000000c1/resources/00000000-0000-4000-8000-000000000001', method: 'DELETE',
    });
    expect(() => artifactWindowActionRequest(canvas, { type: 'pin', pinned: true })).toThrow('A Canvas artifact cannot be pinned from its own window; use the Canvas');
    expect(artifactWindowActionRequest({ ...canvas, editable: false }, { type: 'link' })).toEqual({
      canvasId: '00000000-0000-4000-8000-0000000000c1', action: { type: 'link' },
    });
    expect(() => artifactWindowActionRequest(preview, { type: 'link' })).toThrow('This artifact has no Canvas to link to');
    expect(() => artifactWindowActionRequest({ ...canvas, annotationScope: 'canvas:not-an-id' }, { type: 'archive' })).toThrow('cannot be edited here');
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
  expect(annotationDraftKeyForScope('global','org','canvas:canvas-id')).toBe('workspace:global:org:canvas:canvas-id');
});
