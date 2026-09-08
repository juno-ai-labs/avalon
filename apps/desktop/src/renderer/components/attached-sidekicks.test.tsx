import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AttachedSidekicks } from './attached-sidekicks';
const openSidekicks = vi.hoisted(() => vi.fn());
vi.mock('../lib/platform', () => ({ desktopBridge: () => ({ openSidekicks }) }));
describe('AttachedSidekicks', () => {
  it('opens unavailable authorized entries and separates removal styling', () => {
    const remove = vi.fn();
    render(<AttachedSidekicks items={[{ id: 'one', name: 'Editor', description: 'Review wording', available: false }]} onRemove={remove} />);
    expect(screen.getByText('Unavailable')).toBeVisible();
    const row = screen.getByRole('button', { name: 'Editor' });
    expect(row).not.toHaveClass('sidekick-attachment-remove');
    fireEvent.click(row);
    expect(openSidekicks).toHaveBeenCalledWith('one');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Editor' }));
    expect(remove).toHaveBeenCalledWith('one');
  });
  it('hides empty attachments and surfaces read failures', () => {
    const { rerender } = render(<AttachedSidekicks items={[]} />);
    expect(screen.queryByRole('heading', { name: 'Sidekicks' })).toBeNull();
    rerender(<AttachedSidekicks error="Could not load attachments" />);
    expect(screen.getByText('Could not load attachments')).toBeVisible();
  });
});
