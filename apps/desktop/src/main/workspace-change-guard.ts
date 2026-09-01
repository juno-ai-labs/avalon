/** Main-process ownership of meeting captures that forbid changing workspace. */
export class WorkspaceChangeGuard {
  readonly #recordingWorkspaces = new Map<number, string>();

  recordingChanged(windowId: number, workspaceId: string, recording: boolean): void {
    if (recording) this.#recordingWorkspaces.set(windowId, workspaceId);
    else this.#recordingWorkspaces.delete(windowId);
  }

  windowClosed(windowId: number): void {
    this.#recordingWorkspaces.delete(windowId);
  }

  blocksChangeFrom(currentWorkspaceId: string | null, targetWorkspaceId?: string): boolean {
    if (!currentWorkspaceId || targetWorkspaceId === currentWorkspaceId) return false;
    return [...this.#recordingWorkspaces.values()].some((workspaceId) => workspaceId === currentWorkspaceId);
  }
}
