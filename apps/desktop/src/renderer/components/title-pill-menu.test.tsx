import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChannelMenu } from '@rally/ui/components/conversation-menus';
import { TitlePill } from '@rally/ui/components/title-pill';

const member = { id: 'user-1', name: 'Adam', email: 'adam@example.test', timezone: 'UTC' };

function renderChannelPill(overrides: Partial<React.ComponentProps<typeof ChannelMenu>> = {}): void {
  render(<TitlePill level={{
    key: 'channel:c1',
    icon: null,
    title: 'Launch',
    label: 'Channel menu: Launch',
    menu: <ChannelMenu
      breakouts={[{ substreamId: 'b1', title: 'Pricing' }]}
      onOpenBreakout={vi.fn()}
      openSubstreamId={null}
      presentUserIds={[]}
      sidekicks={[]}
      workstream={{ id: 'c1', title: 'Launch', scope: 'personal', participants: [member], resources: [] }}
      {...overrides}
    />,
  }} />);
}

function openMenu(): void {
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Channel menu: Launch' }), { button: 0, ctrlKey: false });
}

describe('a title pill menu with levels', () => {
  it('opens at a root of actions and one row each for people, Sidekicks and Breakouts', async () => {
    renderChannelPill();
    openMenu();

    expect(await screen.findByRole('menuitem', { name: /^People\s*1 · Private/u })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /^Sidekicks\s*None yet/u })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /^Breakouts\s*1/u })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Add people' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'More' })).toBeInTheDocument();
  });

  it('turns the pill into a breadcrumb for the open level, and steps back before it closes', async () => {
    renderChannelPill();
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Breakouts/u }));

    expect(await screen.findByRole('button', { name: 'Channel menu: Launch, Breakouts' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Pricing/u })).toBeInTheDocument();

    // Escape returns to the root first; only a second Escape would close.
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(await screen.findByRole('menuitem', { name: /^People/u })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Channel menu: Launch' })).toBeInTheDocument();
  });

  it('goes back to the root from the breadcrumb’s first step, keeping the menu open', async () => {
    renderChannelPill();
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'More' }));
    expect(await screen.findByRole('button', { name: 'Channel menu: Launch, More' })).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByText('Launch'), { button: 0 });

    expect(await screen.findByRole('menuitem', { name: /^People/u })).toBeInTheDocument();
  });

  it('reopens at the root wherever it was closed', async () => {
    renderChannelPill();
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Sidekicks/u }));
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    openMenu();
    expect(await screen.findByRole('menuitem', { name: /^People/u })).toBeInTheDocument();
  });

  it('pins and unpins from a switch in More', async () => {
    const onChange = vi.fn();
    renderChannelPill({ pinned: { on: false, onChange } });
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'More' }));

    const pin = await screen.findByRole('menuitemcheckbox', { name: 'Pinned in sidebar' });
    expect(pin).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(pin);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('lists a Channel’s other resources in More and opens one through the host', async () => {
    const onOpenResource = vi.fn();
    renderChannelPill({
      onOpenResource,
      workstream: { id: 'c1', title: 'Launch', scope: 'personal', participants: [member], resources: [
        { id: 'r1', title: 'Pricing sheet', resourceType: 'spreadsheet', direction: 'artifact', currentVersion: 1 },
        { id: 'r2', title: 'Launch brief', resourceType: 'document', direction: 'input', currentVersion: 3 },
      ] },
    });
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'More' }));

    expect(await screen.findByText('Artifacts')).toBeInTheDocument();
    expect(screen.getByText('Resources')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: /Launch brief/u }));
    expect(onOpenResource).toHaveBeenCalledWith('r2', expect.any(HTMLElement));
  });

  it('adds someone from the People level, with only people not already in it suggested', async () => {
    const onAdd = vi.fn();
    const newcomer = { id: 'user-2', name: 'Jordan', email: 'jordan@example.test', timezone: 'UTC' };
    renderChannelPill({ people: { candidates: [member, newcomer], onAdd, adding: false, currentUserId: member.id } });
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add people' }));

    expect(await screen.findByText('You')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add Adam' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Add someone by name or email' }), { target: { value: 'jor' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Jordan' }));
    expect(onAdd).toHaveBeenCalledWith(newcomer);
  });

  it('keeps keyboard focus in the menu across levels, and returns it to the row it left', async () => {
    const newcomer = { id: 'user-2', name: 'Jordan', email: 'jordan@example.test', timezone: 'UTC' };
    renderChannelPill({ people: { candidates: [member, newcomer], onAdd: vi.fn(), adding: false, currentUserId: member.id } });
    openMenu();
    const peopleRow = await screen.findByRole('menuitem', { name: /^People/u });
    peopleRow.focus();
    fireEvent.keyDown(peopleRow, { key: 'Enter' });

    // Entering a level with a search puts the caret in it.
    const search = await screen.findByRole('textbox', { name: 'Add someone by name or email' });
    expect(search).toHaveFocus();
    // Tab reaches the Add button, which is not a menu item.
    fireEvent.change(search, { target: { value: 'jor' } });
    fireEvent.keyDown(search, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'Add Jordan' })).toHaveFocus();

    // Escape returns to the root with focus on the row that led here.
    fireEvent.keyDown(screen.getByRole('button', { name: 'Add Jordan' }), { key: 'Escape' });
    expect(await screen.findByRole('menuitem', { name: /^People/u })).toHaveFocus();
  });

  it('steps back with the left arrow from an item, but not from a key a nested menu already handled', async () => {
    renderChannelPill();
    openMenu();
    const row = await screen.findByRole('menuitem', { name: /^Breakouts/u });
    row.focus();
    fireEvent.keyDown(row, { key: 'Enter' });
    const breakout = await screen.findByRole('menuitem', { name: /Pricing/u });
    expect(breakout).toHaveFocus();

    // A submenu inside the level closes itself on ArrowLeft and marks the key handled.
    breakout.addEventListener('keydown', (event) => event.preventDefault(), { once: true });
    fireEvent.keyDown(breakout, { key: 'ArrowLeft' });
    expect(screen.getByRole('menuitem', { name: /Pricing/u })).toBeInTheDocument();

    fireEvent.keyDown(breakout, { key: 'ArrowLeft' });
    expect(await screen.findByRole('menuitem', { name: /^Breakouts/u })).toHaveFocus();
  });
});
