import { fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { layoutKey, readArtifactPanel, readLayout, useSemanticScroll, writeLayout } from './desktop-layout';

const key = layoutKey('org', 'person', 'channels-scroll:space');

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
});

it('returns to the first visible row after the order changes', () => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
  const first = render(<List ids={['a', 'b', 'c']} />);
  const rows = first.container.querySelectorAll<HTMLElement>('[data-layout-id]');
  vi.spyOn(first.container.querySelector('nav')!, 'getBoundingClientRect').mockReturnValue({ top: 100 } as DOMRect);
  vi.spyOn(rows[0]!, 'getBoundingClientRect').mockReturnValue({ bottom: 90 } as DOMRect);
  vi.spyOn(rows[1]!, 'getBoundingClientRect').mockReturnValue({ bottom: 150 } as DOMRect);
  fireEvent.scroll(first.getByTestId('scroll'));
  expect(readLayout(key)).toBe('b');
  first.unmount();

  const scrollIntoView = vi.fn();
  const original = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
  try {
    render(<List ids={['c', 'a', 'b']} />);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.instances[0]).toHaveAttribute('data-layout-id', 'b');
  } finally {
    HTMLElement.prototype.scrollIntoView = original;
  }
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
