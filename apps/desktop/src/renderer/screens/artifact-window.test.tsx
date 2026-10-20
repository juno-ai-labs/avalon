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
        content: new Uint8Array(), editable: true, annotationScope: '00000000-0000-4000-8000-000000000002:0',
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

const historyResource = {
  id: '00000000-0000-4000-8000-000000000001', workspaceId: '00000000-0000-4000-8000-000000000003', connectionId: null,
  resourceType: 'file', provider: 'rally', providerResourceId: null, title: 'Current plan',
  mimeType: 'text/plain', canonicalUrl: null, watchEnabled: false, watchStatus: 'unsupported',
  lastHydratedAt: null, createdAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z',
  currentVersion: 3, contentAvailable: true,
};
function historyWindow(editable = true) {
  const commands = vi.fn(async (action: { type: string; version?: number; original?: boolean }): Promise<unknown> => {
    if (action.type === 'read') return historyResource;
    if (action.type === 'pin-state') return false;
    if (action.type === 'versions') return [3, 1].map((version) => ({
      ...historyResource, resourceId: historyResource.id, version, title: version === 1 ? 'Old plan' : 'Current plan',
      storageKind: 'r2', author: null, cause: null, modelContentAvailable: true, sizeBytes: 12,
    }));
    if (action.type === 'content') return { content: Uint8Array.from(new TextEncoder().encode('Historical bytes')), mimeType: 'text/plain' };
    return null;
  });
  vi.stubGlobal('rally', { artifactWindowAction: commands });
  render(<Tooltip.Provider><AnnotationDraftProvider><ArtifactWindowContent files={new Map()} preview={{
    kind: 'generated', resourceId: historyResource.id, version: 3, title: 'Current plan', mimeType: 'text/plain',
    content: Uint8Array.from(new TextEncoder().encode('Current bytes')), editable,
    annotationScope: '00000000-0000-4000-8000-000000000002:0',
  }} /></AnnotationDraftProvider></Tooltip.Provider>);
  return commands;
}
function openHistoryMenu(title: string): void {
  fireEvent.pointerDown(screen.getByRole('button', { name: `Artifact menu: ${title}` }), { button: 0, ctrlKey: false });
}

it('downloads the displayed revision and returns to the current preview after renaming', async () => {
  const commands = historyWindow();
  vi.stubGlobal('URL', class extends URL { static override createObjectURL = () => 'blob:download'; static override revokeObjectURL = () => {}; });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  try {
    await screen.findByText('Current bytes');
    openHistoryMenu('Current plan');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Versions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /V1/ }));
    expect(await screen.findByText('Historical bytes')).toBeVisible();
    expect(screen.getByText(/Version 1 · not current/)).toBeVisible();
    openHistoryMenu('Old plan');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Download' }));
    await waitFor(() => expect(commands).toHaveBeenCalledWith({ type: 'content', original: true, version: 1 }));
    openHistoryMenu('Old plan');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Title' }), { target: { value: 'Renamed plan' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Return to current' }));
    expect(await screen.findByText('Current bytes')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Artifact menu: Renamed plan' })).toBeVisible();
    expect(screen.queryByText(/not current/)).toBeNull();
    openHistoryMenu('Renamed plan');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Download' }));
    await waitFor(() => expect(commands).toHaveBeenCalledWith({ type: 'content', original: true }));
  } finally { click.mockRestore(); vi.unstubAllGlobals(); }
});

it('withholds Main thread actions from a Sidekick artifact with a Main annotation scope', async () => {
  const commands = historyWindow(false);
  try {
    await screen.findByText('Current bytes');
    openHistoryMenu('Current plan');
    expect(await screen.findByRole('menuitem', { name: 'Download' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Rename' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Copy link' })).toBeNull();
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Pinned in my sidebar' })).toBeNull();
    expect(commands).not.toHaveBeenCalledWith({ type: 'pin-state' });
  } finally { vi.unstubAllGlobals(); }
});

it('names a rejected content field when opening a historical revision fails', async () => {
  const commands = historyWindow();
  try {
    await screen.findByText('Current bytes');
    openHistoryMenu('Current plan');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Versions' }));
    const revision = await screen.findByRole('menuitem', { name: /V1/ });
    commands.mockImplementation(async () => ({ content: null, mimeType: 'text/plain' }));
    fireEvent.click(revision);
    expect(await screen.findByRole('alert')).toHaveTextContent('artifact_window_response_invalid:content:invalid_type');
    expect(screen.getByText('Current bytes')).toBeVisible();
  } finally { vi.unstubAllGlobals(); }
});

it('retains safe diagnostics from main when a pin update fails', async () => {
  const commands = historyWindow();
  try {
    await screen.findByText('Current bytes');
    openHistoryMenu('Current plan');
    const pin = await screen.findByRole('menuitemcheckbox', { name: 'Pinned in my sidebar' });
    commands.mockRejectedValue(new Error("Error invoking remote method 'artifact:window-action': Error: artifact_window_response_invalid:pinned:invalid_type"));
    fireEvent.click(pin);
    expect(await screen.findByRole('alert')).toHaveTextContent('artifact_window_response_invalid:pinned:invalid_type');
    expect(pin).not.toBeChecked();
  } finally { vi.unstubAllGlobals(); }
});
