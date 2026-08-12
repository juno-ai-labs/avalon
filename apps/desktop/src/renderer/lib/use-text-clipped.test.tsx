import { act, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useTextClipped } from './use-text-clipped';

/**
 * jsdom performs no layout — every element reports a width of zero — so a
 * clipped box cannot be produced here, only described. The properties are
 * defined on the prototype because the element under measurement is created by
 * the component under test; `restore` uncovers jsdom's own getters, which
 * `restoreMocks` cannot do for a plain `defineProperty`.
 */
function stubWidths(widths: { clientWidth: number; scrollWidth: number }): void {
  for (const [name, value] of Object.entries(widths)) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value });
  }
}

function restoreWidths(): void {
  for (const name of ['clientWidth', 'scrollWidth']) {
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

function Subject({ text, mounted = true }: { text: string; mounted?: boolean }): React.JSX.Element {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const clipped = useTextClipped(node, text);
  return (
    <div>
      {mounted && <span data-testid="box" ref={setNode}>{text}</span>}
      <output>{clipped ? 'clipped' : 'whole'}</output>
    </div>
  );
}

afterEach(restoreWidths);

describe('useTextClipped', () => {
  it('reports text that fits as whole', () => {
    stubWidths({ clientWidth: 240, scrollWidth: 240 });

    render(<Subject text="A short name" />);

    expect(screen.getByRole('status')).toHaveTextContent('whole');
  });

  it('counts a single pixel of overflow as clipped', () => {
    // Both measurements are rounded off a fractional box, so a string that
    // overflows by a fraction of a pixel can report a difference of one — and
    // the ellipsis is already painted at that point. Tolerating the pixel would
    // hide characters the caller is being asked about.
    stubWidths({ clientWidth: 200, scrollWidth: 201 });

    render(<Subject text="A name a pixel too long for its box" />);

    expect(screen.getByRole('status')).toHaveTextContent('clipped');
  });

  it('follows the element being resized under text that has not changed', () => {
    stubWidths({ clientWidth: 240, scrollWidth: 240 });
    const resize = stubControllableResizeObserver();

    render(<Subject text="A name that fits, for now" />);
    expect(screen.getByRole('status')).toHaveTextContent('whole');

    // A panel opening beside it narrows the box with the window perfectly
    // still and the text untouched, so the element's own resize is the only
    // thing that can report it.
    stubWidths({ clientWidth: 160, scrollWidth: 240 });
    act(() => resize.notify(screen.getByTestId('box')));
    expect(screen.getByRole('status')).toHaveTextContent('clipped');

    stubWidths({ clientWidth: 240, scrollWidth: 240 });
    act(() => resize.notify(screen.getByTestId('box')));
    expect(screen.getByRole('status')).toHaveTextContent('whole');
  });

  it('re-measures when the text grows inside a box that never changed size', () => {
    stubWidths({ clientWidth: 240, scrollWidth: 240 });
    const { rerender } = render(<Subject text="Short" />);

    expect(screen.getByRole('status')).toHaveTextContent('whole');

    stubWidths({ clientWidth: 240, scrollWidth: 900 });
    rerender(<Subject text="A name long enough to overflow the same box" />);

    expect(screen.getByRole('status')).toHaveTextContent('clipped');
  });

  it('re-measures the element that comes back, not the one that went away', () => {
    stubWidths({ clientWidth: 160, scrollWidth: 240 });
    const { rerender } = render(<Subject text="A name too long for its box" />);

    expect(screen.getByRole('status')).toHaveTextContent('clipped');

    // Callers swap the element out for an editor or a placeholder and back
    // again. The box it returns to can be a different size, and the same text
    // in the same component is not enough on its own to prompt a fresh look.
    rerender(<Subject mounted={false} text="A name too long for its box" />);
    stubWidths({ clientWidth: 400, scrollWidth: 240 });
    rerender(<Subject text="A name too long for its box" />);

    expect(screen.getByRole('status')).toHaveTextContent('whole');
  });
});
