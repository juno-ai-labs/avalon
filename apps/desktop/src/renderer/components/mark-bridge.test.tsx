import * as Tooltip from '@radix-ui/react-tooltip';
import { fireEvent, render as renderBare, screen } from '@testing-library/react';
import { MarkBridge, type MarkBridgeItem } from '@rally/ui/components/mark-bridge';
import { TitlePillHeader, type TitlePillLevel } from '@rally/ui/components/title-pill';
import { Building, Sparkles } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';

// The app mounts one tooltip provider at its root; a mark's tooltip needs it.
const render = (ui: React.ReactElement): ReturnType<typeof renderBare> => renderBare(ui, { wrapper: Tooltip.Provider });

const channel = { shape: 'squircle', icon: Building, tint: 'rgb(255, 228, 230)', ink: 'rgb(159, 18, 57)' } as const;
const thread = { shape: 'circle', icon: Sparkles, tint: 'rgb(254, 243, 199)', ink: 'rgb(146, 64, 14)' } as const;

function items(onChannel?: () => void, onThread?: () => void): MarkBridgeItem[] {
  return [
    { key: 'channel', mark: channel, name: 'General', action: 'Open channel', onSelect: onChannel },
    { key: 'thread', mark: thread, name: 'Prepare the Acme follow-up', action: 'Open thread', onSelect: onThread },
  ];
}

describe('MarkBridge', () => {
  it('makes each mark a control named for what it does, and runs only its own', () => {
    const openChannel = vi.fn();
    const openThread = vi.fn();
    render(<MarkBridge items={items(openChannel, openThread)} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open thread: Prepare the Acme follow-up' }));

    expect(openThread).toHaveBeenCalledOnce();
    expect(openChannel).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Open channel: General' })).toBeInTheDocument();
  });

  it('draws a mark with nowhere to go as a picture, not a control', () => {
    render(<MarkBridge items={items(undefined, vi.fn())} />);

    expect(screen.queryByRole('button', { name: /General/u })).toBeNull();
    expect(screen.getByRole('img', { name: 'Open channel: General' })).toBeInTheDocument();
  });

  it('names the object and what selecting it does in its tooltip', async () => {
    render(<MarkBridge items={items(vi.fn(), vi.fn())} />);

    fireEvent.pointerMove(screen.getByRole('button', { name: 'Open channel: General' }), { pointerType: 'mouse' });

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('General');
    expect(tooltip).toHaveTextContent('Open channel');
  });
});

describe('TitlePillHeader', () => {
  const level = (key: string, title: string, bridge?: TitlePillLevel['bridge'], onSelect?: () => void): TitlePillLevel => ({
    key,
    icon: null,
    title,
    label: title,
    ...(bridge ? { bridge } : {}),
    ...(onSelect ? { onSelect } : {}),
  });

  it('fuses ancestors that all have marks into one bridge, each mark selecting its level', () => {
    const openChannel = vi.fn();
    render(<TitlePillHeader
      ancestors={[
        level('channel', 'General', { mark: channel, name: 'General', action: 'Open channel' }, openChannel),
        level('thread', 'Prepare', { mark: thread, name: 'Prepare', action: 'Open thread' }, vi.fn()),
      ]}
      current={level('breakout', 'Rollout')}
    />);

    fireEvent.click(screen.getByRole('button', { name: 'Open channel: General' }));

    expect(openChannel).toHaveBeenCalledOnce();
  });

  it('keeps the pills alone when an ancestor has no mark to show', () => {
    render(<TitlePillHeader
      ancestors={[
        level('channel', 'General', undefined, vi.fn()),
        level('thread', 'Prepare', { mark: thread, name: 'Prepare', action: 'Open thread' }, vi.fn()),
      ]}
      current={level('breakout', 'Rollout')}
    />);

    expect(screen.queryByRole('button', { name: 'Open thread: Prepare' })).toBeNull();
  });
});
