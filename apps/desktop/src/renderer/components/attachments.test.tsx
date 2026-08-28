import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageAttachment } from '../lib/types';
import { AttachmentLightbox } from './attachment-lightbox';
import { type AttachmentPreview, MessageAttachments, PendingAttachmentTile } from './attachments';

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
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ name: 'complete image name.png', src: 'blob:local-image' }));
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
      const [preview, setPreview] = useState<AttachmentPreview | null>(null);
      return <><MessageAttachments attachments={[attachment]} loadContent={loadContent} onOpen={setPreview} /><AttachmentLightbox preview={preview} onClose={() => setPreview(null)} /></>;
    }
    render(<Example />);

    const button = await screen.findByRole('button', { name: 'Preview diagram.png' });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    expect(screen.getByRole('dialog', { name: 'Preview of diagram.png' })).toBeVisible();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(button).toHaveFocus());
  });

  it('says plainly that a prior version is not current, and offers the way back', async () => {
    const onReturnToCurrent = vi.fn();
    render(
      <AttachmentLightbox
        onClose={vi.fn()}
        preview={{
          name: 'Launch plan',
          mimeType: 'text/markdown',
          supersededLabel: 'Version 1 · not current',
          onReturnToCurrent,
          loadContent: async () => new Blob(['# Draft'], { type: 'text/markdown' }),
        }}
      />,
    );

    // A prior version renders in the same surface as the current one, so
    // nothing but this notice distinguishes what a reader is looking at.
    expect(await screen.findByText('Version 1 · not current')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Return to current' }));
    expect(onReturnToCurrent).toHaveBeenCalledOnce();
  });

  it('can open an image when its eager thumbnail preload fails', async () => {
    const attachment: MessageAttachment = {
      id: 'resource-retry-image',
      fileName: 'retry.png',
      mimeType: 'image/png',
      sizeBytes: 5,
      contentAvailable: true,
      createdAt: '2026-08-04T00:00:00.000Z',
    };
    const loadContent = vi.fn()
      .mockRejectedValueOnce(new Error('thumbnail failed'))
      .mockResolvedValueOnce(new Blob(['image'], { type: 'image/png' }));
    function Example(): React.JSX.Element {
      const [preview, setPreview] = useState<AttachmentPreview | null>(null);
      return <><MessageAttachments attachments={[attachment]} loadContent={loadContent} onOpen={setPreview} /><AttachmentLightbox preview={preview} onClose={() => setPreview(null)} /></>;
    }
    render(<Example />);

    const button = screen.getByRole('button', { name: 'Preview retry.png' });
    expect(button).toBeEnabled();
    await waitFor(() => expect(loadContent).toHaveBeenCalledOnce());
    fireEvent.click(button);
    expect(await screen.findByRole('img', { name: 'retry.png' })).toBeVisible();
    expect(loadContent).toHaveBeenCalledTimes(2);
  });

  it('does not allocate an image URL after a closed preview settles', async () => {
    let resolveContent!: (blob: Blob) => void;
    const loadContent = vi.fn(() => new Promise<Blob>((resolve) => { resolveContent = resolve; }));
    function Example(): React.JSX.Element {
      const [preview, setPreview] = useState<AttachmentPreview | null>({
        name: 'late.png',
        mimeType: 'image/png',
        loadContent,
      });
      return <AttachmentLightbox preview={preview} onClose={() => setPreview(null)} />;
    }
    render(<Example />);

    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    resolveContent(new Blob(['late'], { type: 'image/png' }));
    await Promise.resolve();

    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('loads and renders a sent Markdown attachment only after it is opened', async () => {
    const attachment: MessageAttachment = {
      id: 'resource-markdown',
      fileName: 'brief.md',
      mimeType: 'text/markdown',
      sizeBytes: 24,
      contentAvailable: true,
      createdAt: '2026-08-04T00:00:00.000Z',
    };
    const loadContent = vi.fn(async () => new Blob(['# Launch brief\n\n- First'], { type: 'text/markdown' }));
    function Example(): React.JSX.Element {
      const [preview, setPreview] = useState<AttachmentPreview | null>(null);
      return <><MessageAttachments attachments={[attachment]} loadContent={loadContent} onOpen={setPreview} /><AttachmentLightbox preview={preview} onClose={() => setPreview(null)} /></>;
    }
    render(<Example />);

    expect(loadContent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Preview brief.md' }));
    expect(screen.getByRole('dialog', { name: 'Preview of brief.md' })).toHaveAttribute('aria-busy', 'true');
    expect(await screen.findByRole('heading', { name: 'Launch brief' })).toBeVisible();
    expect(loadContent).toHaveBeenCalledOnce();
  });

  it('shows plain text as monospace text without interpreting Markdown', async () => {
    const attachment: MessageAttachment = {
      id: 'resource-text',
      fileName: 'debug.log',
      mimeType: 'text/plain',
      sizeBytes: 16,
      contentAvailable: true,
      createdAt: '2026-08-04T00:00:00.000Z',
    };
    const loadContent = vi.fn(async () => new Blob(['**literal**\nline two'], { type: 'text/plain' }));
    function Example(): React.JSX.Element {
      const [preview, setPreview] = useState<AttachmentPreview | null>(null);
      return <><MessageAttachments attachments={[attachment]} loadContent={loadContent} onOpen={setPreview} /><AttachmentLightbox preview={preview} onClose={() => setPreview(null)} /></>;
    }
    render(<Example />);

    fireEvent.click(screen.getByRole('button', { name: 'Preview debug.log' }));
    const text = await screen.findByText(/\*\*literal\*\*/u);
    expect(text.tagName).toBe('PRE');
    expect(text).toHaveClass('attachment-lightbox-text');
    expect(screen.queryByText('literal', { selector: 'strong' })).not.toBeInTheDocument();
  });

  it('shows CSV source content as literal text', async () => {
    const attachment: MessageAttachment = {
      id: 'resource-csv',
      fileName: 'metrics.csv',
      mimeType: 'text/csv',
      sizeBytes: 24,
      contentAvailable: true,
      createdAt: '2026-08-04T00:00:00.000Z',
    };
    const loadContent = vi.fn(async () => new Blob(['month,total\nJuly,42'], { type: 'text/csv' }));
    function Example(): React.JSX.Element {
      const [preview, setPreview] = useState<AttachmentPreview | null>(null);
      return <><MessageAttachments attachments={[attachment]} loadContent={loadContent} onOpen={setPreview} /><AttachmentLightbox preview={preview} onClose={() => setPreview(null)} /></>;
    }
    render(<Example />);

    fireEvent.click(screen.getByRole('button', { name: 'Preview metrics.csv' }));
    const text = await screen.findByText(/month,total/u);
    expect(text.tagName).toBe('PRE');
  });

  it('renders a document derivative as Markdown', async () => {
    const attachment: MessageAttachment = {
      id: 'resource-document',
      fileName: 'proposal.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sizeBytes: 512,
      contentAvailable: true,
      createdAt: '2026-08-04T00:00:00.000Z',
    };
    const loadContent = vi.fn(async () => new Blob(['# Converted proposal\n\nDocument body'], { type: 'text/markdown' }));
    function Example(): React.JSX.Element {
      const [preview, setPreview] = useState<AttachmentPreview | null>(null);
      return <><MessageAttachments attachments={[attachment]} loadContent={loadContent} onOpen={setPreview} /><AttachmentLightbox preview={preview} onClose={() => setPreview(null)} /></>;
    }
    render(<Example />);

    fireEvent.click(screen.getByRole('button', { name: 'Preview proposal.docx' }));
    expect(await screen.findByRole('heading', { name: 'Converted proposal' })).toBeVisible();
  });
});
