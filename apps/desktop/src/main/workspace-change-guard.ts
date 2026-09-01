/** Main-process ownership of meeting captures that forbid changing workspace. */
export class WorkspaceChangeGuard {
  readonly #recordingWorkspaces = new Map<number, string>();

  recordingChanged(windowId: number, workspaceKey: string, recording: boolean): void {
    if (recording) this.#recordingWorkspaces.set(windowId, workspaceKey);
    else this.#recordingWorkspaces.delete(windowId);
  }

  windowClosed(windowId: number): void {
    this.#recordingWorkspaces.delete(windowId);
  }

  blocksChangeFrom(currentWorkspaceKey: string | null, targetWorkspaceKey?: string): boolean {
    if (!currentWorkspaceKey || targetWorkspaceKey === currentWorkspaceKey) return false;
    return [...this.#recordingWorkspaces.values()].some((workspaceKey) => workspaceKey === currentWorkspaceKey);
  }
}
