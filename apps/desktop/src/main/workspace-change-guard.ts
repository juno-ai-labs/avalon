/** Main-process ownership of meeting captures that forbid changing workspace. */
export class WorkspaceChangeGuard {
  readonly #recordingWorkspaces = new Map<number, string>();
  readonly #pendingChanges = new Map<number, string>();
  #nextChangeId = 1;

  recordingChanged(windowId: number, workspaceKey: string, recording: boolean): void {
    if (recording && [...this.#pendingChanges.values()].some((pending) => pending === workspaceKey)) {
      throw new Error('Wait for Rally to finish changing workspaces before starting the recording');
    }
    if (recording) this.#recordingWorkspaces.set(windowId, workspaceKey);
    else this.#recordingWorkspaces.delete(windowId);
  }

  beginChange(currentWorkspaceKey: string | null, targetWorkspaceKey?: string): number | null {
    if (!currentWorkspaceKey || targetWorkspaceKey === currentWorkspaceKey) return null;
    if (this.blocksChangeFrom(currentWorkspaceKey, targetWorkspaceKey)) {
      throw new Error('Finish or stop the recording before switching workspaces');
    }
    const changeId = this.#nextChangeId;
    this.#nextChangeId += 1;
    this.#pendingChanges.set(changeId, currentWorkspaceKey);
    return changeId;
  }

  finishChange(changeId: number | null): void {
    if (changeId !== null) this.#pendingChanges.delete(changeId);
  }

  windowClosed(windowId: number): void {
    this.#recordingWorkspaces.delete(windowId);
  }

  blocksChangeFrom(currentWorkspaceKey: string | null, targetWorkspaceKey?: string): boolean {
    if (!currentWorkspaceKey || targetWorkspaceKey === currentWorkspaceKey) return false;
    return [...this.#recordingWorkspaces.values()].some((workspaceKey) => workspaceKey === currentWorkspaceKey);
  }
}
