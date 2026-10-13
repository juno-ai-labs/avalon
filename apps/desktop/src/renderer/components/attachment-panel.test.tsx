import * as Tooltip from '@radix-ui/react-tooltip';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttachmentPanel } from './attachment-panel';
import type { AttachmentPreview } from './attachments';

function renderPanel(preview: AttachmentPreview, onClose = vi.fn()) {
  render(<Tooltip.Provider><AttachmentPanel onClose={onClose} onResize={vi.fn()} preview={preview} width={360} /></Tooltip.Provider>);
  return onClose;
}

describe('AttachmentPanel', () => {
  beforeEach(() => {
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:panel-image'), revokeObjectURL: vi.fn() });
  });

  afterEach(() => {
    cleanup();
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

  it('steps through a gallery with the arrow keys pressed inside the panel only', async () => {
    const first = { name: 'first.png', mimeType: 'image/png', loadContent: vi.fn(async () => new Blob(['first'])) };
    const second = { name: 'second.png', mimeType: 'image/png', loadContent: vi.fn(async () => new Blob(['second'])) };
    renderPanel({ ...first, gallery: [first, second], galleryIndex: 0 });
    await screen.findByRole('img', { name: 'first.png' });

    // An arrow key typed elsewhere, such as in the composer, leaves it alone.
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(screen.getByRole('img', { name: 'first.png' })).toBeVisible();

    fireEvent.keyDown(screen.getByRole('img', { name: 'first.png' }), { key: 'ArrowRight' });
    expect(await screen.findByRole('img', { name: 'second.png' })).toBeVisible();
    expect(screen.getByText('2 / 2')).toBeVisible();
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
