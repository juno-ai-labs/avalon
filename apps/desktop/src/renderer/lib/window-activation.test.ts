import { fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { hasUserInputSinceWindowActivation, installWindowActivationTracking } from './window-activation';

let stopTracking: (() => void) | null = null;

function track(): void {
  stopTracking = installWindowActivationTracking();
}

afterEach(() => {
  stopTracking?.();
  stopTracking = null;
});

/** The switch itself: the window goes to the back, then comes to the front. */
function switchAwayAndBack(): void {
  fireEvent.blur(window);
  fireEvent.focus(window);
}

describe('window activation', () => {
  it('answers for the surfaces that ask before anything has installed it', () => {
    // The guard is an opt-in on top of what these surfaces already did, so a
    // window that never installed it — or a test rendering one component of one
    // — must not find its hovers silently muted.
    expect(hasUserInputSinceWindowActivation()).toBe(true);
  });

  it('treats a window coming to the front as nobody having touched it', () => {
    track();
    expect(hasUserInputSinceWindowActivation()).toBe(true);

    switchAwayAndBack();

    expect(hasUserInputSinceWindowActivation()).toBe(false);
  });

  it('closes on the way out, so the order of the return cannot matter', () => {
    track();

    // The window leaving is what arms the guard, which is why nothing in the
    // module depends on whether the restored element focus arrives before or
    // after the window's own `focus`: the flag has been up since it left.
    fireEvent.blur(window);

    expect(hasUserInputSinceWindowActivation()).toBe(false);
  });

  it('holds a pointer that the window arrived under to be a pointer that has not moved', () => {
    track();
    switchAwayAndBack();

    // Whatever the activation dispatches — an entry into the content that came
    // forward under the cursor, and whatever follows it — describes a cursor
    // that is where it already was, however many events say so.
    fireEvent.pointerOver(window, { clientX: 420, clientY: 260 });
    fireEvent.pointerMove(window, { clientX: 420, clientY: 260 });

    expect(hasUserInputSinceWindowActivation()).toBe(false);

    fireEvent.pointerMove(window, { clientX: 421, clientY: 260 });

    expect(hasUserInputSinceWindowActivation()).toBe(true);
  });

  it('needs one movement rather than two when the switch said where the cursor was', () => {
    track();
    switchAwayAndBack();

    // The entry the activation produces is the only chance to learn the resting
    // position. Missing it spends the person's first real movement on learning
    // it instead, and the hover they are asking for waits for a second.
    fireEvent.pointerOver(window, { clientX: 420, clientY: 260 });
    fireEvent.pointerMove(window, { clientX: 424, clientY: 262 });

    expect(hasUserInputSinceWindowActivation()).toBe(true);
  });

  it('takes a key going down, and not the modifier the switch itself releases', () => {
    track();
    switchAwayAndBack();

    // Command-Tab is finished with Command coming up, and on a platform that
    // delivers that keystroke it arrives after the window is already in front.
    fireEvent.keyUp(window, { key: 'Meta' });

    expect(hasUserInputSinceWindowActivation()).toBe(false);

    fireEvent.keyDown(window, { key: 'Tab' });

    expect(hasUserInputSinceWindowActivation()).toBe(true);
  });

  it('takes a click without asking where the pointer came from', () => {
    track();
    switchAwayAndBack();

    fireEvent.pointerDown(window, { clientX: 420, clientY: 260 });

    expect(hasUserInputSinceWindowActivation()).toBe(true);
  });

  it('re-arms on every switch rather than only the first', () => {
    track();
    switchAwayAndBack();
    fireEvent.pointerDown(window);
    expect(hasUserInputSinceWindowActivation()).toBe(true);

    switchAwayAndBack();

    expect(hasUserInputSinceWindowActivation()).toBe(false);
  });

  it('hands the answer back when the last tracker goes away', () => {
    track();
    switchAwayAndBack();
    expect(hasUserInputSinceWindowActivation()).toBe(false);

    stopTracking?.();
    stopTracking = null;

    expect(hasUserInputSinceWindowActivation()).toBe(true);
  });

  it('survives a stop that is called twice', () => {
    // The count is what makes two trackers safe; a stop that decrements twice
    // takes it below zero, and the next install then raises it to zero rather
    // than to one. Nothing re-adds the listeners after that, and the guard is
    // off while answering exactly what an uninstalled one answers.
    const stop = installWindowActivationTracking();
    stop();
    stop();

    track();
    switchAwayAndBack();

    expect(hasUserInputSinceWindowActivation()).toBe(false);
  });

  it('keeps tracking while a second tracker still wants it', () => {
    // Strict Mode mounts an effect, tears it down, and mounts it again. A
    // teardown that removed the listeners regardless would leave the remounted
    // tracker installed and deaf.
    track();
    const second = installWindowActivationTracking();
    second();

    switchAwayAndBack();

    expect(hasUserInputSinceWindowActivation()).toBe(false);
  });
});
