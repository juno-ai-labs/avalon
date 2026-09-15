import type { InferenceDelayState } from '@rally/contracts';
import { createContext, useContext, useRef, type PropsWithChildren } from 'react';

export interface StreamCursor {
  /** Groups transient model turns emitted by one run; never a durable turn ID. */
  readonly streamId: string;
  readonly turnId: string;
  readonly epoch: number;
  readonly streamSeq: number;
  readonly seenTurnIds: ReadonlySet<string>;
  readonly turnStartText: string;
  readonly roomSequence: number;
  readonly completed: boolean;
  /**
   * Everything the wire has delivered for this message, including what the
   * paced reveal has not shown yet. The transcript cache holds the revealed
   * prefix; this is the whole. See `streaming-reveal.ts`.
   */
  readonly receivedText: string;
  /**
   * How many characters of `receivedText` are on screen. Mutable because the
   * reveal loop advances it once per animation frame, between the immutable
   * cursor replacements the socket events perform.
   */
  revealed: number;
  /** Mutable frontend arrival estimate and fractional draw credit, shared across subscribers. */
  pacing?: {
    /** Null while drained: provider idle time must not train the estimator. */
    lastArrivalAt: number | null;
    cadenceMs: number;
    rate: number;
    drawRate: number;
    pendingCharacters: number;
    credit: number;
  };
  /** When the reveal loop last advanced this message, for rate integration. */
  lastRevealAt: number | null;
}

export interface WorkstreamSocketResumeState {
  lastSequence: number;
  activeInferenceDelays: InferenceDelayState[];
  readonly streamCursors: Map<string, StreamCursor>;
}

type WorkstreamSocketResumeRegistry = Map<string, WorkstreamSocketResumeState>;

const WorkstreamSocketResumeContext = createContext<WorkstreamSocketResumeRegistry | null>(null);

/**
 * Keeps ephemeral room and Bind cursors for one signed-in workspace. The scope
 * changes whenever the user or workspace changes, so a sequence learned under
 * one authorization boundary can never be offered under another one.
 */
export function WorkstreamSocketResumeProvider({
  children,
  scope,
}: PropsWithChildren<{ scope: string }>): React.JSX.Element {
  const scopedRegistry = useRef<{
    scope: string;
    registry: WorkstreamSocketResumeRegistry;
  } | null>(null);
  if (scopedRegistry.current?.scope !== scope) {
    scopedRegistry.current = { scope, registry: new Map() };
  }
  return (
    <WorkstreamSocketResumeContext.Provider value={scopedRegistry.current.registry}>
      {children}
    </WorkstreamSocketResumeContext.Provider>
  );
}

/**
 * A provider shares resume state across the foreground screen and the shell's
 * background subscriber. The local registry preserves the old standalone-hook
 * behavior for isolated consumers and unit tests.
 */
export function useWorkstreamSocketResumeState(
  parentId: string,
  substreamId = '0',
): WorkstreamSocketResumeState {
  const sharedRegistry = useContext(WorkstreamSocketResumeContext);
  const localRegistry = useRef<WorkstreamSocketResumeRegistry>(new Map());
  const registry = sharedRegistry ?? localRegistry.current;
  const key = `${parentId}:${substreamId}`;
  let resumeState = registry.get(key);
  if (!resumeState) {
    resumeState = { lastSequence: 0, activeInferenceDelays: [], streamCursors: new Map() };
    registry.set(key, resumeState);
  }
  return resumeState;
}
