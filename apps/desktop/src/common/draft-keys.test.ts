import { describe, expect, it } from 'vitest';

import { annotationDraftKeyForScope, conversationAnnotationScope, conversationDraftKey } from './draft-keys';

const workspaceId = '00000000-0000-7000-8000-000000000001';
const canvasId = '00000000-0000-7000-8000-0000000000c1';

describe('conversation draft keys', () => {
  it("names a Canvas's Chat in the canvas family", () => {
    expect(conversationDraftKey('global', workspaceId, 'canvas', canvasId))
      .toBe(`workspace:global:${workspaceId}:canvas:${canvasId}`);
  });

  it("keeps a Sidekick's conversation in the work-stream family", () => {
    const sidekickId = canvasId;
    expect(conversationDraftKey('global', workspaceId, 'automation', sidekickId, '3'))
      .toBe(`workspace:global:${workspaceId}:workstream:${sidekickId}:substream:3`);
    expect(conversationDraftKey('global', workspaceId, 'automation', sidekickId))
      .toBe(`workspace:global:${workspaceId}:workstream:${sidekickId}`);
  });

  it("gives a detached artifact window the Canvas Chat's own key back from its scope", () => {
    const scope = conversationAnnotationScope('canvas', canvasId);
    expect(scope).toBe(`canvas:${canvasId}`);
    expect(annotationDraftKeyForScope('global', workspaceId, scope))
      .toBe(`workspace:global:${workspaceId}:canvas:${canvasId}`);
    expect(annotationDraftKeyForScope('global', workspaceId, conversationAnnotationScope('automation', canvasId, '2')))
      .toBe(`workspace:global:${workspaceId}:workstream:${canvasId}:substream:2`);
  });
});
