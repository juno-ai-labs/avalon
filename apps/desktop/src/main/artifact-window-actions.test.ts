import { describe, expect, it } from 'vitest';
import { artifactWindowActionRequest } from './artifact-window-actions';
import type { DesktopArtifactWindowRequest } from '../common/desktop';

const preview: DesktopArtifactWindowRequest = {
  kind: 'site', resourceId: '00000000-0000-4000-8000-000000000001', version: 2,
  artifactId: 'site', url: 'https://site.example', title: 'Plan',
  annotationScope: '00000000-0000-4000-8000-000000000002:0',
};

describe('detached artifact commands', () => {
  it('derives mutation targets from the window record', () => {
    expect(artifactWindowActionRequest(preview, { type: 'rename', title: '  New plan  ' })).toEqual({
      path: '/conversations/00000000-0000-4000-8000-000000000002/resources/00000000-0000-4000-8000-000000000001',
      method: 'PATCH', body: { title: 'New plan' },
    });
    expect(artifactWindowActionRequest(preview, { type: 'pin', pinned: true })).toEqual({
      path: '/navigation/artifact-pins/00000000-0000-4000-8000-000000000001', method: 'PUT',
      body: { threadId: '00000000-0000-4000-8000-000000000002' },
    });
  });
  it('refuses caller-selected resources and mutations outside Main', () => {
    expect(() => artifactWindowActionRequest(preview, { type: 'archive', resourceId: 'other' })).toThrow();
    expect(() => artifactWindowActionRequest({ ...preview, annotationScope: '00000000-0000-4000-8000-000000000002:private' }, { type: 'archive' })).toThrow('editable thread context');
    expect(() => artifactWindowActionRequest({ ...preview, annotationScope: undefined }, { type: 'pin', pinned: false })).toThrow('editable thread context');
  });
  it('encodes table names and selects the requested historical representation', () => {
    expect(artifactWindowActionRequest(preview, { type: 'table', table: '../users' })).toEqual({
      path: '/resources/00000000-0000-4000-8000-000000000001/artifact/data/..%2Fusers', method: 'GET',
    });
    expect(artifactWindowActionRequest(preview, { type: 'content', version: 1, original: true })).toEqual({
      path: '/resources/00000000-0000-4000-8000-000000000001/versions/1/content', method: 'GET', binary: true,
    });
  });
});
