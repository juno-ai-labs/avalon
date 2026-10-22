import { Toast } from '@rally/ui/components/toast';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// jsdom has no animation timeline; complete the native animation explicitly.
const animations: { onfinish: (() => void) | null; cancel: ReturnType<typeof vi.fn>; reverse: ReturnType<typeof vi.fn>; playState: string }[] = [];
let originalAnimate: PropertyDescriptor | undefined;
beforeEach(() => {
  originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
  animations.length = 0;
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: () => {
    const animation = { onfinish: null, cancel: vi.fn(), reverse: vi.fn(), playState: 'running' };
    animations.push(animation);
    return animation;
  } });
});
afterEach(() => {
  cleanup();
  if (originalAnimate) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate);
  else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
  vi.unstubAllGlobals();
});

it('mounts an empty live region before announcing arbitrary confirmation content', () => {
  const view = render(<Toast open={false}>{null}</Toast>);
  const region = screen.getByRole('status');
  expect(region).toBeEmptyDOMElement();
  view.rerender(<Toast icon={<span aria-hidden="true">✓</span>} open>Saved changes</Toast>);
  expect(screen.getByRole('status')).toBe(region);
  expect(region).toHaveAttribute('aria-live', 'polite');
  expect(screen.getByText('Saved changes')).toBeVisible();
});

it('retains the last content through exit, reverses on reopening, and removes it on completion', () => {
  const view = render(<Toast open>Copied</Toast>);
  const body = screen.getByText('Copied').parentElement!;
  view.rerender(<Toast open={false}>{null}</Toast>);
  expect(screen.getByText('Copied')).toBeVisible();
  expect(body).toHaveAttribute('aria-hidden', 'true');
  expect(animations[0]!.reverse).toHaveBeenCalledTimes(1);
  view.rerender(<Toast open>Saved changes</Toast>);
  expect(screen.queryByText('Copied')).toBeNull();
  expect(screen.getByText('Saved changes').parentElement).toBe(body);
  expect(body).not.toHaveAttribute('aria-hidden');
  expect(animations[0]!.reverse).toHaveBeenCalledTimes(2);
  view.rerender(<Toast open={false}>{null}</Toast>);
  act(() => { animations[0]!.onfinish?.(); });
  expect(screen.getByRole('status')).toBeEmptyDOMElement();
});

it('skips motion and removes feedback immediately with reduced motion', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const view = render(<Toast open>Copied</Toast>);
  expect(screen.getByText('Copied')).toBeVisible();
  expect(animations).toHaveLength(0);
  view.rerender(<Toast open={false}>{null}</Toast>);
  expect(screen.getByRole('status')).toBeEmptyDOMElement();
});

it('cancels motion when its owning surface unmounts', () => {
  const view = render(<Toast open>Copied</Toast>);
  view.unmount();
  expect(animations[0]!.cancel).toHaveBeenCalledOnce();
  expect(animations[0]!.onfinish).toBeNull();
});
