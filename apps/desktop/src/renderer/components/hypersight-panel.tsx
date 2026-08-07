import clsx from 'clsx';
import { AlertTriangle, GripVertical, LoaderCircle, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { HyperSight, HyperSightBlock } from '../lib/types';
import { Button, IconButton, Modal } from './primitives';
import { MarkdownBody } from './workstream-blocks';

interface HyperSightPanelProps {
  hypersight: HyperSight;
  pending: boolean;
  error?: string;
  onChange: (blocks: Array<{ id: string; prompt: string }>) => Promise<void>;
}

function moveBlock(blocks: HyperSightBlock[], sourceId: string, targetId: string): HyperSightBlock[] {
  const sourceIndex = blocks.findIndex((block) => block.id === sourceId);
  const targetIndex = blocks.findIndex((block) => block.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return blocks;
  const next = [...blocks];
  const [source] = next.splice(sourceIndex, 1);
  if (!source) return blocks;
  next.splice(targetIndex, 0, source);
  return next;
}

function configurationBlocks(blocks: HyperSightBlock[]): Array<{ id: string; prompt: string }> {
  return blocks.map(({ id, prompt }) => ({ id, prompt }));
}

function HyperSightBlockContent({ block }: { block: HyperSightBlock }): React.JSX.Element {
  if (!block.prompt.trim()) {
    return <p className="hypersight-block-placeholder">Choose the sparkle to add a prompt.</p>;
  }
  const run = block.latestRun;
  if (!run || run.status === 'queued' || run.status === 'running') {
    return (
      <div aria-live="polite" className="hypersight-block-state">
        <LoaderCircle aria-hidden="true" className="spin" size={14} />
        <span>{run?.status === 'queued' ? 'Waiting to refresh…' : 'Refreshing…'}</span>
      </div>
    );
  }
  if (run.status === 'failed' || run.status === 'stopped') {
    return (
      <div className="hypersight-block-state is-error" role="alert">
        <AlertTriangle aria-hidden="true" size={14} />
        <span>{run.error?.message ?? 'This block could not be refreshed.'}</span>
      </div>
    );
  }
  return <MarkdownBody>{run.markdown ?? ''}</MarkdownBody>;
}

export function HyperSightPanel({
  hypersight,
  pending,
  error,
  onChange,
}: HyperSightPanelProps): React.JSX.Element {
  const [blocks, setBlocks] = useState(hypersight.blocks);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
  const [promptDraft, setPromptDraft] = useState('');
  const [reorderAnnouncement, setReorderAnnouncement] = useState('');
  const dragImageRef = useRef<HTMLElement | null>(null);
  const dragFinishedRef = useRef(false);
  const draggingIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!draggingIdRef.current) {
      setBlocks(hypersight.blocks);
      return;
    }
    const incomingById = new Map(hypersight.blocks.map((block) => [block.id, block]));
    setBlocks((current) => current.map((block) => {
      const incoming = incomingById.get(block.id);
      return incoming ? { ...block, latestRun: incoming.latestRun } : block;
    }));
  }, [hypersight.blocks]);
  useEffect(() => () => dragImageRef.current?.remove(), []);

  const openPrompt = (block: HyperSightBlock): void => {
    setEditingBlockId(block.id);
    setPromptDraft(block.prompt);
  };

  const commit = async (next: HyperSightBlock[]): Promise<boolean> => {
    setBlocks(next);
    try {
      await onChange(configurationBlocks(next));
      return true;
    } catch {
      setBlocks(hypersight.blocks);
      return false;
    }
  };

  const finishDrag = (): void => {
    if (dragFinishedRef.current) return;
    dragFinishedRef.current = true;
    draggingIdRef.current = null;
    dragImageRef.current?.remove();
    dragImageRef.current = null;
    const changed = blocks.some((block, index) => block.id !== hypersight.blocks[index]?.id);
    setDraggingId(null);
    if (changed) void commit(blocks);
  };

  return (
    <section aria-label="HyperSight" className="hypersight-panel">
      <header className="hypersight-panel-header">
        <div>
          <Sparkles aria-hidden="true" size={14} />
          <h2>HyperSight</h2>
        </div>
        <span>{blocks.length === 1 ? '1 block' : `${blocks.length} blocks`}</span>
      </header>
      <div className="hypersight-panel-scroll">
        <span aria-live="polite" className="sr-only">{reorderAnnouncement}</span>
        <div className="hypersight-block-list">
          {blocks.map((block, blockIndex) => (
            <article
              className={clsx('hypersight-block', draggingId === block.id && 'is-dragging')}
              key={block.id}
              onDragEnter={(event) => {
                event.preventDefault();
                if (!draggingId || draggingId === block.id) return;
                setBlocks((current) => moveBlock(current, draggingId, block.id));
              }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                finishDrag();
              }}
            >
              <div className="hypersight-block-card">
                <HyperSightBlockContent block={block} />
              </div>
              <div className="hypersight-block-controls">
                <IconButton
                  disabled={pending}
                  label={block.prompt ? 'Edit HyperSight prompt' : 'Add HyperSight prompt'}
                  onClick={() => openPrompt(block)}
                >
                  <Sparkles size={15} />
                </IconButton>
                <div className="hypersight-block-hover-controls">
                  <button
                    aria-label="Reorder HyperSight block"
                    aria-keyshortcuts="ArrowUp ArrowDown"
                    className="hypersight-grip"
                    disabled={pending}
                    draggable={!pending}
                    onDragEnd={finishDrag}
                    onDragStart={(event) => {
                      dragFinishedRef.current = false;
                      draggingIdRef.current = block.id;
                      setDraggingId(block.id);
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData('text/plain', block.id);
                      const article = event.currentTarget.closest('.hypersight-block');
                      if (article instanceof HTMLElement) {
                        const ghost = article.cloneNode(true) as HTMLElement;
                        ghost.classList.add('hypersight-drag-ghost');
                        ghost.style.width = `${article.getBoundingClientRect().width}px`;
                        document.body.append(ghost);
                        event.dataTransfer.setDragImage(ghost, 24, 24);
                        dragImageRef.current = ghost;
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                      event.preventDefault();
                      const targetIndex = blockIndex + (event.key === 'ArrowUp' ? -1 : 1);
                      const target = blocks[targetIndex];
                      if (!target) return;
                      const next = moveBlock(blocks, block.id, target.id);
                      setReorderAnnouncement(`Moved block to position ${targetIndex + 1} of ${blocks.length}.`);
                      void commit(next);
                    }}
                    type="button"
                  >
                    <GripVertical aria-hidden="true" size={15} />
                  </button>
                  <IconButton
                    className="hypersight-delete"
                    disabled={pending}
                    label="Delete HyperSight block"
                    onClick={() => void commit(blocks.filter((candidate) => candidate.id !== block.id))}
                  >
                    <Trash2 size={14} />
                  </IconButton>
                </div>
              </div>
            </article>
          ))}
          <button
            className="hypersight-add-block"
            disabled={pending || blocks.length >= 24}
            onClick={() => {
              const block: HyperSightBlock = { id: crypto.randomUUID(), prompt: '', latestRun: null };
              const next = [...blocks, block];
              void commit(next).then((saved) => {
                if (saved) openPrompt(block);
              });
            }}
            type="button"
          >
            <Plus aria-hidden="true" size={15} />
            <span>Add block</span>
          </button>
          {error ? <p className="hypersight-panel-error" role="alert">{error}</p> : null}
        </div>
      </div>
      <Modal
        description="This prompt runs against the current work stream whenever its shared context changes. The result is rendered as Markdown."
        footer={(
          <Button
            className="button-primary"
            disabled={pending || !editingBlockId}
            onClick={() => {
              if (!editingBlockId) return;
              const next = blocks.map((block) => block.id === editingBlockId
                ? { ...block, prompt: promptDraft }
                : block);
              void commit(next).then((saved) => {
                if (saved) setEditingBlockId(null);
              });
            }}
          >
            {pending ? <LoaderCircle aria-hidden="true" className="spin" size={14} /> : <Sparkles aria-hidden="true" size={14} />}
            Save prompt
          </Button>
        )}
        onOpenChange={(open) => {
          if (!open) setEditingBlockId(null);
        }}
        open={editingBlockId !== null}
        title="HyperSight block prompt"
      >
        <label className="hypersight-prompt-field">
          <span>Prompt</span>
          <textarea
            autoFocus
            maxLength={12_000}
            onChange={(event) => setPromptDraft(event.currentTarget.value)}
            placeholder="For example: Give me the last five to-do items."
            rows={7}
            value={promptDraft}
          />
        </label>
      </Modal>
    </section>
  );
}

export function HyperSightResizeHandle({ onResize }: { onResize: (height: number) => void }): React.JSX.Element {
  return (
    <div
      aria-label="Resize HyperSight"
      aria-orientation="horizontal"
      className="hypersight-resizer"
      onPointerDown={(event) => {
        event.preventDefault();
        const startY = event.clientY;
        const panel = event.currentTarget.closest('.hypersight-shell');
        if (!(panel instanceof HTMLElement)) return;
        const startHeight = panel.getBoundingClientRect().height;
        const screen = panel.closest('.workstream-screen');
        const screenHeight = screen instanceof HTMLElement ? screen.getBoundingClientRect().height : window.innerHeight;
        const minimum = screenHeight * 0.18;
        const maximum = screenHeight * 0.58;
        const onMove = (moveEvent: PointerEvent): void => {
          onResize(Math.min(maximum, Math.max(minimum, startHeight + moveEvent.clientY - startY)));
        };
        const onUp = (): void => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          document.body.classList.remove('is-resizing-hypersight');
        };
        document.body.classList.add('is-resizing-hypersight');
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp, { once: true });
      }}
      role="separator"
    >
      <span />
    </div>
  );
}
