import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';

import type { BlockDashboard, BlockDashboardBlock } from '../lib/types';
import type { BlockDashboardBlockConnectionState } from '../lib/use-block-dashboard-sockets';
import { useUiStore } from '../lib/ui-store';
import { Button, IconButton, Modal } from './primitives';
import { Icon } from './ui';
import { RailSurface } from './rail-surface';
import { MarkdownBody } from './workstream-blocks';

interface BlockDashboardPanelProps {
  blockDashboard: BlockDashboard;
  connectionStates?: Readonly<Record<string, BlockDashboardBlockConnectionState>>;
  pending: boolean;
  error?: string;
  onChange: (blocks: Array<{ id: string; prompt: string }>) => Promise<void>;
}

function moveBlock(blocks: BlockDashboardBlock[], sourceId: string, targetId: string): BlockDashboardBlock[] {
  const sourceIndex = blocks.findIndex((block) => block.id === sourceId);
  const targetIndex = blocks.findIndex((block) => block.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return blocks;
  const next = [...blocks];
  const [source] = next.splice(sourceIndex, 1);
  if (!source) return blocks;
  next.splice(targetIndex, 0, source);
  return next;
}

function configurationBlocks(blocks: BlockDashboardBlock[]): Array<{ id: string; prompt: string }> {
  return blocks.map(({ id, prompt }) => ({ id, prompt }));
}

function BlockDashboardBlockContent({
  block,
  connectionState,
}: {
  block: BlockDashboardBlock;
  connectionState?: BlockDashboardBlockConnectionState;
}): React.JSX.Element {
  if (!block.prompt.trim()) {
    return <p className="block-dashboard-block-placeholder">Choose the sparkle to add a prompt.</p>;
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
        <div className="block-dashboard-block-streaming">
          <MarkdownBody>{run.markdown}</MarkdownBody>
          <div
            aria-live="polite"
            className={clsx('block-dashboard-block-stream-status', connectionUnavailable && 'is-error')}
            {...(connectionUnavailable ? { role: 'alert' as const } : {})}
          >
            {connectionUnavailable
              ? <Icon name="warning" size="xs" />
              : <Icon name="spinner" size="xs" spinning />}
            <span>{connectionLabel}</span>
          </div>
        </div>
      );
    }
    return (
      <div
        aria-live="polite"
        className={clsx('block-dashboard-block-state', connectionUnavailable && 'is-error')}
        {...(connectionUnavailable ? { role: 'alert' as const } : {})}
      >
        {connectionUnavailable
          ? <Icon name="warning" size="sm" />
          : <Icon name="spinner" size="sm" spinning />}
        <span>{connectionLabel}</span>
      </div>
    );
  }
  if (run.status === 'failed' || run.status === 'stopped') {
    return (
      <div className="block-dashboard-block-state is-error" role="alert">
        <Icon name="warning" size="sm" />
        <span>{run.error?.message ?? 'This block could not be refreshed.'}</span>
      </div>
    );
  }
  return <MarkdownBody>{run.markdown ?? ''}</MarkdownBody>;
}

export function BlockDashboardPanel({
  blockDashboard,
  connectionStates = {},
  pending,
  error,
  onChange,
}: BlockDashboardPanelProps): React.JSX.Element {
  const [blocks, setBlocks] = useState(blockDashboard.blocks);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
  const [promptDraft, setPromptDraft] = useState('');
  const [reorderAnnouncement, setReorderAnnouncement] = useState('');
  const dragImageRef = useRef<HTMLElement | null>(null);
  const dragFinishedRef = useRef(false);
  const draggingIdRef = useRef<string | null>(null);
  const pendingConfigurationRef = useRef<BlockDashboardBlock[] | null>(null);

  useEffect(() => {
    const optimistic = pendingConfigurationRef.current;
    if (optimistic) {
      const incomingById = new Map(blockDashboard.blocks.map((block) => [block.id, block]));
      const acknowledged = optimistic.length === blockDashboard.blocks.length
        && optimistic.every((block, index) => block.id === blockDashboard.blocks[index]?.id
          && block.prompt === blockDashboard.blocks[index]?.prompt);
      if (acknowledged) pendingConfigurationRef.current = null;
      setBlocks((acknowledged ? blockDashboard.blocks : optimistic).map((block) => {
        const incoming = incomingById.get(block.id);
        return incoming ? { ...block, latestRun: incoming.latestRun } : block;
      }));
      return;
    }
    if (!draggingIdRef.current) {
      setBlocks(blockDashboard.blocks);
      return;
    }
    const incomingById = new Map(blockDashboard.blocks.map((block) => [block.id, block]));
    setBlocks((current) => current.map((block) => {
      const incoming = incomingById.get(block.id);
      return incoming ? { ...block, latestRun: incoming.latestRun } : block;
    }));
  }, [blockDashboard.blocks]);
  useEffect(() => () => dragImageRef.current?.remove(), []);

  const openPrompt = (block: BlockDashboardBlock): void => {
    setEditingBlockId(block.id);
    setPromptDraft(block.prompt);
  };

  const commit = async (next: BlockDashboardBlock[]): Promise<boolean> => {
    pendingConfigurationRef.current = next;
    setBlocks(next);
    try {
      await onChange(configurationBlocks(next));
      return true;
    } catch {
      pendingConfigurationRef.current = null;
      setBlocks(blockDashboard.blocks);
      return false;
    }
  };

  const finishDrag = (dropped: boolean): void => {
    if (dragFinishedRef.current) return;
    dragFinishedRef.current = true;
    draggingIdRef.current = null;
    dragImageRef.current?.remove();
    dragImageRef.current = null;
    const changed = blocks.some((block, index) => block.id !== blockDashboard.blocks[index]?.id);
    setDraggingId(null);
    if (dropped && changed) void commit(blocks);
    else if (!dropped) setBlocks(pendingConfigurationRef.current ?? blockDashboard.blocks);
  };

  return (
    <section aria-label="HyperSight blocks" className="block-dashboard-panel">
      <span aria-live="polite" className="sr-only">{reorderAnnouncement}</span>
      <div className="block-dashboard-block-list">
        {blocks.map((block, blockIndex) => (
          <article
            className={clsx('block-dashboard-block', draggingId === block.id && 'is-dragging')}
            key={block.id}
            onDragEnter={(event) => {
              event.preventDefault();
              if (!draggingId || draggingId === block.id) return;
              setBlocks((current) => moveBlock(current, draggingId, block.id));
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              finishDrag(true);
            }}
          >
            <div className="block-dashboard-block-card">
              <BlockDashboardBlockContent block={block} connectionState={connectionStates[block.id]} />
            </div>
            <div className="block-dashboard-block-controls">
              <IconButton
                disabled={pending}
                label={block.prompt ? 'Edit HyperSight prompt' : 'Add HyperSight prompt'}
                onClick={() => openPrompt(block)}
              >
                <Icon name="suggestion" size="md" />
              </IconButton>
              <div className="block-dashboard-block-hover-controls">
                <button
                  aria-label="Reorder HyperSight block"
                  aria-keyshortcuts="ArrowUp ArrowDown"
                  className="block-dashboard-grip"
                  disabled={pending}
                  draggable={!pending}
                  onDragEnd={() => finishDrag(false)}
                  onDragStart={(event) => {
                    dragFinishedRef.current = false;
                    draggingIdRef.current = block.id;
                    setDraggingId(block.id);
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', block.id);
                    const article = event.currentTarget.closest('.block-dashboard-block');
                    if (article instanceof HTMLElement) {
                      const ghost = article.cloneNode(true) as HTMLElement;
                      ghost.classList.add('block-dashboard-drag-ghost');
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
                  <Icon name="drag-handle" size="md" />
                </button>
                <IconButton
                  className="block-dashboard-delete"
                  disabled={pending}
                  label="Delete HyperSight block"
                  onClick={() => void commit(blocks.filter((candidate) => candidate.id !== block.id))}
                >
                  <Icon name="trash" size="sm" />
                </IconButton>
              </div>
            </div>
          </article>
        ))}
        <button
          className="block-dashboard-add-block"
          disabled={pending || blocks.length >= 24}
          onClick={() => {
            const block: BlockDashboardBlock = { id: crypto.randomUUID(), prompt: '', latestRun: null };
            const next = [...blocks, block];
            void commit(next).then((saved) => {
              if (saved) openPrompt(block);
            });
          }}
          type="button"
        >
          <Icon name="add" size="md" />
          <span>Add block</span>
        </button>
        {error ? <p className="block-dashboard-panel-error" role="alert">{error}</p> : null}
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
            {pending ? <Icon name="spinner" size="sm" spinning /> : <Icon name="suggestion" size="sm" />}
            Save prompt
          </Button>
        )}
        onOpenChange={(open) => {
          if (!open) setEditingBlockId(null);
        }}
        open={editingBlockId !== null}
        title="HyperSight block prompt"
      >
        <label className="block-dashboard-prompt-field">
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
export function BlockDashboardRail({
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
  const width = useUiStore((state) => state.blockDashboardWidth);
  const setWidth = useUiStore((state) => state.setBlockDashboardWidth);

  return (
    <RailSurface
      className="block-dashboard-rail"
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
          <span aria-hidden="true" className="block-dashboard-rail-icon"><Icon name="dashboard" size="md" /></span>
          <h2>HyperSight</h2>
          <span className="block-dashboard-block-count">{blockCount === 1 ? '1 block' : `${blockCount} blocks`}</span>
        </div>
        <div className="rail-header-actions window-no-drag">
          <IconButton label="Close HyperSight" onClick={onClose}><Icon name="close" size="md" /></IconButton>
        </div>
      </header>
      <div className="rail-scroll">{children}</div>
    </RailSurface>
  );
}
