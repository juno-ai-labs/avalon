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
  /**
   * Take this composer's draft out of its key, because the caller is about to
   * store it under a different one.
   *
   * For the screen that re-keys its own composer mid-conversation: the text
   * typed while a turn was compiling belongs to the draft that turn created,
   * and carrying it over by hand is a *copy* unless something removes the
   * original. Both halves of that removal are here because both are easy to get
   * wrong alone — the pending write is dropped so the key-change flush leaves
   * nothing behind, and the key is cleared because a typing burst longer than
   * the debounce has already written it. Call this before changing `draftKey`.
   */
  releaseDraft: () => void;
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
  // debounce was still holding, and whatever was typed before the cache read
  // landed.
  //
  // That second case is the one the debounce never holds: the save effect
  // stands down until hydration, so a composer opened, typed into, and left
  // inside that window has nothing armed to flush and the text would go
  // nowhere. It is the same sentence the hydration handler above protects, lost
  // to a different order of events — and the handler cannot cover it, because
  // its own guard stands down once the composer is gone.
  //
  // The key it writes under comes from this effect's closure and not from
  // `latest`, which by the time a key-change cleanup runs already describes the
  // key being switched *to*. That distinction is what lets this cover a key
  // change and not only an unmount — which matters for the composer that
  // re-keys itself: re-keyed before the first read lands, the carried sentence
  // has been hydrated under neither key and armed under neither, so nothing
  // else would write it at all.
  useEffect(() => () => {
    if (!hydrated.current && edited.current && !pending.current) {
      // Committed, so nothing is left uncommitted — a hydration that resolves
      // after this must not write it a second time.
      edited.current = false;
      pending.current = { ...latest.current, draftKey };
    }
    flush();
  }, [draftKey, flush]);

  // Reads the key off `latest` rather than the render's `draftKey` so a caller
  // that releases and re-keys in one handler cannot clear the key it is moving
  // *to*: React batches both state updates into one render, and by the time any
  // effect runs, `draftKey` is already the new one.
  const releaseDraft = useCallback((): void => {
    const { draftKey: releasedKey, epoch } = latest.current;
    pending.current = null;
    edited.current = false;
    void writeDraftText(releasedKey, '', NO_MENTIONS, epoch);
  }, []);

  return { text, setText, mentions, setMentions, releaseDraft };
}
