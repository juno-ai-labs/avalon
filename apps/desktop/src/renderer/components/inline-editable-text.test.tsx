import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InlineEditableText } from './inline-editable-text';

afterEach(cleanup);

type Save = (next: string) => Promise<unknown>;

function edit(onSave = vi.fn<Save>(async () => undefined)) {
  render(<InlineEditableText ariaLabel="Organization name" onSave={onSave} value="Rally" />);
  fireEvent.doubleClick(screen.getByRole('button', { name: /Organization name/ }));
  return { onSave, input: screen.getByRole('textbox', { name: 'Organization name' }) };
}

describe('InlineEditableText', () => {
  it('opens a field holding the current value on double-click', () => {
    const { input } = edit();
    expect(input).toHaveValue('Rally');
  });

  it('saves the trimmed value on Enter and shows it while the save runs', async () => {
    let finish!: () => void;
    const onSave = vi.fn<Save>(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { input } = edit(onSave);

    fireEvent.change(input, { target: { value: '  Juno Labs  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSave).toHaveBeenCalledWith('Juno Labs');
    expect(screen.getByRole('button', { name: /Organization name/ })).toHaveTextContent('Juno Labs');
    finish();
  });

  it('cancels on Escape and marks the keystroke so the window stays open', () => {
    const { onSave, input } = edit();
    fireEvent.change(input, { target: { value: 'Juno Labs' } });
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => { input.dispatchEvent(escape); });

    expect(escape.defaultPrevented).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Organization name/ })).toHaveTextContent('Rally');
  });

  it('saves nothing for a blank or unchanged value, or when focus leaves', () => {
    const { onSave, input } = edit();
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    fireEvent.doubleClick(screen.getByRole('button', { name: /Organization name/ }));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    fireEvent.doubleClick(screen.getByRole('button', { name: /Organization name/ }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Juno Labs' } });
    fireEvent.blur(screen.getByRole('textbox'));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Organization name/ })).toHaveTextContent('Rally');
  });

  it('falls back to the stored value when the save fails', async () => {
    const { input } = edit(vi.fn<Save>(async () => { throw new Error('refused'); }));
    fireEvent.change(input, { target: { value: 'Juno Labs' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Organization name/ })).toHaveTextContent('Rally'));
  });

  it('is plain text with no edit affordance when disabled', () => {
    render(<InlineEditableText ariaLabel="Organization name" disabled onSave={vi.fn()} value="Rally" />);
    fireEvent.doubleClick(screen.getByText('Rally'));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
