import { useEffect, useRef } from 'react';
import { isComposingKeyEvent } from './ime';

/**
 * The two triggers every Easter egg is built from: a key sequence typed
 * anywhere outside a text field, and a burst of clicks on one element. An egg
 * is a trigger plus an effect; the effect is the egg's own component, mounted
 * only once the trigger fires, so an egg nobody finds costs one listener.
 * See `docs/easter-eggs.md`.
 */

export const KONAMI_CODE = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'] as const;

/**
 * Feed it each key; it answers true on the key that completes the sequence.
 * It compares the most recent keys rather than tracking a position, so a
 * stray extra key ("Up Up Up Down…") still matches once the tail is right.
 */
export function keySequenceMatcher(sequence: readonly string[]): (key: string) => boolean {
  const expected = sequence.map((key) => key.toLowerCase());
  let recent: string[] = [];
  return (key) => {
    recent = [...recent, key.toLowerCase()].slice(-expected.length);
    if (recent.length !== expected.length || recent.some((typed, index) => typed !== expected[index])) return false;
    recent = [];
    return true;
  };
}

/** Answers true on the click that makes `count` clicks within `windowMs`. */
export function clickBurstCounter(count: number, windowMs: number): (now: number) => boolean {
  let clicks: number[] = [];
  return (now) => {
    clicks = [...clicks.filter((at) => now - at < windowMs), now];
    if (clicks.length < count) return false;
    clicks = [];
    return true;
  };
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
}

/** Calls `onMatch` when the sequence is typed while no text field has focus. */
export function useKeySequence(sequence: readonly string[], onMatch: () => void): void {
  const onMatchRef = useRef(onMatch);
  onMatchRef.current = onMatch;
  useEffect(() => {
    const matches = keySequenceMatcher(sequence);
    const listener = (event: KeyboardEvent) => {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isComposingKeyEvent(event) || isTypingTarget(event.target)) return;
      if (matches(event.key)) onMatchRef.current();
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [sequence]);
}

/** A click handler that calls `onBurst` on the `count`th click within `windowMs`. */
export function useClickBurst(count: number, windowMs: number, onBurst: () => void): () => void {
  const counter = useRef<((now: number) => boolean) | null>(null);
  counter.current ??= clickBurstCounter(count, windowMs);
  const onBurstRef = useRef(onBurst);
  onBurstRef.current = onBurst;
  return () => {
    if (counter.current!(Date.now())) onBurstRef.current();
  };
}
