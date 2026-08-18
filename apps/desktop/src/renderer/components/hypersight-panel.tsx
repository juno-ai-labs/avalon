import { IconAugmentedReality } from '@tabler/icons-react';
import clsx from 'clsx';
import { AlertTriangle, GripVertical, LoaderCircle, Plus, Sparkles, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { HyperSight, HyperSightBlock } from '../lib/types';
import type { HyperSightBlockConnectionState } from '../lib/use-hypersight-block-sockets';
import { useUiStore } from '../lib/ui-store';
import { Button, IconButton, Modal } from './primitives';
import { RailSurface } from './rail-surface';
import { MarkdownBody } from './workstream-blocks';

interface HyperSightPanelProps {
  hypersight: HyperSight;
  connectionStates?: Readonly<Record<string, HyperSightBlockConnectionState>>;
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

function HyperSightBlockContent({
  block,
  connectionState,
}: {
  block: HyperSightBlock;
  connectionState?: HyperSightBlockConnectionState;
}): React.JSX.Element {
  if (!block.prompt.trim()) {
    return <p className="hypersight-block-placeholder">Choose the sparkle to add a prompt.</p>;
  }
  const run = block.latestRun;
  if (!run || run.status === 'queued' || run.status === 'running') {
    const connectionLabel = connectionState === 'revoked'
      ? 'Live updates unavailable.'
      : connectionState === 'offline'
        ? 'Waiting for a connection…'
        : connectionState === 'reconnecting'
          ? 'Reconnecting live updates…'
          : connectionState === 'connecting'
            ? 'Connecting live updates…'
            : run?.status === 'queued'
              ? 'Waiting to refresh…'
              : 'Refreshing…';
    const connectionUnavailable = connectionState === 'revoked';
    if (run?.status === 'running' && run.markdown?.trim()) {
      return (
        <div className="hypersight-block-streaming">
          <MarkdownBody>{run.markdown}</MarkdownBody>
          <div
            aria-live="polite"
            className={clsx('hypersight-block-stream-status', connectionUnavailable && 'is-error')}
            {...(connectionUnavailable ? { role: 'alert' as const } : {})}
          >
            {connectionUnavailable
              ? <AlertTriangle aria-hidden="true" size={12} />
              : <LoaderCircle aria-hidden="true" className="spin" size={12} />}
            <span>{connectionLabel}</span>
          </div>
        </div>
      );
    }
    return (
      <div
        aria-live="polite"
        className={clsx('hypersight-block-state', connectionUnavailable && 'is-error')}
        {...(connectionUnavailable ? { role: 'alert' as const } : {})}
      >
        {connectionUnavailable
          ? <AlertTriangle aria-hidden="true" size={14} />
          : <LoaderCircle aria-hidden="true" className="spin" size={14} />}
        <span>{connectionLabel}</span>
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
  connectionStates = {},
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
    <section aria-label="HyperSight blocks" className="hypersight-panel">
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
              <HyperSightBlockContent block={block} connectionState={connectionStates[block.id]} />
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

/**
 * HyperSight's right sidebar. It shares the inspector rail's slot, geometry,
 * and grab handle: only one of the two is ever open, so they can be laid out as
 * one panel that changes contents.
 */
export function HyperSightRail({
  blockCount,
  children,
  leaving,
  onClose,
}: {
  blockCount: number;
  children: React.ReactNode;
  /** True while HyperSight is fading out under the inspector taking the slot. */
  leaving?: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const width = useUiStore((state) => state.hypersightWidth);
  const setWidth = useUiStore((state) => state.setHyperSightWidth);

  return (
    <RailSurface
      className="hypersight-rail"
      label="HyperSight"
      leaving={leaving}
      onClose={onClose}
      onResize={setWidth}
      resizeLabel="Resize HyperSight"
      // Distinct from the header's control so the two do not read as one
      // repeated button when a screen reader lists them.
      scrimLabel="Dismiss HyperSight"
      width={width}
    >
      <header className="rail-header window-drag">
        <div className="rail-title window-no-drag">
          <span aria-hidden="true" className="hypersight-rail-icon"><IconAugmentedReality size={15} stroke={1.7} /></span>
          <h2>HyperSight</h2>
          <span className="hypersight-block-count">{blockCount === 1 ? '1 block' : `${blockCount} blocks`}</span>
        </div>
        <div className="rail-header-actions window-no-drag">
          <IconButton label="Close HyperSight" onClick={onClose}><X size={15} /></IconButton>
        </div>
      </header>
      <div className="rail-scroll">{children}</div>
    </RailSurface>
  );
}
