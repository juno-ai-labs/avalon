import { act, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CLAMP_ROUNDING_TOLERANCE_PX, useTextClamped } from './use-text-clamped';

/**
 * jsdom performs no layout — every element reports a height of zero — so a
 * clamped block cannot be produced here, only described. The properties are
 * defined on the prototype because the element under measurement is created by
 * the component under test; `restore` uncovers jsdom's own getters, which
 * `restoreMocks` cannot do for a plain `defineProperty`.
 */
function stubHeights(heights: { clientHeight: number; scrollHeight: number }): void {
  for (const [name, value] of Object.entries(heights)) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value });
  }
}

function restoreHeights(): void {
  for (const name of ['clientHeight', 'scrollHeight']) {
    Reflect.deleteProperty(HTMLElement.prototype, name);
  }
}

/**
 * A `ResizeObserver` whose callbacks fire on demand. The environment's own stub
 * never calls back, so without this the observer could be deleted outright and
 * every test here would still pass.
 */
function stubControllableResizeObserver(): { notify: (target: Element) => void; observing: (target: Element) => boolean } {
  const observers: { callback: () => void; targets: Element[] }[] = [];
  vi.stubGlobal('ResizeObserver', class {
    private readonly registration: { callback: () => void; targets: Element[] };

    constructor(callback: () => void) {
      this.registration = { callback, targets: [] };
      observers.push(this.registration);
    }

    observe(target: Element): void { this.registration.targets.push(target); }
    unobserve(): void {}
    disconnect(): void { this.registration.targets.length = 0; }
  });
  return {
    notify: (target) => {
      for (const observer of observers) {
        if (observer.targets.includes(target)) observer.callback();
      }
    },
    observing: (target) => observers.some((observer) => observer.targets.includes(target)),
  };
}

function Subject({ clampApplied = true, text }: { clampApplied?: boolean; text: string }): React.JSX.Element {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const clamped = useTextClamped(node, text, clampApplied);
  return (
    <div>
      <p data-testid="box" ref={setNode}>{text}</p>
      <output>{clamped ? 'clamped' : 'whole'}</output>
    </div>
  );
}

afterEach(restoreHeights);

describe('useTextClamped', () => {
  it('reports text that fits within the clamp as whole', () => {
    stubHeights({ clientHeight: 82, scrollHeight: 82 });

    render(<Subject text="Rally woke this work stream up as scheduled." />);

    expect(screen.getByRole('status')).toHaveTextContent('whole');
  });

  it('reports a block with a line behind the clamp as clamped', () => {
    stubHeights({ clientHeight: 82, scrollHeight: 1_640 });

    render(<Subject text="A digest brief far longer than five lines" />);

    expect(screen.getByRole('status')).toHaveTextContent('clamped');
  });

  it('does not call a few pixels of rounding a hidden line', () => {
    // Five lines of fractional line height round to a scroll height a pixel or
    // two over the client height with no sixth line behind it. Offering "more"
    // there opens a block that looks identical to the one the reader clicked.
    stubHeights({ clientHeight: 82, scrollHeight: 84 });

    render(<Subject text="A message that fills its five lines exactly" />);

    expect(screen.getByRole('status')).toHaveTextContent('whole');
  });

  it('stops observing, and keeps its answer, while the caller has the clamp lifted', () => {
    stubHeights({ clientHeight: 82, scrollHeight: 1_640 });
    const resize = stubControllableResizeObserver();
    const { rerender } = render(<Subject text="A digest brief" />);
    expect(screen.getByRole('status')).toHaveTextContent('clamped');
    expect(resize.observing(screen.getByTestId('box'))).toBe(true);

    // Expanding is itself a resize of the observed element, and the opened box
    // reports that it fits. Pausing has to release the observer, not merely
    // skip the measurement on a re-render: an observer left alive across the
    // transition fires on the growth and retracts the control the reader just
    // used, stranding them in text they can no longer collapse.
    stubHeights({ clientHeight: 1_640, scrollHeight: 1_640 });
    rerender(<Subject clampApplied={false} text="A digest brief" />);

    expect(resize.observing(screen.getByTestId('box'))).toBe(false);
    act(() => resize.notify(screen.getByTestId('box')));
    expect(screen.getByRole('status')).toHaveTextContent('clamped');
  });

  it('measures again once the clamp is back', () => {
    stubHeights({ clientHeight: 82, scrollHeight: 1_640 });
    const resize = stubControllableResizeObserver();
    const { rerender } = render(<Subject text="A digest brief" />);
    rerender(<Subject clampApplied={false} text="A digest brief" />);

    // Collapsing has to re-arm both the measurement and the observer, or the
    // frozen answer outlives the state it was taken in — a row whose text was
    // replaced by something short would keep offering a control that opens
    // nothing.
    stubHeights({ clientHeight: 82, scrollHeight: 82 });
    rerender(<Subject text="A digest brief" />);

    expect(screen.getByRole('status')).toHaveTextContent('whole');
    expect(resize.observing(screen.getByTestId('box'))).toBe(true);
  });

  it('puts the rounding boundary between integer error and a hidden line', () => {
    // The constant is 4px against a ~16px line box. Both neighbours are pinned
    // so that widening it toward a real hidden line, or narrowing it back onto
    // the rounding it exists to absorb, fails here rather than in a window.
    stubHeights({ clientHeight: 82, scrollHeight: 82 + CLAMP_ROUNDING_TOLERANCE_PX });
    const { rerender } = render(<Subject text="A note that fills its clamp exactly" />);
    expect(screen.getByRole('status')).toHaveTextContent('whole');

    stubHeights({ clientHeight: 82, scrollHeight: 82 + CLAMP_ROUNDING_TOLERANCE_PX + 1 });
    rerender(<Subject text="A note that fills its clamp exactly " />);

    expect(screen.getByRole('status')).toHaveTextContent('clamped');
  });

  it('follows the element being resized under text that has not changed', () => {
    stubHeights({ clientHeight: 82, scrollHeight: 82 });
    const resize = stubControllableResizeObserver();

    render(<Subject text="A note that fits five lines, for now" />);
    expect(screen.getByRole('status')).toHaveTextContent('whole');

    // The right rail opening narrows the transcript column with the window
    // perfectly still and the text untouched, and the same words then run past
    // the clamp. Only the element's own resize reports that.
    stubHeights({ clientHeight: 82, scrollHeight: 130 });
    act(() => resize.notify(screen.getByTestId('box')));
    expect(screen.getByRole('status')).toHaveTextContent('clamped');

    stubHeights({ clientHeight: 82, scrollHeight: 82 });
    act(() => resize.notify(screen.getByTestId('box')));
    expect(screen.getByRole('status')).toHaveTextContent('whole');
  });

  it('re-measures when the text grows inside a box that never changed size', () => {
    stubHeights({ clientHeight: 82, scrollHeight: 82 });
    const { rerender } = render(<Subject text="Short" />);

    expect(screen.getByRole('status')).toHaveTextContent('whole');

    stubHeights({ clientHeight: 82, scrollHeight: 900 });
    rerender(<Subject text="A brief long enough to overflow the same box" />);

    expect(screen.getByRole('status')).toHaveTextContent('clamped');
  });
});
