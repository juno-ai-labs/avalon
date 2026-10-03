import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { logError } from '../../common/logger';
import { PcmSpeechPlayer } from '../lib/pcm-speech-player';

interface SpeechPlaybackContextValue {
  activeMessageId: string | null;
  speak(messageId: string, markdown: string): void;
  stop(): void;
}

const SpeechPlaybackContext = createContext<SpeechPlaybackContextValue | null>(null);

const createPcmSpeechPlayer = (): SpeechPlayer => new PcmSpeechPlayer();

interface ActivePlayback {
  abort: AbortController;
  messageId: string;
  player: SpeechPlayer;
}

export interface SpeechPlayer {
  play(stream: ReadableStream<Uint8Array>): Promise<void>;
  prepare(): Promise<void>;
  stop(): void;
}

export interface SpeechApi {
  streamMessageSpeech(markdown: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
}

/**
 * One voice for the window. Every `speak` stops whatever is already playing
 * before a new stream starts — the action row and the message-text menu share
 * this mutex, so two clips cannot overlap.
 */
export function SpeechPlaybackProvider({ api, children, createPlayer = createPcmSpeechPlayer }: {
  api: SpeechApi;
  children: React.ReactNode;
  createPlayer?: () => SpeechPlayer;
}): React.JSX.Element {
  const activeRef = useRef<ActivePlayback | null>(null);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);

  const stop = useCallback((): void => {
    const active = activeRef.current;
    if (!active) return;
    activeRef.current = null;
    active.abort.abort('speech playback stopped');
    active.player.stop();
    setActiveMessageId(null);
  }, []);

  const speak = useCallback((messageId: string, markdown: string): void => {
    // The mutex: cancel the active player and its fetch before constructing
    // another AudioContext. A second Speak from any surface rides this path.
    stop();
    const abort = new AbortController();
    // AudioContext construction and resume begin inside the click call stack;
    // awaiting the authenticated fetch first would lose browser activation.
    let player: SpeechPlayer;
    let prepared: Promise<void>;
    try {
      player = createPlayer();
      prepared = player.prepare();
    } catch (error) {
      logError('rally', 'could not start message speech', error);
      return;
    }
    const active = { abort, messageId, player };
    activeRef.current = active;
    setActiveMessageId(messageId);
    void (async () => {
      try {
        const [, stream] = await Promise.all([
          prepared,
          api.streamMessageSpeech(markdown, abort.signal),
        ]);
        await player.play(stream);
      } catch (error) {
        if (!abort.signal.aborted) {
          abort.abort('speech playback failed');
          logError('rally', 'could not speak this message', error);
        }
      } finally {
        if (activeRef.current === active) {
          activeRef.current = null;
          player.stop();
          setActiveMessageId(null);
        }
      }
    })();
  }, [api, createPlayer, stop]);

  useEffect(() => stop, [stop]);

  const value = useMemo(() => ({ activeMessageId, speak, stop }), [activeMessageId, speak, stop]);
  return <SpeechPlaybackContext.Provider value={value}>{children}</SpeechPlaybackContext.Provider>;
}

export function useSpeechPlayback(): SpeechPlaybackContextValue | null {
  return useContext(SpeechPlaybackContext);
}
