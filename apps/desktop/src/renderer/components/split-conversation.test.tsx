import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { clampBreakoutWidth, SplitConversationLayout } from '@rally/ui/components/split-conversation';

describe('clampBreakoutWidth', () => {
  it('keeps both panes at least the conversation minimum wide', () => {
    expect(clampBreakoutWidth(100, 1_200)).toBe(424);
    expect(clampBreakoutWidth(900, 1_200)).toBe(776);
    expect(clampBreakoutWidth(500.4, 1_200)).toBe(500);
  });

  it('splits evenly when the container cannot fit two minimums', () => {
    expect(clampBreakoutWidth(300, 600)).toBe(300);
    expect(clampBreakoutWidth(800, 601)).toBe(301);
  });
});

describe('SplitConversationLayout', () => {
  function layout(mode: 'main' | 'split' | 'breakout', onBreakoutWidthChange = vi.fn()) {
    return <SplitConversationLayout
      breakout={<p>Breakout pane</p>}
      breakoutWidth={null}
      main={<p>Main pane</p>}
      mode={mode}
      onBreakoutWidthChange={onBreakoutWidthChange}
    />;
  }

  it('keeps both panes mounted and shows the ones the mode names', () => {
    const { rerender } = render(layout('main'));
    expect(screen.getByText('Main pane')).toBeVisible();
    expect(screen.getByText('Breakout pane')).not.toBeVisible();
    expect(screen.queryByRole('separator', { name: 'Resize breakout' })).not.toBeInTheDocument();

    rerender(layout('split'));
    expect(screen.getByText('Main pane')).toBeVisible();
    expect(screen.getByText('Breakout pane')).toBeVisible();
    expect(screen.getByRole('separator', { name: 'Resize breakout' })).toBeInTheDocument();

    rerender(layout('breakout'));
    expect(screen.getByText('Main pane')).not.toBeVisible();
    expect(screen.getByText('Breakout pane')).toBeVisible();
  });

  it('widens the breakout from half with the keyboard', () => {
    const onBreakoutWidthChange = vi.fn();
    render(layout('split', onBreakoutWidthChange));
    const resizer = screen.getByRole('separator', { name: 'Resize breakout' });
    vi.spyOn(resizer.parentElement!, 'getBoundingClientRect').mockReturnValue({
      bottom: 800, height: 800, left: 0, right: 1_200, top: 0, width: 1_200, x: 0, y: 0, toJSON: () => ({}),
    });

    fireEvent.keyDown(resizer, { key: 'ArrowLeft' });
    expect(onBreakoutWidthChange).toHaveBeenLastCalledWith(616);
    fireEvent.keyDown(resizer, { key: 'ArrowRight' });
    expect(onBreakoutWidthChange).toHaveBeenLastCalledWith(584);
  });
});
