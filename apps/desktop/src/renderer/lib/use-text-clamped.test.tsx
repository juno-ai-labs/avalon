import { act, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useTextClamped } from './use-text-clamped';

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
function stubControllableResizeObserver(): { notify: (target: Element) => void } {
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

    render(<Subject text="Avalon woke this work stream up as scheduled." />);

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

  it('keeps its answer while the caller has the clamp lifted', () => {
    stubHeights({ clientHeight: 82, scrollHeight: 1_640 });
    const { rerender } = render(<Subject text="A digest brief" />);
    expect(screen.getByRole('status')).toHaveTextContent('clamped');

    // Expanding removes the clamp, so the box now reports its whole height and
    // a hook that kept measuring would retract the control the reader just
    // used, stranding them in text they cannot collapse again.
    stubHeights({ clientHeight: 1_640, scrollHeight: 1_640 });
    rerender(<Subject clampApplied={false} text="A digest brief" />);

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
