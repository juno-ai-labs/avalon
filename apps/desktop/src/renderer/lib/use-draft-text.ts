import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef, useState } from 'react';
import type { MentionIdentity } from './api';
import { readDraftText, writeDraftText } from './draft-cache';

/** Long enough that a typing burst is one write, short enough to survive a quit. */
const SAVE_DEBOUNCE_MS = 250;

/** One shared empty list, so resetting an already-empty draft renders nothing. */
const NO_MENTIONS: MentionIdentity[] = [];

interface DraftSnapshot {
  draftKey: string;
  text: string;
  mentions: MentionIdentity[];
}

export interface DraftText {
  text: string;
  setText: Dispatch<SetStateAction<string>>;
  mentions: MentionIdentity[];
  setMentions: Dispatch<SetStateAction<MentionIdentity[]>>;
}

/**
 * Backs a composer's text — and the mentions the user picked for it — with the
 * local draft cache under `draftKey`. Clearing the composer clears the cache,
 * so an emptied input never comes back on the next visit.
 */
export function useDraftText(draftKey: string): DraftText {
  const [text, setTextState] = useState('');
  const [mentions, setMentionsState] = useState<MentionIdentity[]>(NO_MENTIONS);
  const hydrated = useRef(false);
  const edited = useRef(false);
  const pending = useRef<DraftSnapshot | null>(null);
  const latest = useRef<DraftSnapshot>({ draftKey, text, mentions });
  latest.current = { draftKey, text, mentions };

  const setText = useCallback<Dispatch<SetStateAction<string>>>((value) => {
    edited.current = true;
    setTextState(value);
  }, []);

  const setMentions = useCallback<Dispatch<SetStateAction<MentionIdentity[]>>>((value) => {
    edited.current = true;
    setMentionsState(value);
  }, []);

  const flush = useCallback((): void => {
    const write = pending.current;
    if (!write) return;
    pending.current = null;
    void writeDraftText(write.draftKey, write.text, write.mentions);
  }, []);

  useEffect(() => {
    let cancelled = false;
    hydrated.current = false;
    edited.current = false;
    setTextState('');
    setMentionsState(NO_MENTIONS);
    void readDraftText(draftKey).then((cached) => {
      if (cancelled) return;
      hydrated.current = true;
      // A draft the user has already started typing over is theirs, not the
      // cache's, however late the read lands. Whatever they typed while the
      // read was in flight is saved here, since the save effect stood down
      // until hydration finished.
      if (edited.current) {
        pending.current = { ...latest.current };
        flush();
        return;
      }
      if (cached) {
        setTextState(cached.text);
        setMentionsState(cached.mentions);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [draftKey, flush]);

  useEffect(() => {
    if (!hydrated.current) return;
    pending.current = { draftKey, text, mentions };
    const timer = window.setTimeout(flush, SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draftKey, flush, mentions, text]);

  // Leaving the composer — for another draft or for good — commits whatever the
  // debounce was still holding.
  useEffect(() => () => flush(), [draftKey, flush]);

  return { text, setText, mentions, setMentions };
}
