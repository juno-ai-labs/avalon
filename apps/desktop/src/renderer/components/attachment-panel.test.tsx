import * as Tooltip from '@radix-ui/react-tooltip';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttachmentPanel } from './attachment-panel';
import type { AttachmentPreview } from './attachments';
import { copyArtifactLink } from '../lib/copy-workstream-link';

const copyText = vi.hoisted(() => vi.fn<(text: string) => Promise<void>>(async () => undefined));
vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({ copyText, getRuntimeConfig: async () => ({ webBaseUrl: 'https://rallywith.ai' }) }),
}));

const firstResourceId = '00000000-0000-7000-8000-000000000009';
const secondResourceId = '00000000-0000-7000-8000-0000000000a9';
const workspaceId = '00000000-0000-7000-8000-000000000003';
const spaceId = '00000000-0000-7000-8000-000000000004';
const threadId = '019fec70-fba0-7b0e-9f7a-3dd1ef56520f';
const resourceLink = (resourceId: string) => () => copyArtifactLink(
  { region: 'global', workspaceId }, spaceId, threadId, resourceId,
);

function renderPanel(preview: AttachmentPreview, onClose = vi.fn()) {
  render(<Tooltip.Provider><AttachmentPanel onClose={onClose} onResize={vi.fn()} preview={preview} resourceLink={resourceLink} width={360} /></Tooltip.Provider>);
  return onClose;
}

describe('AttachmentPanel', () => {
  beforeEach(() => {
    copyText.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal('URL', class extends URL {
      static override createObjectURL = vi.fn(() => 'blob:panel-image');
      static override revokeObjectURL = vi.fn();
    });
  });

  it('copies the active gallery attachment URL and keeps feedback after the menu closes', async () => {
    const first = { resourceId: firstResourceId, name: 'first.png', mimeType: 'image/png', src: 'https://example.test/first.png' };
    const second = { resourceId: secondResourceId, name: 'second.png', mimeType: 'image/png', src: 'https://example.test/second.png' };
    renderPanel({ ...first, gallery: [first, second] });
    fireEvent.click(screen.getByRole('button', { name: 'Next attachment' }));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Attachment menu: second.png' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy URL' }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith('https://rallywith.ai/app/global/1111117Hxt1fAWDjN7TY/s/1111117Hxt1fAWDjN7TZ/c/CduMrko5vpzwph2okTVLJ/a/1111117Hxt1fAWDjN7WQ'));
    expect(await screen.findByText('Copied.')).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Download' })).toBeNull();
  });

  it('reports consecutive failed copies and lets the attachment menu retry them before reset', async () => {
    vi.useFakeTimers();
    copyText.mockRejectedValueOnce(new Error('clipboard unavailable')).mockRejectedValueOnce(new Error('clipboard unavailable'));
    renderPanel({ resourceId: firstResourceId, name: 'first.png', mimeType: 'image/png', src: 'https://example.test/first.png' });
    const openMenu = () => fireEvent.pointerDown(screen.getByRole('button', { name: 'Attachment menu: first.png' }), { button: 0, ctrlKey: false });
    for (const label of ['Copy URL', 'Copy failed — click to retry']) {
      openMenu();
      await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: label })); });
      expect(screen.getByRole('alertdialog')).toHaveTextContent('Copy failed. Try again.');
      fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    }
    openMenu();
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Copy failed — click to retry' })); });
    expect(screen.getByText('Copied.')).toBeVisible();
    expect(copyText).toHaveBeenCalledTimes(3);
  });

  it('does not offer a URL for a local preview', async () => {
    renderPanel({ name: 'local.png', mimeType: 'image/png', src: 'blob:local-image' });
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Attachment menu: local.png' }), { button: 0, ctrlKey: false });
    expect(await screen.findByRole('menuitem', { name: 'Download' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Copy URL' })).toBeNull();
  });

  it.each(['success', 'failure'] as const)('clears %s feedback when selecting another file or a local preview', async (outcome) => {
    if (outcome === 'failure') copyText.mockRejectedValueOnce(new Error('clipboard unavailable'));
    const first = { resourceId: firstResourceId, name: 'first.png', mimeType: 'image/png', src: 'https://example.test/first.png' };
    const second = { resourceId: secondResourceId, name: 'second.png', mimeType: 'image/png', src: 'https://example.test/second.png' };
    const local = { name: 'local.png', mimeType: 'image/png', src: 'blob:local-image' };
    renderPanel({ ...first, gallery: [first, second, local] });
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Attachment menu: first.png' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy URL' }));
    expect(await screen.findByText(outcome === 'success' ? 'Copied.' : 'Copy failed. Try again.')).toBeVisible();
    if (outcome === 'failure') fireEvent.click(screen.getByRole('button', { name: 'OK' }));

    fireEvent.click(screen.getByRole('button', { name: 'Next attachment' }));
    expect(screen.queryByText('Copied.')).toBeNull();
    expect(screen.queryByText('Copy failed. Try again.')).toBeNull();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Attachment menu: second.png' }), { button: 0, ctrlKey: false });
    expect(await screen.findByRole('menuitem', { name: 'Copy URL' })).toBeVisible();
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Copy URL' }), { key: 'Escape' });

    fireEvent.click(screen.getByRole('button', { name: 'Next attachment' }));
    expect(screen.queryByText('Copied.')).toBeNull();
    expect(screen.queryByText('Copy failed. Try again.')).toBeNull();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Attachment menu: local.png' }), { button: 0, ctrlKey: false });
    expect(await screen.findByRole('menuitem', { name: 'Download' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Copy URL' })).toBeNull();
  });

  it.each(['success', 'failure'] as const)('discards a pending copy %s after switching away and back', async (outcome) => {
    let finish!: () => void;
    copyText.mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
      finish = () => outcome === 'success' ? resolve() : reject(new Error('clipboard unavailable'));
    }));
    const first = { resourceId: firstResourceId, name: 'first.png', mimeType: 'image/png', src: 'https://example.test/first.png' };
    const second = { resourceId: secondResourceId, name: 'second.png', mimeType: 'image/png', src: 'https://example.test/second.png' };
    renderPanel({ ...first, gallery: [first, second] });
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Attachment menu: first.png' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy URL' }));
    await waitFor(() => expect(copyText).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole('button', { name: 'Next attachment' }));
    await act(async () => { finish(); });
    expect(screen.queryByText('Copied.')).toBeNull();
    expect(screen.queryByText('Copy failed. Try again.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Previous attachment' }));
    expect(screen.queryByText('Copied.')).toBeNull();
    expect(screen.queryByText('Copy failed. Try again.')).toBeNull();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Attachment menu: first.png' }), { button: 0, ctrlKey: false });
    expect(await screen.findByRole('menuitem', { name: 'Copy URL' })).toBeVisible();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows the attachment beside the conversation rather than in a dialog', async () => {
    const onClose = renderPanel({ name: 'note.txt', mimeType: 'text/plain', loadContent: async () => new Blob(['meeting notes']) });
    expect(screen.getByRole('complementary', { name: 'Attachment: note.txt' })).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByText('meeting notes')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('steps the gallery when an image fits and reserves arrow keys when it overflows horizontally', async () => {
    const first = { name: 'first.png', mimeType: 'image/png', loadContent: vi.fn(async () => new Blob(['first'])) };
    const second = { name: 'second.png', mimeType: 'image/png', loadContent: vi.fn(async () => new Blob(['second'])) };
    renderPanel({ ...first, gallery: [first, second], galleryIndex: 0 });
    await screen.findByRole('img', { name: 'first.png' });

    // An arrow key typed elsewhere, such as in the composer, leaves it alone.
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(screen.getByRole('img', { name: 'first.png' })).toBeVisible();

    fireEvent.click(screen.getByRole('img', { name: 'first.png' }));
    fireEvent.keyDown(screen.getByRole('region', { name: 'Image preview: first.png' }), { key: 'ArrowRight' });
    expect(await screen.findByRole('img', { name: 'second.png' })).toBeVisible();
    expect(screen.getByText('2 / 2')).toBeVisible();

    // jsdom has no layout; supply the overflowing viewport's measured dimensions.
    const viewport = screen.getByRole('region', { name: 'Image preview: second.png' });
    Object.defineProperties(viewport, { clientWidth: { value: 300 }, scrollWidth: { value: 600 } });
    expect(fireEvent.keyDown(viewport, { key: 'ArrowLeft' })).toBe(true);
    expect(screen.getByRole('img', { name: 'second.png' })).toBeVisible();
    fireEvent.keyDown(screen.getByRole('complementary', { name: 'Attachment: second.png' }), { key: 'ArrowLeft' });
    expect(await screen.findByRole('img', { name: 'first.png' })).toBeVisible();
  });

  it('leaves the gallery alone when an arrow key is pressed in the panel\'s own menu', async () => {
    const first = { name: 'first.png', mimeType: 'image/png', loadContent: vi.fn(async () => new Blob(['first'])) };
    const second = { name: 'second.png', mimeType: 'image/png', loadContent: vi.fn(async () => new Blob(['second'])) };
    renderPanel({ ...first, gallery: [first, second], galleryIndex: 0 });
    await screen.findByRole('img', { name: 'first.png' });

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Attachment menu: first.png' }), { button: 0, ctrlKey: false });
    fireEvent.keyDown(await screen.findByRole('menuitem', { name: 'Download' }), { key: 'ArrowRight' });
    expect(screen.getByRole('img', { name: 'first.png' })).toBeInTheDocument();
    expect(second.loadContent).not.toHaveBeenCalled();
  });

  it('draws the Expand or Collapse it is given, with what it covers as breadcrumbs', () => {
    const onSelect = vi.fn();
    const first = { name: 'first.png', mimeType: 'image/png', loadContent: vi.fn(async () => new Blob(['first'])) };
    render(<Tooltip.Provider><AttachmentPanel
      ancestors={[{ key: 'thread', icon: null, title: 'Launch', label: 'Show Launch', onSelect: vi.fn() }]}
      expandAction={[{ key: 'expand', label: 'Collapse', icon: null, onSelect }]}
      onClose={vi.fn()}
      onResize={vi.fn()}
      preview={first}
      width={360}
    /></Tooltip.Provider>);
    expect(screen.getByRole('button', { name: 'Launch' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('labels a prior version and offers the way back to the current one', () => {
    const onReturnToCurrent = vi.fn();
    renderPanel({
      name: 'plan.md',
      mimeType: 'text/markdown',
      loadContent: async () => new Blob(['# Old plan']),
      superseded: { label: 'Version 1 · not current', onReturnToCurrent },
    });
    const back = screen.getByRole('button', { name: 'Return to current' });
    expect(back.closest('[role="status"]')).toHaveTextContent('Version 1 · not current');
    fireEvent.click(back);
    expect(onReturnToCurrent).toHaveBeenCalledOnce();
  });
});
