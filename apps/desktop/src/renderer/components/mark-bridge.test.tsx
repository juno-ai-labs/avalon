import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Tooltip from '@radix-ui/react-tooltip';
import { fireEvent, render as renderBare, screen } from '@testing-library/react';
import { MarkBridge, type MarkBridgeItem } from '@rally/ui/components/mark-bridge';
import { PhoneHeaderContext, TitlePillHeader, type PhoneHeader, type TitlePillLevel } from '@rally/ui/components/title-pill';
import { Building, Sparkles } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

  it('gives a mark that opens a menu its tooltip too', async () => {
    render(<MarkBridge items={[{ key: 'folded', mark: thread, name: 'Show path', menu: items(vi.fn(), vi.fn()) }]} />);

    fireEvent.pointerMove(screen.getByRole('button', { name: 'Show path' }), { pointerType: 'mouse' });

    expect(await screen.findByRole('tooltip')).toHaveTextContent('Show path');
  });

  it('draws nothing for no marks', () => {
    const { container } = render(<MarkBridge items={[]} />);

    expect(container).toBeEmptyDOMElement();
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

  it('keeps the Channel crumb as an icon and names only the current thread', () => {
    const openChannel = vi.fn();
    render(<TitlePillHeader
      ancestors={[level('channel', 'General', { mark: channel, name: 'General', action: 'Open channel' }, openChannel)]}
      current={level('thread', 'Prepare')}
    />);

    const crumb = screen.getByRole('button', { name: 'Open channel: General' });
    expect(crumb.textContent).toBe('');
    expect(screen.getByText('Prepare')).toBeInTheDocument();
    fireEvent.click(crumb);

    expect(openChannel).toHaveBeenCalledOnce();
  });

  it('keeps the current icon action separate from its menu while attached to crumbs', async () => {
    const changeIcon = vi.fn();
    render(<TitlePillHeader
      ancestors={[level('channel', 'GTM', { mark: channel, name: 'GTM', action: 'Open channel' }, vi.fn())]}
      current={{
        ...level('thread', 'Cold email'),
        iconAction: <button aria-label="Change Cold email icon" onClick={changeIcon} type="button">Icon</button>,
        menu: <DropdownMenu.Item>Rename</DropdownMenu.Item>,
      }}
    />);

    fireEvent.click(screen.getByRole('button', { name: 'Change Cold email icon' }));
    expect(changeIcon).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    fireEvent.pointerDown(screen.getByRole('button', { name: /^Cold email$/u }), { button: 0, ctrlKey: false, pointerType: 'mouse' });
    expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
    expect(changeIcon).toHaveBeenCalledOnce();
  });

  it('keeps its open menu while ancestor marks arrive and disappear', async () => {
    const current = {
      ...level('thread', 'Cold email'),
      menu: <DropdownMenu.Item>Rename</DropdownMenu.Item>,
    };
    const openChannel = vi.fn();
    const ancestor = level('channel', 'GTM', undefined, openChannel);
    const { rerender } = render(<TitlePillHeader ancestors={[ancestor]} current={current} />);
    const trigger = screen.getByRole('button', { name: 'Cold email' });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();

    rerender(<TitlePillHeader ancestors={[{
      ...ancestor, bridge: { mark: channel, name: 'GTM', action: 'Open channel' },
    }]} current={current} />);
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cold email' })).toBe(trigger);

    rerender(<TitlePillHeader ancestors={[ancestor]} current={current} />);
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cold email' })).toBe(trigger);
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

  describe('at phone width, as the screen\'s only header', () => {
    const phoneWidth = (matches: boolean): void => {
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
      }));
    };
    afterEach(() => vi.unstubAllGlobals());
    const header = (openNavigation: () => void, search: () => void): PhoneHeader => ({
      openNavigation,
      actions: [{ key: 'search', label: 'Search organization', icon: null, onSelect: search }],
    });
    const crumbs = [level('channel', 'General', { mark: channel, name: 'General', action: 'Open channel' }, vi.fn())];

    it('leads the crumbs with a menu button, which opens the navigation', () => {
      phoneWidth(true);
      const openNavigation = vi.fn();
      render(<PhoneHeaderContext value={header(openNavigation, vi.fn())}>
        <TitlePillHeader ancestors={crumbs} current={level('thread', 'Prepare')} />
      </PhoneHeaderContext>);

      const marks = screen.getAllByRole('button', { name: /^Open/u });
      expect(marks.map((mark) => mark.getAttribute('aria-label'))).toEqual(['Open navigation', 'Open channel: General']);
      expect(marks[0]!.closest('.mark-bridge')).toBeNull();
      expect(marks[1]!.closest('.mark-bridge')).not.toBeNull();
      fireEvent.click(marks[0]!);
      expect(openNavigation).toHaveBeenCalledOnce();
    });

    it('offers search ahead of the pane\'s own actions in its "More" menu', async () => {
      phoneWidth(true);
      const search = vi.fn();
      render(<PhoneHeaderContext value={header(vi.fn(), search)}>
        <TitlePillHeader
          actions={[{ key: 'expand', label: 'Expand', icon: null, onSelect: vi.fn() }]}
          current={level('thread', 'Prepare')}
        />
      </PhoneHeaderContext>);

      fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions' }), { button: 0, ctrlKey: false, pointerType: 'mouse' });
      const items = await screen.findAllByRole('menuitem');
      expect(items.map((item) => item.textContent)).toEqual(['Search organization', 'Expand']);
      fireEvent.click(items[0]!);
      expect(search).toHaveBeenCalledOnce();
    });

    const deep = (openChannel = vi.fn()): TitlePillLevel[] => [
      level('channel', 'General', { mark: channel, name: 'General', action: 'Open channel' }, openChannel),
      level('thread', 'Prepare', { mark: thread, name: 'Prepare', action: 'Open thread' }, vi.fn()),
      level('breakout', 'Rollout', { mark: thread, name: 'Rollout', action: 'Open breakout' }, vi.fn()),
    ];

    it('folds crumbs past two into a "…" mark beside the nearest, listing the rest in its menu', async () => {
      phoneWidth(true);
      const openChannel = vi.fn();
      render(<PhoneHeaderContext value={header(vi.fn(), vi.fn())}>
        <TitlePillHeader ancestors={deep(openChannel)} current={level('artifact', 'Guide')} />
      </PhoneHeaderContext>);

      expect(screen.getAllByRole('button').map((mark) => mark.getAttribute('aria-label')).slice(0, 3))
        .toEqual(['Open navigation', 'Show path', 'Open breakout: Rollout']);
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Show path' }), { button: 0, ctrlKey: false, pointerType: 'mouse' });
      const items = await screen.findAllByRole('menuitem');
      expect(items.map((item) => item.textContent)).toEqual(['General', 'Prepare']);
      fireEvent.click(items[0]!);
      expect(openChannel).toHaveBeenCalledOnce();
    });

    it('keeps two crumbs as they are', () => {
      phoneWidth(true);
      render(<PhoneHeaderContext value={header(vi.fn(), vi.fn())}>
        <TitlePillHeader ancestors={deep().slice(0, 2)} current={level('breakout', 'Rollout')} />
      </PhoneHeaderContext>);

      expect(screen.queryByRole('button', { name: 'Show path' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Open channel: General' })).toBeInTheDocument();
    });

    it('folds nothing wider than a phone', () => {
      phoneWidth(false);
      render(<TitlePillHeader ancestors={deep()} current={level('artifact', 'Guide')} />);

      expect(screen.queryByRole('button', { name: 'Show path' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Open channel: General' })).toBeInTheDocument();
    });

    it('carries neither wider than a phone', () => {
      phoneWidth(false);
      render(<PhoneHeaderContext value={header(vi.fn(), vi.fn())}>
        <TitlePillHeader ancestors={crumbs} current={level('thread', 'Prepare')} />
      </PhoneHeaderContext>);

      expect(screen.queryByRole('button', { name: 'Open navigation' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
    });
  });
});
