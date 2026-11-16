interface Pending<Canvas, Artifact> { userId: string; workspaceId: string; canvas: Canvas; sent: boolean; resolve: (artifact: Artifact | null) => void }

/** Fresh-access requests that Home answers over its bridge.
 *
 * A request waits while Home is unavailable instead of failing, and a Home
 * reload re-sends what the old page never answered. Only a real end (sign-out,
 * an account or organization change, a failed Home load) resolves with null. */
export function preparedRequests<Canvas, Artifact>(send: (command: { type: 'open-prepared-artifact'; requestId: string; userId: string; workspaceId: string; canvas: Canvas }) => void) {
  const pending = new Map<string, Pending<Canvas, Artifact>>();
  let available: string | null = null;
  const flush = () => {
    for (const [requestId, request] of pending) {
      if (request.sent || available !== `${request.userId}:${request.workspaceId}`) continue;
      request.sent = true;
      send({ type: 'open-prepared-artifact', requestId, userId: request.userId, workspaceId: request.workspaceId, canvas: request.canvas });
    }
  };
  return {
    open(requestId: string, userId: string, workspaceId: string, canvas: Canvas) {
      return new Promise<Artifact | null>((resolve) => {
        pending.set(requestId, { userId, workspaceId, canvas, sent: false, resolve });
        flush();
      });
    },
    /** The `userId:workspaceId` Home can answer for, or null while it loads. */
    setAvailable(scope: string | null) { available = scope; flush(); },
    /** Home's page is being replaced; its unanswered requests died with it. */
    reload() {
      available = null;
      for (const request of pending.values()) request.sent = false;
    },
    reply(requestId: string, artifact: Artifact | null, scope: string | null) {
      const request = pending.get(requestId);
      if (!request) return;
      pending.delete(requestId);
      request.resolve(scope === `${request.userId}:${request.workspaceId}` ? artifact : null);
    },
    cancel() {
      for (const request of pending.values()) request.resolve(null);
      pending.clear();
    },
  };
}
