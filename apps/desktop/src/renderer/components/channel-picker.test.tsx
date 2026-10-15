import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChannelPicker, joinLabels, type ChannelOption } from './channel-picker';

const OPTIONS: ChannelOption[] = [
  { id: 'push', label: 'Push', hint: 'On every device signed in', icon: null },
  { id: 'email', label: 'Email', hint: 'To you@example.test', icon: null },
  { id: 'slack_agent_dm', label: 'Slack', hint: 'A direct message from Rally in your Slack.', icon: null },
];

/**
 * jsdom lays nothing out, so the row's width and what its buttons need are
 * stated: the row is `rowWidth` wide and the buttons together take 300.
 */
function layOut(rowWidth: number) {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('row') ? rowWidth : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('channel-chips-probe') ? 300 : 0;
  });
}

function renderPicker(onToggle = vi.fn()) {
  render(
    <div className="row">
      <span>Mentions</span>
      <ChannelPicker label="How to tell you about mentions" none="Digest only" onToggle={onToggle} options={OPTIONS} selected={['push']} />
    </div>,
  );
  return onToggle;
}

afterEach(() => vi.restoreAllMocks());

describe('ChannelPicker', () => {
  it('given room beside the words for every option, then shows a button each, pressed when chosen', () => {
    layOut(600);
    const onToggle = renderPicker();

    const group = screen.getByRole('group', { name: 'How to tell you about mentions' });
    expect(screen.getByRole('button', { name: 'Push', pressed: true })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Slack', pressed: false }));
    expect(onToggle).toHaveBeenCalledWith('slack_agent_dm');
    expect(group).toBeInTheDocument();
  });

  it('given too little room, then shows one menu saying what is chosen, with a checkbox per option', async () => {
    layOut(450);
    const onToggle = renderPicker();

    const trigger = screen.getByRole('button', { name: 'How to tell you about mentions' });
    expect(trigger).toHaveTextContent('Push');
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /^Email/u }));
    expect(onToggle).toHaveBeenCalledWith('email');
    // Still open: choosing several is the point.
    expect(screen.getByRole('menuitemcheckbox', { name: /^Push/u })).toHaveAttribute('aria-checked', 'true');
  });
});

describe('joinLabels', () => {
  it('reads as a sentence', () => {
    expect([joinLabels([]), joinLabels(['Push']), joinLabels(['Push', 'Slack']), joinLabels(['Push', 'Email', 'Slack'])])
      .toEqual(['', 'Push', 'Push and Slack', 'Push, Email and Slack']);
  });
});
