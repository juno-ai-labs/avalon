import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkstreamAppearancePicker } from './workstream-appearance-picker';

function openPicker(): void {
  fireEvent.keyDown(screen.getByRole('button', { name: 'Change work-stream icon and color' }), { key: 'Enter' });
}

describe('work stream appearance picker', () => {
  it('keeps the popup open and submits rapid choices without a save', async () => {
    let finish!: () => void;
    const onChange = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; })).mockResolvedValue(undefined);
    render(<WorkstreamAppearancePicker id="room" appearance={{ icon: 'atom', color: 'blue' }} size={20} onChange={onChange} />);
    openPicker();
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Purple' }));
    expect(screen.getByRole('menuitemradio', { name: 'Purple' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Rocket' }));
    expect(screen.getByRole('menuitemradio', { name: 'Rocket' })).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
    expect(onChange).toHaveBeenNthCalledWith(1, { color: 'purple' });
    await act(async () => finish());
    await waitFor(() => expect(onChange).toHaveBeenNthCalledWith(2, { icon: 'rocket' }));
    expect(screen.getByRole('menu')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Change work-stream icon and color' })).toHaveFocus();
  });

  it('restores server state and reports a failed save', async () => {
    render(<WorkstreamAppearancePicker id="room" appearance={{ icon: 'atom', color: 'blue' }} size={20} onChange={vi.fn().mockRejectedValue(new Error('offline'))} />);
    openPicker();
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Blue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t update');
    expect(screen.getByRole('menuitemradio', { name: 'Blue' })).toHaveAttribute('aria-checked', 'true');
  });
  it('keeps a saved preview through unrelated metadata and retires it when the value arrives', async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    const props = { id: 'room', size: 20, onChange };
    const { rerender } = render(<WorkstreamAppearancePicker {...props} appearance={{ icon: 'atom', color: 'blue' }} />);
    openPicker();
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Purple' }));
    await act(async () => {});
    rerender(<WorkstreamAppearancePicker {...props} appearance={{ icon: 'atom', color: 'blue' }} />);
    expect(screen.getByRole('menuitemradio', { name: 'Purple' })).toHaveAttribute('aria-checked', 'true');
    rerender(<WorkstreamAppearancePicker {...props} appearance={{ icon: 'atom', color: 'purple' }} />);
    rerender(<WorkstreamAppearancePicker {...props} appearance={{ icon: 'atom', color: 'blue' }} />);
    expect(screen.getByRole('menuitemradio', { name: 'Blue' })).toHaveAttribute('aria-checked', 'true');
  });

  it('removes only the failed choice and ignores its superseded error', async () => {
    let fail!: (error: Error) => void;
    const onChange = vi.fn().mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; }))
      .mockResolvedValue(undefined);
    render(<WorkstreamAppearancePicker id="room" appearance={{ icon: 'atom', color: 'blue' }} size={20} onChange={onChange} />);
    openPicker();
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Purple' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Rocket' }));
    await act(async () => { fail(new Error('offline')); });
    expect(screen.getByRole('menuitemradio', { name: 'Blue' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemradio', { name: 'Rocket' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not show a stale failure when reopened', async () => {
    let fail!: (error: Error) => void;
    render(<WorkstreamAppearancePicker id="room" appearance={{ icon: 'atom', color: 'blue' }} size={20}
      onChange={() => new Promise<void>((_resolve, reject) => { fail = reject; })} />);
    openPicker();
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Purple' }));
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    await act(async () => { fail(new Error('offline')); });
    openPicker();
    expect(await screen.findByRole('menuitemradio', { name: 'Blue' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows no swatch for a colour reserved to accounts, but still renders a work stream holding one', () => {
    // `black` is storable and not offered. A work stream set to it before the
    // picker stopped listing it must still open the picker without throwing —
    // it simply has nothing checked, and picking anything moves it onto a hue.
    render(<WorkstreamAppearancePicker id="room" appearance={{ icon: 'atom', color: 'black' }} size={20} onChange={vi.fn()} />);
    openPicker();

    expect(screen.queryByRole('menuitemradio', { name: 'Black' })).not.toBeInTheDocument();
    // Scoped to the colour group: the icon group shares the menuitemradio role,
    // and its selection is unrelated.
    const colours = document.querySelector('.workstream-appearance-colors');
    const checked = [...(colours?.querySelectorAll('[role="menuitemradio"][aria-checked="true"]') ?? [])];
    expect(checked).toHaveLength(0);
    expect(screen.getByRole('menuitemradio', { name: 'Blue' })).toBeInTheDocument();
  });

});
