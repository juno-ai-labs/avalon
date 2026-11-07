import { describe, expect, it } from 'vitest';
import { conversationSearchAudience, resourceSearchAudience, searchAudienceGroupId } from '../src/services/search-audience';

const workspaceId = '00000000-0000-7000-8000-00000000c701';
const row = { provider: 'avalon_upload', resource_type: 'file', uploaded_by_user_id: 'uploader', attachment_status: 'attached', connection_id: null };
const channel = { parentId: 'channel', substreamId: '0', parentKind: 'workstream' };
const sidekick = { parentId: 'sidekick', substreamId: '7', parentKind: 'automation' };

describe('search audience groups', () => {
  it('stores a group as a stable version 8 UUID', async () => {
    const id = await searchAudienceGroupId('conversation:channel/0');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // Computed outside this module (Python hashlib). Indexed rows hold these IDs,
    // so a change to the prefix, truncation or bit layout must fail here.
    expect(id).toBe('9c043fe1-5056-8d7c-b911-ee26e2c68643');
    expect(await searchAudienceGroupId('conversation:channel/1')).not.toBe(id);
  });

  it("names a conversation by its Canvas's Chat, or by its Sidekick", () => {
    expect(conversationSearchAudience({ parentKind: 'canvas', parentId: 'canvas', substreamId: '0' })).toEqual(['conversation:canvas/0']);
    expect(conversationSearchAudience({ parentKind: 'automation', parentId: 'sidekick', substreamId: '9' })).toEqual(['sidekick:sidekick']);
  });

  it('gives a resource its uploader, members where the provider allows, and its locations', () => {
    expect(resourceSearchAudience(workspaceId, row, [channel, sidekick]))
      .toEqual(['user:uploader', 'conversation:channel/0', 'sidekick:sidekick']);
    expect(resourceSearchAudience(workspaceId, { ...row, provider: 'avalon_generated' }, []))
      .toEqual(['user:uploader']);
    expect(resourceSearchAudience(workspaceId, { ...row, provider: 'web' }, [channel]))
      .toEqual(['user:uploader', `members:${workspaceId}`, 'conversation:channel/0']);
    // An inbound email needs an attachment even for its owner.
    expect(resourceSearchAudience(workspaceId, { ...row, provider: 'resend', resource_type: 'email' }, [channel]))
      .toEqual(['conversation:channel/0']);
    // A draft upload is its uploader's, whatever locations exist.
    expect(resourceSearchAudience(workspaceId, { ...row, attachment_status: 'draft' }, [channel])).toEqual(['user:uploader']);
    expect(resourceSearchAudience(workspaceId, { ...row, connection_id: 'c1' }, [channel])).toEqual(['connection:c1']);
    // A Canvas that holds it admits the Canvas's Chat readers.
    expect(resourceSearchAudience(workspaceId, { ...row, provider: 'avalon_generated' },
      [{ parentId: 'canvas-1', substreamId: '0', parentKind: 'canvas' }]))
      .toEqual(['user:uploader', 'conversation:canvas-1/0']);
    // Nobody placed: nobody admitted, never everyone.
    expect(resourceSearchAudience(workspaceId, { ...row, uploaded_by_user_id: null }, [])).toEqual([]);
  });
});
