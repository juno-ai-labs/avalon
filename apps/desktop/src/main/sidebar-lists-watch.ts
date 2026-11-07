import {
  safeParseSocketEvent,
  WorkspaceCanvasListEventSchema,
  WorkspaceSidebarListEventSchema,
  WorkspaceSocketSyncEventSchema,
  type CanvasSidebarRow,
} from '@rally/contracts';
import type { WorkspaceSocketWatchDependencies } from '@rally/contracts/workspace-reach-watch';
import { describeZodIssues } from '@rally/contracts/zod-diagnostics';

/** One Sidekick as the menu bar reads it, and nothing it does not draw. */
export interface ListedSidekick {
  readonly id: string;
  readonly name: string;
  readonly needsInput: boolean;
  readonly unread: boolean;
}

/** One Canvas as the menu bar reads it. */
export interface ListedCanvas {
  readonly id: string;
  readonly title: string;
  readonly unread: boolean;
  readonly updatedAt: string;
}

/**
 * The two lists the main process holds: `null` until the socket has said, so
 * an empty list is "none" only once it has arrived.
 */
export interface SidebarListsSnapshot {
  readonly canvases: readonly ListedCanvas[] | null;
  readonly sidekicks: readonly ListedSidekick[] | null;
}

export const emptySidebarListsSnapshot: SidebarListsSnapshot = { canvases: null, sidekicks: null };

/** The transport half: `watchWorkspaceSocket` with the ticket and dialler already bound. */
export type SidebarListsSocket = (
  handlers: Pick<WorkspaceSocketWatchDependencies, 'onSubscribed' | 'onMessage'>,
) => () => void;

export interface SidebarListsWatchDependencies {
  readonly socket: SidebarListsSocket;
  /** Called after any change to the snapshot, coalesced to one call per microtask. */
  readonly onChange: () => void;
  readonly logWarning: (message: string, error: unknown) => void;
}

function canvasRow(row: CanvasSidebarRow): ListedCanvas {
  return { id: row.id, title: row.title, unread: row.unread, updatedAt: row.updatedAt };
}

function sidekickRow(row: { id: string; name: string; needsInput?: boolean | undefined; unread?: boolean | undefined }): ListedSidekick {
  return { id: row.id, name: row.name, needsInput: row.needsInput === true, unread: row.unread === true };
}

/**
 * The Canvases and Sidekicks lists, held by the main process over a workspace
 * socket of its own, so the menu bar's count and rows are the sidebar's
 * whether or not a window exists. The same frames the renderer's socket
 * applies: the subscribe answer's `sidebar`, then each pushed
 * `workspace_canvas_list` and `workspace_sidebar_list` (`automations`), each
 * applied only when its waterline is newer than the one held.
 */
export class SidebarListsWatch {
  private canvases: readonly ListedCanvas[] | null = null;
  private sidekicks: readonly ListedSidekick[] | null = null;
  private canvasWaterline = -1;
  private sidekickWaterline = -1;
  private stopSocket: (() => void) | null = null;
  private changeQueued = false;

  constructor(private readonly dependencies: SidebarListsWatchDependencies) {}

  /** Opens the socket. A second call while running does nothing. */
  start(): void {
    if (this.stopSocket) return;
    this.stopSocket = this.dependencies.socket({
      onSubscribed: (answer) => { this.subscribed(answer); },
      onMessage: (message) => { this.message(message); },
    });
  }

  /** Closes the socket and forgets both lists. */
  stop(): void {
    const stop = this.stopSocket;
    this.stopSocket = null;
    stop?.();
    this.canvases = null;
    this.sidekicks = null;
    this.canvasWaterline = -1;
    this.sidekickWaterline = -1;
    this.changed();
  }

  running(): boolean {
    return this.stopSocket !== null;
  }

  snapshot(): SidebarListsSnapshot {
    return { canvases: this.canvases, sidekicks: this.sidekicks };
  }

  private changed(): void {
    if (this.changeQueued) return;
    this.changeQueued = true;
    queueMicrotask(() => {
      this.changeQueued = false;
      this.dependencies.onChange();
    });
  }

  private subscribed(answer: unknown): void {
    const parsed = safeParseSocketEvent(WorkspaceSocketSyncEventSchema, answer);
    const sidebar = parsed.success ? parsed.data.sidebar : undefined;
    if (!sidebar) {
      this.dependencies.logWarning(
        'could not read the subscribe answer for the menu bar',
        parsed.success ? new Error('subscribe_answer_without_sidebar') : new Error(describeZodIssues(parsed.error)),
      );
      return;
    }
    // A subscribe answer is the whole of both lists, whatever was held: the
    // socket may have been away while a push moved either one.
    this.sidekicks = sidebar.automations.items.map(sidekickRow);
    this.sidekickWaterline = sidebar.automations.waterline;
    if (sidebar.canvases) {
      this.canvases = sidebar.canvases.items.map(canvasRow);
      this.canvasWaterline = sidebar.canvases.waterline;
    }
    this.changed();
  }

  private message(message: unknown): void {
    const canvasList = safeParseSocketEvent(WorkspaceCanvasListEventSchema, message);
    if (canvasList.success) {
      if (canvasList.data.waterline <= this.canvasWaterline) return;
      this.canvasWaterline = canvasList.data.waterline;
      this.canvases = canvasList.data.items.map(canvasRow);
      this.changed();
      return;
    }
    const sidebarList = safeParseSocketEvent(WorkspaceSidebarListEventSchema, message);
    if (sidebarList.success && sidebarList.data.list === 'automations') {
      if (sidebarList.data.waterline <= this.sidekickWaterline) return;
      this.sidekickWaterline = sidebarList.data.waterline;
      this.sidekicks = sidebarList.data.items.map(sidekickRow);
      this.changed();
    }
  }
}
