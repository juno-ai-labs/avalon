import { fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { layoutKey, readArtifactPanel, readLayout, useSemanticScroll, writeLayout } from './desktop-layout';

const key = layoutKey('org', 'person', 'channels-scroll:space');
let originalScrollIntoView: PropertyDescriptor | undefined;
let scrollIntoView: ReturnType<typeof vi.fn>;

function List({ ids, onMissing }: { ids: string[]; onMissing?: () => void }): React.JSX.Element {
  const ref = useRef<HTMLElement | null>(null);
  useSemanticScroll(ref, key, '[data-layout-id]', true, onMissing, ids);
  return <nav data-testid="scroll" ref={ref}>{ids.map((id) =>
    <div data-layout-id={id} key={id}>{id}</div>)}</nav>;
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
  originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    value: scrollIntoView, configurable: true, writable: true,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
  else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

it('returns to the first visible row after the order changes', () => {
  const first = render(<List ids={['a', 'b', 'c']} />);
  const rows = first.container.querySelectorAll<HTMLElement>('[data-layout-id]');
  vi.spyOn(first.container.querySelector('nav')!, 'getBoundingClientRect').mockReturnValue({ top: 100 } as DOMRect);
  vi.spyOn(rows[0]!, 'getBoundingClientRect').mockReturnValue({ bottom: 90 } as DOMRect);
  vi.spyOn(rows[1]!, 'getBoundingClientRect').mockReturnValue({ bottom: 150 } as DOMRect);
  fireEvent.scroll(first.getByTestId('scroll'));
  expect(readLayout(key)).toBe('b');
  first.unmount();

  render(<List ids={['c', 'a', 'b']} />);
  expect(scrollIntoView).toHaveBeenCalledTimes(1);
  expect(scrollIntoView.mock.instances[0]).toHaveAttribute('data-layout-id', 'b');
});

it('asks for a missing row only when the loaded directory changes', () => {
  writeLayout(key, 'saved');
  const onMissing = vi.fn();
  const ids = ['first'];
  const view = render(<List ids={ids} onMissing={onMissing} />);
  expect(onMissing).toHaveBeenCalledTimes(1);
  view.rerender(<List ids={ids} onMissing={onMissing} />);
  expect(onMissing).toHaveBeenCalledTimes(1);
  view.rerender(<List ids={['first', 'second']} onMissing={onMissing} />);
  expect(onMissing).toHaveBeenCalledTimes(2);
});

it('ignores a malformed saved artifact panel', () => {
  writeLayout(layoutKey('org', 'person', 'artifact-panel:channel:child'), '{bad');
  expect(readArtifactPanel(layoutKey('org', 'person', 'artifact-panel:channel:child'))).toBeNull();
});
