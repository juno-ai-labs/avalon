import {AnnotationDraftProvider} from './artifact-annotations';
import * as Tooltip from '@radix-ui/react-tooltip';
import { cleanup, fireEvent, render as renderBare, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pastedTextFile } from '../lib/pasted-text';
import type { MessageAttachment, WorkstreamResource } from '../lib/types';
import type { PendingAttachment } from '../lib/use-file-attachments';
import { AttachmentLightbox } from './attachment-lightbox';
import { type AttachmentPreview, MessageAttachments, PendingAttachmentTile } from './attachments';

/**
 * Every render here goes through the tooltip provider, the way the application
 * mounts one at its root: the lightbox's actions are icons alone, so each one
 * carries a tooltip, and Radix throws without it.
 */
function render(ui: React.JSX.Element) {
  return renderBare(<Tooltip.Provider>{ui}</Tooltip.Provider>);
}

describe('attachment presentation', () => {
  it('dismisses empty image backdrop clicks without dismissing image or zoom interactions', () => {
    function Example(): React.JSX.Element {
      const [open,setOpen] = useState(true);
      return <AttachmentLightbox preview={open ? {name:'Image.png',mimeType:'image/png',src:'image.png'} : null} onClose={()=>setOpen(false)} />;
    }
    render(<Example />);
    const image = screen.getByRole('img', {name:'Image.png'});
    fireEvent.mouseDown(image);
    fireEvent.mouseDown(screen.getByRole('button', {name:'Zoom in'}));
    expect(screen.getByRole('dialog')).toBeVisible();
    fireEvent.mouseDown(image.closest('.image-viewport-stage')!);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the lightbox full-size action synchronized with toolbar and image gestures', () => {
    const first = {name:'Image.png',mimeType:'image/png',src:'image.png'};
    const second = {name:'Second.png',mimeType:'image/png',src:'second.png'};
    render(<AttachmentLightbox preview={{...first,gallery:[first,second]}} onClose={vi.fn()} />);
    const image = screen.getByRole('img', {name:'Image.png'});
    Object.defineProperties(image, {naturalWidth:{value:1800},naturalHeight:{value:4200}});
    fireEvent.load(image);
    fireEvent.click(screen.getByRole('button', {name:'Show preview at full size'}));
    expect(screen.getByRole('button', {name:'Fit preview to window'})).toBeVisible();
    fireEvent.click(screen.getByRole('button', {name:'Fit'}));
    expect(screen.getByRole('button', {name:'Show preview at full size'})).toBeVisible();
    fireEvent.click(screen.getByRole('button', {name:'Show preview at full size'}));
    expect(screen.getByRole('button', {name:'Show image at 100%'})).toHaveTextContent('100%');
    fireEvent.doubleClick(image);
    expect(screen.getByRole('button', {name:'Show preview at full size'})).toBeVisible();
    fireEvent.click(screen.getByRole('button', {name:'Show image at 100%'}));
    fireEvent.click(screen.getByRole('button', {name:'Next attachment'}));
    expect(screen.getByRole('dialog', {name:'Preview of Second.png'})).toBeVisible();
    expect(screen.getByRole('button', {name:'Show preview at full size'})).toBeVisible();
  });

  it('opens bytes immediately and resolves a version only when commenting',async()=>{
    const readResource=vi.fn(async()=>({currentVersion:2}));
    const readResourceVersion=vi.fn(async()=>new Blob(['# Version two'],{type:'text/markdown'}));
    render(<AnnotationDraftProvider readResource={readResource} readResourceVersion={readResourceVersion}><AttachmentLightbox preview={{name:'Plan.md',mimeType:'text/markdown',resourceId:'00000000-0000-7000-8000-000000000001',loadContent:async()=>new Blob(['# Initial preview'],{type:'text/markdown'})}} onClose={()=>{}}/></AnnotationDraftProvider>);
    expect(await screen.findByText('Initial preview')).toBeVisible();
    expect(readResource).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'Comment mode'}));
    expect(await screen.findByText('Version two')).toBeVisible();
    expect(readResourceVersion).toHaveBeenCalledWith('00000000-0000-7000-8000-000000000001',2,expect.any(AbortSignal));
  });

  it('pins a whole file without requiring unsupported preview bytes', async () => {
    const readResource = vi.fn(async () => ({currentVersion: 2}));
    const readResourceVersion = vi.fn(async () => {throw new Error('Preview unsupported');});
    render(<AnnotationDraftProvider readResource={readResource} readResourceVersion={readResourceVersion}><AttachmentLightbox preview={{name:'archive.bin',mimeType:'application/octet-stream',resourceId:'00000000-0000-7000-8000-000000000001'}} onClose={()=>{}}/></AnnotationDraftProvider>);
    fireEvent.click(screen.getByRole('button', {name:'Comment mode'}));
    await waitFor(() => expect(screen.getByRole('button', {name:'Comment mode'})).toHaveAttribute('aria-pressed','true'));
    fireEvent.click(screen.getByText('archive.bin', {selector:'.annotation-body p'}));
    expect(await screen.findByRole('textbox', {name:'Comment on selection'})).toBeVisible();
    expect(readResourceVersion).not.toHaveBeenCalled();
  });

  it('shows unavailable content without a spinner or a dead download action', () => {
    render(<AttachmentLightbox preview={{ name: 'Unavailable.pdf' }} onClose={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('no preview available');
    expect(screen.queryByRole('button', { name: 'Download Unavailable.pdf' })).toBeNull();
    expect(screen.queryByText('Preparing preview…')).toBeNull();
  });

  it('opens without a tooltip nobody asked for', () => {
    // Its actions are icons with tooltips, and Radix opens a tooltip on focus.
    // A dialog hands focus to its first control, so the preview used to open
    // with a label floating over it, and that tooltip then ate the Escape
    // meant for the preview.
    render(<AttachmentLightbox preview={{ name: 'note.txt', mimeType: 'text/plain' }} onClose={vi.fn()} />);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('reports download failures instead of leaving an unhandled rejection', async () => {
    const loadContent = vi.fn().mockResolvedValueOnce(new Blob(['preview'])).mockRejectedValueOnce(new Error('offline'));
    render(<AttachmentLightbox preview={{ name: 'note.txt', mimeType: 'text/plain', loadContent }} onClose={vi.fn()} />);
    await screen.findByText('preview');
    fireEvent.click(screen.getByRole('button', { name: 'Download note.txt' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Download failed');
  });

  beforeEach(() => {
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:remote-image'),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(async () => {
    cleanup();
    // Radix restores focus in a zero-delay timer after unmount. Let that event
    // run while its jsdom window still owns CustomEvent; otherwise file teardown
    // can replace the constructor before it dispatches on the old DOM node.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    vi.unstubAllGlobals();
  });

  it('opens only the selected gallery entry without downloading thumbnail originals', async () => {
    const first = { name: 'first.png', mimeType: 'image/png', loadContent: vi.fn(async () => new Blob(['first'])) };
    const second = { name: 'second.png', mimeType: 'image/png', loadContent: vi.fn(async () => new Blob(['second'])) };
    render(<AttachmentLightbox preview={{ ...second, gallery: [first, second], galleryIndex: 1 }} onClose={vi.fn()} />);
    await screen.findByRole('img', { name: 'second.png' });
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Preview of second.png');
    expect(screen.getByRole('button', { name: 'View attachment 2: second.png' })).toHaveAttribute('aria-current', 'true');
    expect(first.loadContent).not.toHaveBeenCalled();
    expect(second.loadContent).toHaveBeenCalledOnce();
  });

  it('defers video bytes until preview and retains media download', async () => {
    const loadContent = vi.fn(async () => new Blob(['video'], { type: 'video/mp4' }));
    function Fixture(): React.JSX.Element {
      const [preview, setPreview] = useState<AttachmentPreview | null>(null);
      return <><MessageAttachments attachments={[{ id: 'video', fileName: 'clip.mp4', mimeType: 'video/mp4', sizeBytes: 5, contentAvailable: true, createdAt: '' }]} loadContent={loadContent} onOpen={setPreview} /><AttachmentLightbox preview={preview} onClose={() => setPreview(null)} /></>;
    }
    render(<Fixture />);
    expect(loadContent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Preview clip.mp4' }));
    await screen.findByLabelText('Video: clip.mp4');
    expect(loadContent).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Download attachment' })).toBeVisible();
  });

  it('does not create audio URLs after an unmounted pending read settles', async () => {
    let finish!: (blob: Blob) => void;
    const loadContent = vi.fn(() => new Promise<Blob>((resolve) => { finish = resolve; }));
    const view = render(<MessageAttachments attachments={[{ id: 'audio', fileName: 'sample.wav', mimeType: 'audio/wav', sizeBytes: 1, contentAvailable: true, createdAt: '' }]} loadContent={loadContent} onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Play sample.wav' }));
    view.unmount();
    finish(new Blob(['audio']));
    await Promise.resolve();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it.each(['mkv', 'ogv'])('previews generic-MIME %s files as video', async (extension) => {
    render(<AttachmentLightbox preview={{ name: `clip.${extension}`, mimeType: 'application/octet-stream', loadContent: async () => new Blob(['video']) }} onClose={vi.fn()} />);
    expect((await screen.findByLabelText(`Video: clip.${extension}`)).tagName).toBe('VIDEO');
  });

  it.each(['html', 'mp4', 'png'])('honors a specific text MIME despite the %s extension', async (extension) => {
    render(<AttachmentLightbox preview={{ name: `literal.${extension}`, mimeType: 'text/plain', loadContent: async () => new Blob(['<img src="https://example.com/not-loaded">']) }} onClose={vi.fn()} />);
    expect((await screen.findByText(/<img src=/u)).tagName).toBe('PRE');
    expect(document.querySelector('iframe, video, .attachment-lightbox-content img')).toBeNull();
  });

  it('places the HTML network policy before all untrusted source markup', async () => {
    const source = '<img src="https://example.com/before-head"><!-- <head> --><head></head>';
    render(<AttachmentLightbox preview={{ name: 'page.html', mimeType: 'text/html', loadContent: async () => new Blob([source]) }} onClose={vi.fn()} />);
    const frame = await screen.findByTitle<HTMLIFrameElement>('Preview of page.html');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.srcdoc.indexOf('Content-Security-Policy')).toBeLessThan(frame.srcdoc.indexOf(source));
  });

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

  it('holds a long paste in a skeleton until the API has typed and named it', () => {
    const file = pastedTextFile('# Q4 hiring plan', '2026-10-18 at 17.10.00', 1);
    const tile = (attachment: Partial<PendingAttachment>) => <PendingAttachmentTile
      attachment={{ localId: 'draft-paste', file, progress: 99, status: 'uploading', ...attachment }}
      onOpen={vi.fn()}
      onRemove={vi.fn()}
      onRetry={vi.fn()}
    />;
    const { rerender } = render(tile({}));

    expect(screen.getByRole('status', { name: 'Preparing pasted text' })).toBeVisible();
    expect(screen.queryByText(/Pasted text/u)).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();

    rerender(<Tooltip.Provider>{tile({
      progress: 100,
      status: 'ready',
      resource: { id: 'draft-paste', title: 'Q4 Hiring Plan.md', mimeType: 'text/markdown' } as WorkstreamResource,
    })}</Tooltip.Provider>);

    expect(screen.queryByRole('status', { name: 'Preparing pasted text' })).toBeNull();
    expect(screen.getByTitle('Q4 Hiring Plan.md')).toBeVisible();
  });

  it('shows pending video as a media tile and opens the local preview', () => {
    const onOpen = vi.fn();
    render(<PendingAttachmentTile
      attachment={{
        localId: 'draft-video',
        file: new File(['video'], 'walkthrough.mp4', { type: 'video/mp4' }),
        previewUrl: 'blob:local-video',
        progress: 100,
        status: 'ready',
      }}
      onOpen={onOpen}
      onRemove={vi.fn()}
      onRetry={vi.fn()}
    />);

    const preview = screen.getByRole('button', { name: 'Preview walkthrough.mp4' });
    expect(preview.querySelector('video')).toHaveAttribute('src', 'blob:local-video');
    expect(document.querySelector('.attachment-tile')).toHaveClass('is-video');
    expect(document.querySelector('.attachment-video-play')).toBeVisible();
    fireEvent.click(preview);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({
      mimeType: 'video/mp4',
      name: 'walkthrough.mp4',
      src: 'blob:local-video',
    }));
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
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(button).toHaveFocus());
  });

  it('keeps a settled thumbnail mounted across equivalent transcript refreshes', async () => {
    const attachment: MessageAttachment = {
      id: 'stable-image',
      fileName: 'settled.png',
      mimeType: 'image/png',
      sizeBytes: 5,
      contentAvailable: true,
      createdAt: '2026-08-04T00:00:00.000Z',
    };
    const loadContent = vi.fn(async () => new Blob(['image'], { type: 'image/png' }));
    const onOpen = vi.fn();
    const view = render(
      <MessageAttachments attachments={[attachment]} loadContent={loadContent} onOpen={onOpen} />,
    );

    const image = await screen.findByRole('img', { name: 'settled.png' });
    expect(loadContent).toHaveBeenCalledOnce();

    // A socket snapshot recreates both the record and the containing array.
    // Neither is a media change, so the blob URL and DOM image must survive it.
    view.rerender(
      <Tooltip.Provider>
        <MessageAttachments attachments={[{ ...attachment }]} loadContent={loadContent} onOpen={onOpen} />
      </Tooltip.Provider>,
    );
    await Promise.resolve();

    expect(screen.getByRole('img', { name: 'settled.png' })).toBe(image);
    expect(loadContent).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it('keeps every image visible and opens its matching gallery entry', async () => {
    const attachments = Array.from({ length: 4 }, (_, index): MessageAttachment => ({
      id: `image-${index}`, fileName: `image-${index}.png`, mimeType: 'image/png', sizeBytes: 5,
      contentAvailable: true, createdAt: '2026-09-09T00:00:00.000Z',
    }));
    const loadContent = vi.fn(async () => new Blob(['image'], { type: 'image/png' }));
    function Example(): React.JSX.Element {
      const [preview, setPreview] = useState<AttachmentPreview | null>(null);
      return <><MessageAttachments attachments={attachments} loadContent={loadContent} onOpen={setPreview} /><AttachmentLightbox preview={preview} onClose={() => setPreview(null)} /></>;
    }
    render(<Example />);
    expect(document.querySelectorAll('.message-attachment-image')).toHaveLength(4);
    expect(screen.queryByText('+2')).toBeNull();
    const overflow = screen.getByRole('button', { name: 'Preview image-2.png' });
    fireEvent.click(overflow);
    expect(await screen.findByRole('dialog', { name: 'Preview of image-2.png' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'View attachment 4: image-3.png' }));
    expect(screen.getByRole('dialog', { name: 'Preview of image-3.png' })).toBeVisible();
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(screen.getByRole('dialog', { name: 'Preview of image-2.png' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    await waitFor(() => expect(overflow).toHaveFocus());
  });

  it('loads inline audio only after Play and retries failed reads', async () => {
    const attachment: MessageAttachment = { id: 'audio', fileName: 'sample.wav', mimeType: 'audio/wav',
      sizeBytes: 8, contentAvailable: true, createdAt: '2026-09-09T00:00:00.000Z' };
    const loadContent = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(new Blob(['audio']));
    render(<MessageAttachments attachments={[attachment]} loadContent={loadContent} onOpen={vi.fn()} />);
    expect(loadContent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Play sample.wav' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Audio unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Play sample.wav' }));
    expect(await screen.findByLabelText('Audio: sample.wav')).toHaveAttribute('src');
    expect(loadContent).toHaveBeenCalledTimes(2);
  });

  it('loads generated audio lazily and exposes an AI-voice player', async () => {
    const attachment: MessageAttachment = {
      id: 'resource-audio',
      fileName: 'launch-update.mp3',
      mimeType: 'audio/mpeg',
      sizeBytes: 8,
      contentAvailable: true,
      createdAt: '2026-08-30T00:00:00.000Z',
    };
    const loadContent = vi.fn(async () => new Blob(['ID3audio'], { type: 'audio/mpeg' }));
    function Example(): React.JSX.Element {
      const [preview, setPreview] = useState<AttachmentPreview | null>(null);
      return <><MessageAttachments attachments={[attachment]} loadContent={loadContent} onOpen={setPreview} /><AttachmentLightbox preview={preview} onClose={() => setPreview(null)} /></>;
    }
    render(<Example />);

    const button = screen.getByRole('button', { name: 'Preview launch-update.mp3' });
    fireEvent.click(button);

    const player = await screen.findByLabelText('Audio: launch-update.mp3');
    expect(player.tagName).toBe('AUDIO');
    expect(player).toHaveAttribute('src');
    expect(player).toHaveAttribute('src', 'blob:remote-image');
    expect(loadContent).toHaveBeenCalledOnce();
  });

  it('says plainly that a prior version is not current, and offers the way back', async () => {
    const onReturnToCurrent = vi.fn();
    render(
      <AttachmentLightbox
        onClose={vi.fn()}
        preview={{
          name: 'Launch plan',
          mimeType: 'text/markdown',
          superseded: { label: 'Version 1 · not current', onReturnToCurrent },
          loadContent: async () => new Blob(['# Draft'], { type: 'text/markdown' }),
        }}
      />,
    );

    // A prior version renders in the same surface as the current one, so
    // nothing but this notice distinguishes what a reader is looking at.
    expect(await screen.findByText('Version 1 · not current')).toBeVisible();
    // The pill is the only thing separating history from the live document, so
    // it has to reach a reader who is hearing the dialog rather than seeing it.
    expect(screen.getByRole('dialog', { name: 'Preview of Launch plan — Version 1 · not current' }))
      .toBeVisible();
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

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
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
    expect(text.closest('pre')).toHaveClass('attachment-lightbox-text');
    expect(screen.queryByText('literal', { selector: 'strong' })).not.toBeInTheDocument();
  });

  it('shows CSV source content as a selectable grid', async () => {
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
    expect(await screen.findByRole('cell',{name:'July'})).toBeVisible();
    expect(screen.getByRole('cell',{name:'42'})).toBeVisible();
    expect(screen.getByRole('cell',{name:'month'})).toBeVisible();
  });

  it('fades a name past 200 characters instead of growing the chip without bound', () => {
    const longName = `${'a'.repeat(201)}.txt`;
    const attachment: MessageAttachment = {
      id: 'resource-long-name', fileName: longName, mimeType: 'text/plain',
      sizeBytes: 16, contentAvailable: true, createdAt: '2026-08-04T00:00:00.000Z',
    };
    render(<MessageAttachments attachments={[attachment]} loadContent={vi.fn()} onOpen={vi.fn()} />);
    expect(document.querySelector('.attachment-file-name')).toHaveClass('is-long-name');
  });

  it('does not fade a name at or under 200 characters', () => {
    const attachment: MessageAttachment = {
      id: 'resource-short-name', fileName: `${'a'.repeat(196)}.txt`, mimeType: 'text/plain',
      sizeBytes: 16, contentAvailable: true, createdAt: '2026-08-04T00:00:00.000Z',
    };
    render(<MessageAttachments attachments={[attachment]} loadContent={vi.fn()} onOpen={vi.fn()} />);
    expect(document.querySelector('.attachment-file-name')).not.toHaveClass('is-long-name');
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
