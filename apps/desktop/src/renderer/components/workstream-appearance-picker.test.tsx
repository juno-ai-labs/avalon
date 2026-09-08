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
    render(<WorkstreamAppearancePicker id="room" appearance={{ icon: 'atom', color: 'gray' }} size={20} onChange={onChange} />);
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
    render(<WorkstreamAppearancePicker id="room" appearance={{ icon: 'atom', color: 'gray' }} size={20} onChange={vi.fn().mockRejectedValue(new Error('offline'))} />);
    openPicker();
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Blue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t update');
    expect(screen.getByRole('menuitemradio', { name: 'Gray' })).toHaveAttribute('aria-checked', 'true');
  });
});
