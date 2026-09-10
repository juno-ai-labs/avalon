import { fireEvent, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { escapeClosesWindow, useEscapeClosesWindow } from './window-escape';

function escapeOn(target: EventTarget, init: KeyboardEventInit = {}, scope: Element | null = null): boolean {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape', ...init });
  target.dispatchEvent(event);
  return escapeClosesWindow(event, scope);
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('escapeClosesWindow', () => {
  it('answers only a bare, unclaimed Escape', () => {
    const field = document.createElement('input');
    document.body.append(field);

    expect(escapeOn(field)).toBe(true);
    expect(escapeOn(field, { key: 'Enter' })).toBe(false);
    // A shortcut that happens to contain Escape belongs to whoever bound it.
    expect(escapeOn(field, { metaKey: true })).toBe(false);
    expect(escapeOn(field, { shiftKey: true })).toBe(false);

    field.addEventListener('keydown', (event) => event.preventDefault(), { once: true });
    expect(escapeOn(field)).toBe(false);
  });

  it('leaves an in-flight IME composition its own Escape', () => {
    const field = document.createElement('input');
    document.body.append(field);

    // This keystroke abandons the candidate under the highlight, which has no
    // undo. Closing the window over it would take the sentence and the window.
    expect(escapeOn(field, { isComposing: true })).toBe(false);
    expect(escapeOn(field, { keyCode: 229 })).toBe(false);
  });

  it('yields to the layer the keystroke was aimed at', () => {
    const layer = document.createElement('div');
    layer.setAttribute('role', 'listbox');
    const option = document.createElement('button');
    layer.append(option);
    document.body.append(layer);

    // A select menu is dismissed by this Escape; the window is not.
    expect(escapeOn(option)).toBe(false);
  });

  it('ignores controls that hold no typing', () => {
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = true;
    document.body.append(toggle);

    // A checked box carries a value of its own; it is not unsaved text.
    expect(escapeOn(toggle)).toBe(true);
  });

  it('holds the keystroke while the focused control holds typing', () => {
    const filter = document.createElement('input');
    filter.type = 'search';
    document.body.append(filter);

    expect(escapeOn(filter)).toBe(true);
    // A search box answers Escape by clearing itself. A window that vanished on
    // the same keystroke would never let anyone see that happen.
    filter.value = 'daily brief';
    expect(escapeOn(filter)).toBe(false);
  });

  it('sweeps a nominated scope for text no element currently holds focus over', () => {
    const scope = document.createElement('div');
    const draft = document.createElement('input');
    const elsewhere = document.createElement('button');
    scope.append(draft);
    document.body.append(scope, elsewhere);

    expect(escapeOn(elsewhere, {}, scope)).toBe(true);
    draft.value = 'teammate@company.com';
    expect(escapeOn(elsewhere, {}, scope)).toBe(false);
    // A window that nominates no scope is not swept at all: it has said that
    // closing costs its text nothing.
    expect(escapeOn(elsewhere)).toBe(true);

    // Values that are already saved, or that cannot be edited at all, are not
    // drafts — a generated endpoint and a disabled field both read as text.
    draft.readOnly = true;
    expect(escapeOn(elsewhere, {}, scope)).toBe(true);
    draft.readOnly = false;
    draft.disabled = true;
    expect(escapeOn(elsewhere, {}, scope)).toBe(true);

    // A picker that ships with a value is never empty, so counting it would
    // leave Escape permanently dead in whichever section shows one.
    draft.disabled = false;
    draft.type = 'time';
    draft.value = '10:30';
    expect(escapeOn(elsewhere, {}, scope)).toBe(true);
  });

  it('compares a field against the value it was given rather than against emptiness', () => {
    const scope = document.createElement('div');
    const field = document.createElement('input');
    field.value = 'packages.example.com';
    field.dataset.savedValue = 'packages.example.com';
    scope.append(field);
    document.body.append(scope);

    expect(escapeOn(document.body, {}, scope)).toBe(true);
    field.value = 'packages.example.com\nnew.example.com';
    expect(escapeOn(document.body, {}, scope)).toBe(false);
  });
});

describe('useEscapeClosesWindow', () => {
  it('closes the window on Escape, and stops listening when it unmounts', () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    const { unmount } = renderHook(() => useEscapeClosesWindow());

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(close).toHaveBeenCalledOnce();

    unmount();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('stays silent on a surface that has not enabled it', () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    // The same screen can be a route inside the main window, where this
    // keystroke would shut the workspace itself.
    renderHook(() => useEscapeClosesWindow({ enabled: false }));

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
  });

  it('reads the nominated scope at the keystroke rather than at mount', () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    const scope = document.createElement('div');
    const draft = document.createElement('input');
    scope.append(draft);
    document.body.append(scope);
    renderHook(() => useEscapeClosesWindow({ unsavedTextScope: { current: scope } }));

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(close).toHaveBeenCalledOnce();

    draft.value = 'teammate@company.com';
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(close).toHaveBeenCalledOnce();
  });
});
