import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageAttachment } from '../lib/types';
import { AttachmentLightbox, MessageAttachments, PendingAttachmentTile } from './attachments';

describe('attachment presentation', () => {
  beforeEach(() => {
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:remote-image'),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('shows image previews, complete-filename tooltips, progress, and remove controls', () => {
    const onOpen = vi.fn();
    const onRemove = vi.fn();
    render(<PendingAttachmentTile
      attachment={{
        localId: 'draft',
        file: new File(['image'], 'complete image name.png', { type: 'image/png' }),
        previewUrl: 'blob:local-image',
        progress: 42,
        status: 'uploading',
      }}
      onOpen={onOpen}
      onRemove={onRemove}
      onRetry={vi.fn()}
    />);

    expect(screen.getByTitle('complete image name.png')).toBeVisible();
    expect(screen.getByRole('progressbar', { name: '42% uploaded' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Preview complete image name.png' }));
    expect(onOpen).toHaveBeenCalledWith({ name: 'complete image name.png', src: 'blob:local-image' });
    fireEvent.click(screen.getByRole('button', { name: 'Remove complete image name.png' }));
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it('loads a sent image lazily and opens it in the lightbox', async () => {
    const attachment: MessageAttachment = {
      id: 'resource-1',
      fileName: 'diagram.png',
      mimeType: 'image/png',
      sizeBytes: 5,
      contentAvailable: true,
      createdAt: '2026-08-04T00:00:00.000Z',
    };
    const loadContent = vi.fn(async () => new Blob(['image'], { type: 'image/png' }));
    function Example(): React.JSX.Element {
      const [preview, setPreview] = useState<{ name: string; src: string } | null>(null);
      return <><MessageAttachments attachments={[attachment]} loadContent={loadContent} onOpen={setPreview} /><AttachmentLightbox preview={preview} onClose={() => setPreview(null)} /></>;
    }
    render(<Example />);

    const button = await screen.findByRole('button', { name: 'Preview diagram.png' });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    expect(screen.getByRole('dialog', { name: 'Preview of diagram.png' })).toBeVisible();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
