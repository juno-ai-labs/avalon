import * as Tooltip from '@radix-ui/react-tooltip';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityPresence, JumpToLatestButton } from './conversation-follow';
import { MessageFeed } from './message-feed';
import type { Message } from '../lib/types';

const animations: { onfinish: (() => void) | null; cancel: ReturnType<typeof vi.fn>; reverse: ReturnType<typeof vi.fn>; playState: string }[] = [];
const animate = vi.fn<(frames: Keyframe[], options: KeyframeAnimationOptions) => Animation>(() => {
  const animation = { onfinish: null, cancel: vi.fn(), reverse: vi.fn(), playState: 'running' };
  animations.push(animation);
  return animation as unknown as Animation;
});
let originalAnimate: PropertyDescriptor | undefined;
let reducedMotion = false;
let hidden = false;
beforeEach(() => {
  originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, writable: true, value: animate });
  animate.mockClear();
  animations.length = 0;
  reducedMotion = false;
  hidden = false;
  vi.stubGlobal('matchMedia', () => ({ matches: reducedMotion }));
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => hidden ? 'hidden' : 'visible');
});
afterEach(() => {
  cleanup();
  if (originalAnimate) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate);
  else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function row(id: string, extra: Partial<Message> = {}): Message {
  return { id, workstreamId: 'one', authorType: 'human', messageType: 'text',
    sequenceNumber: 1, createdAt: '2026-09-05T00:00:00Z', text: id, ...extra };
}

describe('conversation motion', () => {
  it('only animates live arrivals once, including optimistic reconciliation', () => {
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
  });

  it('consumes reduced-motion arrivals instead of replaying them later', () => {
    reducedMotion = true;
      const props = { onAnswerElicitation: async () => undefined, messages: [row('live')], liveMessageIds: new Set(['live']) };
      const view = render(<MessageFeed {...props} />);
      reducedMotion = false;
      view.rerender(<MessageFeed {...props} messages={[...props.messages]} />);
      expect(animate).not.toHaveBeenCalled();
  });

  it('removes activity immediately under reduced motion', () => {
    reducedMotion = true;
    const view = render(<ActivityPresence><span>Working</span></ActivityPresence>);
    expect(screen.getByText('Working')).toBeVisible();
    view.rerender(<ActivityPresence>{null}</ActivityPresence>);
    expect(screen.queryByText('Working')).toBeNull();
  });

  it.each(['jump', 'activity'])('retains and reverses %s without restarting entrance or flashing at exit', (kind) => {
      const content = (visible: boolean) => kind === 'jump'
        ? <Tooltip.Provider><JumpToLatestButton onJump={() => undefined} visible={visible} /></Tooltip.Provider>
        : <ActivityPresence>{visible ? <span>Working</span> : null}</ActivityPresence>;
      const view = render(content(false));
      view.rerender(content(true));
      expect(animate).toHaveBeenCalledTimes(1);
      expect(animations[0]!.cancel).not.toHaveBeenCalled();
      view.rerender(content(false));
      if (kind === 'jump') expect(screen.getByRole('button', { hidden: true })).toBeDisabled();
      const exit = animations.at(-1)!;
      view.rerender(content(true));
      expect(exit.reverse).toHaveBeenCalledTimes(2);
      expect(animate).toHaveBeenCalledTimes(1);
      view.rerender(content(false));
      expect(animate.mock.calls[0]?.[1]).toMatchObject({ fill: 'forwards' });
      act(() => { exit.playState = 'finished'; exit.onfinish?.(); });
      expect(screen.queryByRole('button', { hidden: true })).toBeNull();
      expect(screen.queryByText('Working')).toBeNull();
      view.rerender(content(true));
      expect(animate).toHaveBeenCalledTimes(2);
  });

  it('animates independent plugin groups after text in the same turn', () => {
    const props = { onAnswerElicitation: async () => undefined };
    const text = row('turn:text', { transcriptTurnId: 'turn' });
    const view = render(<MessageFeed {...props} liveMessageIds={new Set([text.id])} messages={[text]} />);
    const plugin = row('turn:tool:1:plugin-group:browser', { transcriptTurnId: 'turn', messageType: 'plugin_activity' });
    const other = row('turn:tool:2:plugin-group:files', { transcriptTurnId: 'turn', messageType: 'plugin_activity' });
    view.rerender(<MessageFeed {...props} liveMessageIds={new Set(['turn:tool:1', 'turn:tool:2'])} messages={[text, plugin, other]} />);
    expect(animate.mock.contexts.map((element) => (element as HTMLElement).dataset.arrivalId)).toEqual([text.id, plugin.id, other.id]);
    view.rerender(<MessageFeed {...props} liveMessageIds={new Set(['stored:text'])} messages={[row('stored:text', { transcriptTurnId: 'turn' }), plugin, other]} />);
    expect(animate).toHaveBeenCalledTimes(3);
  });

  it('consumes hidden-window arrivals without replaying them when shown', () => {
    hidden = true;
    const props = { onAnswerElicitation: async () => undefined, messages: [row('live')], liveMessageIds: new Set(['live']) };
    const view = render(<MessageFeed {...props} />);
    hidden = false;
    view.rerender(<MessageFeed {...props} messages={[...props.messages]} />);
    expect(animate).not.toHaveBeenCalled();
  });
});
