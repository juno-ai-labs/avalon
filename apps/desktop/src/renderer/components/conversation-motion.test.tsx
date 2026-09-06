import * as Tooltip from '@radix-ui/react-tooltip';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActivityPresence, JumpToLatestButton } from './conversation-follow';
import { MessageFeed } from './message-feed';
import type { Message } from '../lib/types';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function row(id: string, extra: Partial<Message> = {}): Message {
  return { id, workstreamId: 'one', authorType: 'human', messageType: 'text',
    sequenceNumber: 1, createdAt: '2026-09-05T00:00:00Z', text: id, ...extra };
}

describe('conversation motion', () => {
  it('only animates live arrivals once, including optimistic reconciliation', () => {
    const animate = vi.fn();
    const original = HTMLElement.prototype.animate;
    HTMLElement.prototype.animate = animate;
    try {
      const props = { onAnswerElicitation: async () => undefined };
      const view = render(<MessageFeed {...props} messages={[row('history')]} />);
      expect(animate).not.toHaveBeenCalled();
      const messages = [row('older'), row('history'), row('live', { clientMessageId: 'client' })];
      view.rerender(<MessageFeed {...props} liveMessageIds={new Set(['live'])} messages={messages} />);
      expect(animate).toHaveBeenCalledTimes(1);
      view.rerender(<MessageFeed {...props} liveMessageIds={new Set(['live'])} messages={messages} />);
      view.rerender(<MessageFeed {...props} liveMessageIds={new Set(['canonical'])} messages={[row('canonical', { clientMessageId: 'client' })]} />);
      view.rerender(<MessageFeed {...props} liveMessageIds={new Set(['live'])} messages={messages} />);
      expect(animate).toHaveBeenCalledTimes(1);
    } finally { HTMLElement.prototype.animate = original; vi.unstubAllGlobals(); }
  });

  it('consumes reduced-motion arrivals instead of replaying them later', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const original = HTMLElement.prototype.animate;
    const animate = vi.fn();
    HTMLElement.prototype.animate = animate;
    try {
      const props = { onAnswerElicitation: async () => undefined, messages: [row('live')], liveMessageIds: new Set(['live']) };
      const view = render(<MessageFeed {...props} />);
      vi.stubGlobal('matchMedia', () => ({ matches: false }));
      view.rerender(<MessageFeed {...props} />);
      expect(animate).not.toHaveBeenCalled();
    } finally { HTMLElement.prototype.animate = original; }
  });

  it('removes activity immediately under reduced motion', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const view = render(<ActivityPresence><span>Working</span></ActivityPresence>);
    expect(screen.getByText('Working')).toBeVisible();
    view.rerender(<ActivityPresence>{null}</ActivityPresence>);
    expect(screen.queryByText('Working')).toBeNull();
  });

  it('retains the disabled jump button until its exit finishes and cancels on reversal', () => {
    const animations: { onfinish: (() => void) | null; cancel: ReturnType<typeof vi.fn> }[] = [];
    const original = HTMLElement.prototype.animate;
    HTMLElement.prototype.animate = vi.fn(() => {
      const animation = { onfinish: null, cancel: vi.fn() };
      animations.push(animation);
      return animation as unknown as Animation;
    });
    try {
      const content = (visible: boolean) => <Tooltip.Provider><JumpToLatestButton onJump={() => undefined} visible={visible} /></Tooltip.Provider>;
      const view = render(content(true));
      view.rerender(content(false));
      expect(screen.getByRole('button', { hidden: true })).toBeDisabled();
      const exit = animations.at(-1)!;
      view.rerender(content(true));
      expect(exit.cancel).toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeEnabled();
      view.rerender(content(false));
      act(() => animations.at(-1)!.onfinish?.());
      expect(screen.queryByRole('button', { hidden: true })).toBeNull();
    } finally { HTMLElement.prototype.animate = original; }
  });
});
