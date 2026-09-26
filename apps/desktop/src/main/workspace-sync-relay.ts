import {
  parseWorkspaceSyncPublication,
  type WorkspaceSyncRelayEvent,
  type WorkspaceSyncSourceSnapshot,
} from '../common/workspace-sync-relay';

/**
 * Main's half of the Organization-sync relay: which window's socket is being
 * relayed, and the hop from that window to the one consuming it.
 *
 * No Electron import. `index.ts` decides who may publish (the main window
 * only), who receives (the Settings window only), and when the source is gone
 * (the main window closing, crashing or reloading); this class holds the one
 * piece of state those decisions share.
 *
 * The source is the main window's *renderer*, attached by its first `state`
 * publication and held until main releases it. It is deliberately not detached
 * when the renderer's provider unmounts: that happens on every Organization
 * switch, immediately followed by the next provider's own `state`, and a
 * detach between the two would have the Settings window dial a socket of its
 * own for the few milliseconds in between.
 */
export class WorkspaceSyncRelay {
  private current: WorkspaceSyncSourceSnapshot = { revision: 0, source: null };

  constructor(private readonly deliver: (event: WorkspaceSyncRelayEvent) => void) {}

  snapshot(): WorkspaceSyncSourceSnapshot {
    return this.current;
  }

  /** Throws, naming the field, on a publication main cannot read. */
  publish(raw: unknown): void {
    const parsed = parseWorkspaceSyncPublication(raw);
    if (!parsed.ok) throw new Error(`Blocked workspace sync publication: invalid ${parsed.field}`);
    const publication = parsed.value;
    if (publication.type === 'state') {
      const source = this.current.source;
      if (source?.workspaceId === publication.workspaceId && source.state === publication.state) return;
      this.replace({ workspaceId: publication.workspaceId, state: publication.state });
      return;
    }
    // News about an Organization nobody is attached for cannot be ordered
    // against anything the consumer holds, so it goes nowhere.
    if (this.current.source?.workspaceId !== publication.workspaceId) return;
    this.deliver(publication);
  }

  /** The publishing renderer is gone: closed, crashed, or navigating away. */
  release(): void {
    if (this.current.source !== null) this.replace(null);
  }

  /**
   * The session moved to another Organization (or ended). The main window
   * republishes for the new one as soon as its provider mounts; until then the
   * old attachment describes a socket that no longer serves this session.
   */
  releaseUnless(workspaceId: string | null): void {
    if (this.current.source !== null && this.current.source.workspaceId !== workspaceId) this.replace(null);
  }

  private replace(source: WorkspaceSyncSourceSnapshot['source']): void {
    this.current = { revision: this.current.revision + 1, source };
    this.deliver({ type: 'source', ...this.current });
  }
}
