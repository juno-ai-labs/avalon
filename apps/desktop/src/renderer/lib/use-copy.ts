import { useCallback, useEffect, useRef, useState } from 'react';
import { desktopBridge } from './platform';

/** What a copy control is showing: its glyph, its name, and its live-region line all read this. */
export type CopyState = 'idle' | 'copied' | 'failed';

/**
 * How long a control shows the outcome of a copy before returning to its idle
 * glyph. Long enough to be seen by someone looking at the button they just
 * pressed; short enough that a second copy from the same control reads as a
 * second event rather than the first one still showing.
 */
export const COPY_FEEDBACK_MS = 2_000;

export interface UseCopyOptions {
  /** The clipboard to write to. The desktop bridge unless a surface carries its own. */
  copyText?: ((text: string) => Promise<void>) | undefined;
  /** Runs once the write has succeeded, which is where a caller reports telemetry. */
  onCopied?: (() => void) | undefined;
  /** What lands on the clipboard. A function for a value fetched or built on demand. */
  value: string | (() => string | Promise<string>);
}

export interface UseCopyResult {
  /** Writes the value and settles into `copied` or `failed`; never rejects. */
  copy: () => Promise<void>;
  state: CopyState;
  /** A new identity for each rejected write, so an acknowledged failure can reopen on retry. */
  failureOccurrence: object | undefined;
}

const writeThroughBridge = (text: string): Promise<void> => desktopBridge().copyText(text);

/**
 * The one copy-to-clipboard behaviour, shared by every control that offers one.
 *
 * A copy has three outcomes a person needs to see — it worked, it did not, and
 * nothing has happened yet — and every control used to keep its own version of
 * that state, each with its own timer and its own idea of how long "copied"
 * lasts. This holds the state once: the write, the success and failure it
 * settles into, and the timer that returns the control to idle. The failure is
 * a state rather than a rejection because the clipboard refuses often enough
 * (an unfocused window, a denied permission) that a control has to be able to
 * say so and offer the same click again.
 */
export function useCopy({ copyText, onCopied, value }: UseCopyOptions): UseCopyResult {
  const [feedback, setFeedback] = useState<{ state: CopyState; failureOccurrence: object | undefined }>({
    state: 'idle', failureOccurrence: undefined,
  });
  // Read at click time rather than closed over, so `copy` keeps one identity
  // while the value or the telemetry it reports changes underneath it.
  const options = useRef<UseCopyOptions>({ copyText, onCopied, value });
  useEffect(() => {
    options.current = { copyText, onCopied, value };
  });
  const reset = useRef<number | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (reset.current !== null) window.clearTimeout(reset.current);
    };
  }, []);

  const copy = useCallback(async (): Promise<void> => {
    const { copyText: write = writeThroughBridge, onCopied: copied, value: source } = options.current;
    if (reset.current !== null) {
      window.clearTimeout(reset.current);
      reset.current = null;
    }
    let outcome: CopyState;
    try {
      await write(typeof source === 'function' ? await source() : source);
      outcome = 'copied';
    } catch {
      outcome = 'failed';
    }
    if (!mounted.current) return;
    setFeedback({ state: outcome, failureOccurrence: outcome === 'failed' ? {} : undefined });
    if (outcome === 'copied') copied?.();
    reset.current = window.setTimeout(() => {
      reset.current = null;
      if (mounted.current) setFeedback({ state: 'idle', failureOccurrence: undefined });
    }, COPY_FEEDBACK_MS);
  }, []);

  return { copy, ...feedback };
}
