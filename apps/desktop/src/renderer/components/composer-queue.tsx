import clsx from 'clsx';
import { GripVertical } from 'lucide-react';
import { useRef, useState } from 'react';
import type { Message, WorkspaceMember } from '../lib/types';
import { Avatar } from './primitives';

export interface ComposerQueueItem {
  key: string;
  /** Server pending-input id. Null while the send is still optimistic. */
  inputId: string | null;
  text: string;
  member: WorkspaceMember;
  sending: boolean;
}

interface ComposerQueueProps {
  items: ComposerQueueItem[];
  onReorder: (inputIds: string[]) => Promise<void>;
}

const PENDING_INPUT_DRAG_TYPE = 'application/x-rally-pending-input-id';

/** `ids` with `id` lifted out and reinserted at `index`. */
export function moveWithin(ids: string[], id: string, index: number): string[] {
  const without = ids.filter((candidate) => candidate !== id);
  const bounded = Math.max(0, Math.min(index, without.length));
  return [...without.slice(0, bounded), id, ...without.slice(bounded)];
}

/**
 * Resolve the author disc for a queued row. The roster is preferred so a
 * later avatar change is visible; the message snapshot is the fallback when
 * that person is no longer a member or the row is an external actor.
 */
export function queueAuthorMember(
  message: Message,
  members: readonly WorkspaceMember[],
): WorkspaceMember {
  if (message.author?.id) {
    const roster = members.find((member) => member.id === message.author?.id);
    if (roster) return roster;
    return {
      id: message.author.id,
      name: message.author.name,
      email: message.author.email ?? '',
      timezone: message.author.timezone ?? 'UTC',
      ...(message.author.avatarUrl ? { avatarUrl: message.author.avatarUrl } : {}),
    };
  }
  if (message.externalActor) {
    return {
      id: message.externalActor.providerUserId,
      name: message.externalActor.displayName,
      email: '',
      timezone: 'UTC',
      ...(message.externalActor.avatarUrl ? { avatarUrl: message.externalActor.avatarUrl } : {}),
    };
  }
  return { id: message.id, name: 'Someone', email: '', timezone: 'UTC' };
}

export function ComposerQueue({ items, onReorder }: ComposerQueueProps): React.JSX.Element | null {
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const draggingIdRef = useRef<string | null>(null);
  const dragOrderRef = useRef<string[] | null>(null);
  dragOrderRef.current = dragOrder;

  const draggableIds = items.flatMap((item) => item.inputId ? [item.inputId] : []);
  const orderedIds = dragOrder ?? draggableIds;
  const byId = new Map(items.map((item) => [item.inputId ?? item.key, item]));
  const sending = items.filter((item) => item.inputId === null);
  const orderedDraggable = orderedIds.flatMap((id) => {
    const item = byId.get(id);
    return item && item.inputId ? [item] : [];
  });
  const seen = new Set(orderedDraggable.map((item) => item.inputId));
  const visible = [
    ...orderedDraggable,
    ...items.filter((item) => item.inputId && !seen.has(item.inputId)),
    ...sending,
  ];

  if (visible.length === 0) return null;

  const storedOrder = draggableIds.join();
  const commit = async (order: string[]): Promise<void> => {
    setDragOrder(order);
    try {
      await onReorder(order);
    } finally {
      setDragOrder((current) => current === order ? null : current);
    }
  };

  return (
    <ol
      aria-label="Queued messages"
      className="composer-queue"
      onDragOver={(event) => {
        if (draggingIdRef.current === null) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      }}
    >
      {visible.map((item, index) => {
        const draggable = item.inputId !== null;
        const preview = item.text.trim() || (item.sending ? 'Sending…' : 'Queued message');
        return (
          <li
            className={clsx(
              'composer-queue-row',
              draggingIdRef.current === item.inputId && dragOrder !== null && 'is-dragging',
              item.sending && 'is-sending',
            )}
            key={item.key}
            onDragOver={(event) => {
              const targetId = item.inputId;
              if (!targetId || draggingIdRef.current === null) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              const draggingId = draggingIdRef.current;
              if (draggingId === targetId) return;
              setDragOrder((current) => {
                const order = current ?? draggableIds;
                const targetIndex = order.indexOf(targetId);
                if (targetIndex < 0 || order.indexOf(draggingId) === targetIndex) return order;
                return moveWithin(order, draggingId, targetIndex);
              });
            }}
          >
            <button
              aria-keyshortcuts="ArrowUp ArrowDown"
              aria-label={`Reorder queued message: ${preview}`}
              className="composer-queue-grip"
              disabled={!draggable}
              draggable={draggable}
              onDragEnd={(event) => {
                const order = dragOrderRef.current;
                draggingIdRef.current = null;
                if (order === null) return;
                const cancelled = (event.dataTransfer?.dropEffect ?? 'none') === 'none';
                if (cancelled || order.join() === storedOrder) {
                  setDragOrder(null);
                  return;
                }
                void commit(order);
              }}
              onDragStart={(event) => {
                if (!item.inputId) {
                  event.preventDefault();
                  return;
                }
                draggingIdRef.current = item.inputId;
                setDragOrder(draggableIds);
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', item.inputId);
                event.dataTransfer.setData(PENDING_INPUT_DRAG_TYPE, item.inputId);
              }}
              onKeyDown={(event) => {
                if (!item.inputId) return;
                if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                event.preventDefault();
                const order = draggableIds;
                const from = order.indexOf(item.inputId);
                const to = from + (event.key === 'ArrowUp' ? -1 : 1);
                if (from < 0 || to < 0 || to >= order.length) return;
                void commit(moveWithin(order, item.inputId, to));
              }}
              type="button"
            >
              <GripVertical aria-hidden="true" size={14} />
            </button>
            <span aria-hidden="true" className="composer-queue-avatar">
              <Avatar member={item.member} size="small" title={item.member.name} />
            </span>
            <span className="composer-queue-text">{preview}</span>
            <span className="sr-only">{`${item.member.name}, ${index + 1} of ${visible.length}`}</span>
          </li>
        );
      })}
    </ol>
  );
}
