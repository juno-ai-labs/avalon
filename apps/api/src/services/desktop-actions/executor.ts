import type { DesktopAction, DesktopActionOutcome } from "@rally/contracts/desktop-actions";

/**
 * Ask the person's desktop to do one thing and wait for its answer.
 *
 * Installed by the `AgentLoopDO` a run executes in. The request is durable
 * before it is published: a call re-entered after eviction with the same
 * `toolCallId` returns the answer its earlier attempt received, or asks again
 * if none came. Resolves when the desktop answers; rejects only when `signal`
 * aborts (the run stopped or the tool's deadline passed).
 */
export type DesktopActionExecutor = (input: {
  runId: string;
  toolCallId: string;
  action: DesktopAction;
  signal: AbortSignal;
}) => Promise<DesktopActionOutcome>;
