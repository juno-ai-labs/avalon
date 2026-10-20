import * as Tooltip from '@radix-ui/react-tooltip';
import {fireEvent, render, screen, waitFor} from '@testing-library/react';
import {describe,expect,it,vi} from 'vitest';
import {AnnotationDraftProvider} from '../components/artifact-annotations';
import {ArtifactWindowContent} from './artifact-window';

describe('generated media popouts',()=>{
  it.each([['audio/wav','audio'],['video/mp4','video']])('keeps %s as a media player', (mimeType,tag)=>{
    vi.stubGlobal('URL',class extends URL {static override createObjectURL=()=> 'blob:media-preview';static override revokeObjectURL=()=>{};});
    const {container}=render(<Tooltip.Provider><AnnotationDraftProvider><ArtifactWindowContent files={new Map()} preview={{kind:'generated',resourceId:'00000000-0000-7000-8000-000000000001',version:1,title:'Recording',mimeType:mimeType!,content:new Uint8Array([82,73,70,70])}} /></AnnotationDraftProvider></Tooltip.Provider>);
    expect(container.querySelector(tag!)).toHaveAttribute('controls');
    expect(container.querySelector(tag!)).toHaveAttribute('src','blob:media-preview');
    expect(container.querySelector('.annotation-body')).toBeNull();
  });
});

describe('detached artifact menu', () => {
  it('uses shared action rows for pinning and archiving', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const commands = vi.fn(async (action: { type: string; pinned?: boolean }) => {
      if (action.type === 'pin-state') return true;
      if (action.type === 'versions') return [];
      if (action.type === 'read') return {
        id, workspaceId: '00000000-0000-4000-8000-000000000003', connectionId: null,
        resourceType: 'file', provider: 'rally', providerResourceId: null, title: 'Plan',
        mimeType: 'text/plain', canonicalUrl: null, watchEnabled: false, watchStatus: 'unsupported',
        lastHydratedAt: null, createdAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z',
      };
      return null;
    });
    vi.stubGlobal('rally', { artifactWindowAction: commands });
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    try {
      render(<Tooltip.Provider><AnnotationDraftProvider><ArtifactWindowContent files={new Map()} preview={{
        kind: 'generated', resourceId: id, version: 1, title: 'Plan', mimeType: 'text/plain',
        content: new Uint8Array(), annotationScope: '00000000-0000-4000-8000-000000000002:0',
      }} /></AnnotationDraftProvider></Tooltip.Provider>);
      await waitFor(() => expect(commands).toHaveBeenCalledWith({ type: 'pin-state' }));
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Artifact menu: Plan' }), { button: 0, ctrlKey: false });
      expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeVisible();
      expect(screen.queryByRole('menuitem', { name: 'Archive' })).toBeNull();
      expect(screen.getByRole('menuitem', { name: 'More' })).toBeVisible();
      const pin = await screen.findByRole('menuitemcheckbox', { name: 'Pinned in my sidebar' });
      expect(pin).toBeChecked();
      expect(screen.queryByRole('menuitem', { name: 'Open in a new window' })).toBeNull();
      fireEvent.click(pin);
      await waitFor(() => expect(commands).toHaveBeenCalledWith({ type: 'pin', pinned: false }));
      await waitFor(() => expect(pin).not.toBeChecked());
      fireEvent.click(screen.getByRole('menuitem', { name: 'More' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
      await waitFor(() => expect(commands).toHaveBeenCalledWith({ type: 'archive' }));
      await waitFor(() => expect(close).toHaveBeenCalled());
    } finally {
      vi.unstubAllGlobals();
      close.mockRestore();
    }
  });
});
