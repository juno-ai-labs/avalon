import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef, useState } from 'react';
import type { MentionIdentity } from './api';
import { draftCacheEpoch, readDraftText, writeDraftText } from './draft-cache';

/** Long enough that a typing burst is one write, short enough to survive a quit. */
const SAVE_DEBOUNCE_MS = 250;

/** One shared empty list, so resetting an already-empty draft renders nothing. */
export const NO_MENTIONS: MentionIdentity[] = [];

interface DraftSnapshot {
  draftKey: string;
  text: string;
  mentions: MentionIdentity[];
  /** The cache generation this text was typed in; a wipe since then voids it. */
  epoch: number;
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
  const latest = useRef<DraftSnapshot>({ draftKey, text, mentions, epoch: draftCacheEpoch() });
  latest.current = { ...latest.current, draftKey, text, mentions };

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
    void writeDraftText(write.draftKey, write.text, write.mentions, write.epoch);
  }, []);

  useEffect(() => {
    let cancelled = false;
    hydrated.current = false;
    edited.current = false;
    // This composer's writes belong to the generation it opened in.
    latest.current.epoch = draftCacheEpoch();
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
    // Only an edit is worth persisting. Writing back what hydration just read
    // would restamp the row on every visit, and a draft in a work stream opened
    // daily would never reach its expiry.
    if (!hydrated.current || !edited.current) return;
    pending.current = { draftKey, text, mentions, epoch: latest.current.epoch };
    const timer = window.setTimeout(flush, SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draftKey, flush, mentions, text]);

  // Leaving the composer — for another draft or for good — commits whatever the
  // debounce was still holding.
  useEffect(() => () => flush(), [draftKey, flush]);

  // The one edit the debounce never holds: one made before the cache read has
  // landed. The save effect stands down until hydration, so a composer opened,
  // typed into, and left inside that window has nothing armed to flush and the
  // text goes nowhere — which is the same sentence the hydration handler above
  // exists to protect, lost to a different order of events. Its own guard
  // cancels it when the composer is already gone, so this is the only place
  // left to write from.
  //
  // Deliberately keyed to unmount alone. A key change resets `edited`, so this
  // cannot fire for one — and must not, because `latest` describes the key
  // being switched to by the time a key-change cleanup runs.
  const commitUnhydratedEdit = useCallback((): void => {
    if (hydrated.current || !edited.current || pending.current) return;
    pending.current = { ...latest.current };
    flush();
  }, [flush]);
  useEffect(() => () => commitUnhydratedEdit(), [commitUnhydratedEdit]);

  return { text, setText, mentions, setMentions };
}
