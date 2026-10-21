import * as Tooltip from '@radix-ui/react-tooltip';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MemoryReviewFact } from '@rally/contracts';
import { describe, expect, it, vi } from 'vitest';
import { BreakoutMenu, ChannelMenu } from '@rally/ui/components/conversation-menus';
import { TitlePill } from '@rally/ui/components/title-pill';

const member = { id: 'user-1', name: 'Adam', email: 'adam@example.test', timezone: 'UTC' };

function channelPill(overrides: Partial<React.ComponentProps<typeof ChannelMenu>> = {}): React.JSX.Element {
  return <Tooltip.Provider><TitlePill level={{
    key: 'channel:c1',
    icon: null,
    title: 'Launch',
    label: 'Thread menu: Launch',
    onMenuOpen: overrides.people?.onOpen,
    menu: <ChannelMenu
      breakouts={[{ substreamId: 'b1', title: 'Pricing' }]}
      onOpenBreakout={vi.fn()}
      openSubstreamId={null}
      presentUserIds={[]}
      sidekicks={[]}
      workstream={{ id: 'c1', title: 'Launch', scope: 'personal', participants: [member], resources: [] }}
      {...overrides}
    />,
  }} /></Tooltip.Provider>;
}

function renderChannelPill(overrides: Partial<React.ComponentProps<typeof ChannelMenu>> = {}): ReturnType<typeof render> {
  return render(channelPill(overrides));
}

function openMenu(): void {
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Thread menu: Launch' }), { button: 0, ctrlKey: false });
}

describe('a title pill menu with levels', () => {
  it('opens at a root of actions and one row each for people, Sidekicks and Breakouts', async () => {
    renderChannelPill();
    openMenu();

    expect(await screen.findByRole('menuitem', { name: /^People\s*1 · Private/u })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /^Sidekicks\s*None yet/u })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /^Breakouts\s*1/u })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /^Channels/u })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Add people' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'More' })).toBeInTheDocument();
  });

  it('offers the thread’s Merge as a row named for its Channel, and only when given one', async () => {
    const onSelect = vi.fn();
    renderChannelPill({ actions: { merge: { label: 'Merge to GTM', onSelect } } });
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Merge to GTM' }));
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('offers Resolve Thread immediately after Merge and passes its conversation target', async () => {
    const onResolve = vi.fn();
    renderChannelPill({ actions: { merge: { label: 'Merge to GTM', onSelect: vi.fn() }, onResolve } });
    openMenu();
    const resolve = await screen.findByRole('menuitem', { name: 'Resolve Thread' });
    expect(resolve.previousElementSibling).toHaveTextContent('Merge to GTM');
    fireEvent.click(resolve);
    expect(onResolve).toHaveBeenCalledWith({ substreamId: '0', title: 'Launch' });
  });

  it('offers Resolve Breakout below Merge with the breakout target', async () => {
    const onResolve = vi.fn();
    render(<Tooltip.Provider><TitlePill level={{ key: 'breakout:b1', icon: null, title: 'Pricing', label: 'Breakout menu: Pricing',
      menu: <BreakoutMenu breakout={{ substreamId: 'b1', title: 'Pricing' }} channel={{ id: 'c1', title: 'Launch' }}
        participants={[]} presentUserIds={[]} actions={{ merge: { label: 'Merge to thread', onSelect: vi.fn() }, onResolve }} />,
    }} /></Tooltip.Provider>);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Breakout menu: Pricing' }), { button: 0, ctrlKey: false });
    const resolve = await screen.findByRole('menuitem', { name: 'Resolve Breakout' });
    expect(resolve.previousElementSibling).toHaveTextContent('Merge to thread');
    fireEvent.click(resolve);
    expect(onResolve).toHaveBeenCalledWith({ substreamId: 'b1', title: 'Pricing' });
  });

  it('has no Merge row where nothing can merge', async () => {
    renderChannelPill();
    openMenu();
    await screen.findByRole('menuitem', { name: /^People/u });
    expect(screen.queryByRole('menuitem', { name: /^Merge/u })).not.toBeInTheDocument();
  });

  it('turns the pill into a breadcrumb for the open level, and steps back before it closes', async () => {
    renderChannelPill();
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Breakouts/u }));

    expect(await screen.findByRole('button', { name: 'Thread menu: Launch, Breakouts' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Pricing/u })).toBeInTheDocument();

    // Escape returns to the root first; only a second Escape would close.
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(await screen.findByRole('menuitem', { name: /^People/u })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Thread menu: Launch' })).toBeInTheDocument();
  });

  it('goes back to the root from the breadcrumb’s first step, keeping the menu open', async () => {
    renderChannelPill();
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'More' }));
    expect(await screen.findByRole('button', { name: 'Thread menu: Launch, More' })).toBeInTheDocument();

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

  it('lists the conversation’s remembered facts in its Memory level, removing one and opening a source', async () => {
    const remembered = (factId: string, text: string, removable: boolean): MemoryReviewFact => ({
      factId, subjectKind: 'thread', subjectTitle: 'Launch', kind: 'standing', text,
      validFrom: null, validUntil: null, recordedAt: '2026-10-01T12:00:00.000Z', conflict: false, derivedFrom: 'person',
      source: { kind: 'breakout', workstreamId: 'c1', substreamId: 'b1', title: 'Pricing' }, removable,
    });
    const onOpen = vi.fn();
    const onRemove = vi.fn();
    const onOpenSource = vi.fn();
    renderChannelPill({ memory: {
      facts: [remembered('f1', 'Launch is on Nov 4.', true), remembered('f2', 'Legal signs off first.', false)],
      onOpen, onRemove, onOpenSource,
      removals: { f1: { pending: false, refusal: 'You can’t remove this.' } },
    } });
    openMenu();

    fireEvent.click(await screen.findByRole('menuitem', { name: /^Memory\s*2/u }));
    expect(await screen.findByRole('button', { name: 'Thread menu: Launch, Memory' })).toBeInTheDocument();
    expect(onOpen).toHaveBeenCalledOnce();
    expect(screen.getByText('Launch is on Nov 4.')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('You can’t remove this.');
    // Remove only where the server allows it.
    expect(screen.queryByRole('button', { name: 'Remove “Legal signs off first.”' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove “Launch is on Nov 4.”' }));
    expect(onRemove).toHaveBeenCalledWith('f1');

    fireEvent.click(screen.getAllByRole('menuitem', { name: 'Pricing' })[0]!);
    expect(onOpenSource).toHaveBeenCalledWith({ kind: 'breakout', workstreamId: 'c1', substreamId: 'b1', title: 'Pricing' });
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('counts None yet in the Memory row of a conversation with nothing remembered, and says so in its level', async () => {
    renderChannelPill({ memory: { facts: [], onRemove: vi.fn() } });
    openMenu();
    expect(await screen.findByRole('menuitem', { name: /^Memory\s*None yet/u })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: /^Memory/u }));
    expect(await screen.findByText('Rally has not remembered anything about this thread yet.')).toBeInTheDocument();
  });

  it('pins and unpins from a switch in More', async () => {
    const onChange = vi.fn();
    renderChannelPill({ pinned: { on: false, onChange } });
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'More' }));

    const pin = await screen.findByRole('menuitemcheckbox', { name: 'Pinned in my sidebar' });
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
    const onAdd = vi.fn(() => Promise.resolve());
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

  it('lists people who asked to join above Suggested, answered in place and not suggested again', async () => {
    const onDecide = vi.fn();
    const asker = { id: 'user-3', name: 'Samantha Lee', email: 'sam@example.test', timezone: 'UTC' };
    const other = { id: 'user-2', name: 'Jordan', email: 'jordan@example.test', timezone: 'UTC' };
    renderChannelPill({ people: {
      candidates: [member, asker, other], onAdd: vi.fn(() => Promise.resolve()), adding: false, currentUserId: member.id,
      requests: { items: [{ id: 'r1', userId: asker.id, name: asker.name }], onDecide },
    } });
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add people' }));

    const headings = [...document.querySelectorAll('.title-menu-section-heading')].map((node) => node.textContent);
    expect(headings).toEqual(['Asked to join', 'Suggested']);
    expect(screen.getByText('sam@example.test')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add Samantha Lee' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Jordan' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve Samantha Lee' }));
    expect(onDecide).toHaveBeenCalledWith('r1', 'approve');
    fireEvent.click(screen.getByRole('button', { name: 'Decline Samantha Lee' }));
    expect(onDecide).toHaveBeenLastCalledWith('r1', 'decline');
  });

  it('shows no Asked to join section when nobody asked', async () => {
    renderChannelPill({ people: {
      candidates: [member], onAdd: vi.fn(() => Promise.resolve()), adding: false, currentUserId: member.id,
      requests: { items: [], onDecide: vi.fn() },
    } });
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add people' }));
    expect(await screen.findByText('You')).toBeInTheDocument();
    expect(screen.queryByText('Asked to join')).not.toBeInTheDocument();
  });

  it('shows five ranked suggestions in one list, while search can reach every other person', async () => {
    const candidates = Array.from({ length: 14 }, (_, index) => ({
      id: `person-${index}`, name: `Person ${String(index).padStart(2, '0')}`, email: `person-${index}@example.test`, timezone: 'UTC',
      ...(index === 13 ? { accessClass: 'guest' as const } : {}),
    }));
    const onAdd = vi.fn(() => Promise.resolve());
    renderChannelPill({ people: {
      candidates: [member, ...candidates, { ...candidates[0]!, id: 'inactive', status: 'suspended' }], onAdd, adding: false,
      ranking: {
        channel: [member.id, 'inactive', 'missing', ...candidates.slice(0, 7).map((person) => person.id)],
        organization: candidates.slice(0, 12).map((person) => person.id),
      },
    } });
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add people' }));
    const sections = [...document.querySelectorAll('.title-menu-section-heading')];
    expect(sections.map((node) => node.textContent)).toEqual(['Suggested']);
    expect(screen.getAllByRole('button', { name: /^Add Person/u }).map((button) => button.getAttribute('aria-label')))
      .toEqual(['Add Person 00', 'Add Person 01', 'Add Person 02', 'Add Person 03', 'Add Person 04']);
    const search = screen.getByRole('textbox', { name: 'Add someone by name or email' });
    fireEvent.change(search, { target: { value: 'person' } });
    expect(screen.getAllByRole('button', { name: /^Add Person/u })).toHaveLength(14);
    fireEvent.change(search, { target: { value: 'PERSON-13@' } });
    expect(screen.getAllByRole('button', { name: /^Add Person/u }).map((button) => button.getAttribute('aria-label'))).toEqual(['Add Person 13']);
    fireEvent.click(screen.getByRole('button', { name: 'Add Person 13' }));
    expect(onAdd).toHaveBeenCalledWith(candidates[13]);
    fireEvent.change(search, { target: { value: '' } });
    expect(screen.getAllByRole('button', { name: /^Add Person/u })).toHaveLength(5);
  });

  it('fills five suggestions from Channel interactions, Organization interactions, Members, then Guests', async () => {
    const person = (id: string, name: string) => ({ id, name, email: `${id}@example.test`, timezone: 'UTC' });
    renderChannelPill({ people: {
      candidates: [member, person('channel', 'Zoe'), person('org', 'Ari'), person('member-z', 'Zed'), person('member-b', 'Beta'),
        { ...person('guest', 'Alex'), accessClass: 'guest' }, { ...person('guest-z', 'Zoe Guest'), accessClass: 'guest' }],
      ranking: { channel: [member.id, 'channel'], organization: ['channel', 'org'] },
      onAdd: vi.fn(() => Promise.resolve()), adding: false,
    } });
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add people' }));
    expect(screen.getAllByRole('button', { name: /^Add /u }).map((button) => button.getAttribute('aria-label')))
      .toEqual(['Add Zoe', 'Add Ari', 'Add Beta', 'Add Zed', 'Add Alex']);
  });

  it('warms ranking at the root and applies late results only on the next People opening', async () => {
    const alice = { id: 'alice', name: 'Alice', email: 'alice@example.test', timezone: 'UTC' };
    const zoe = { id: 'zoe', name: 'Zoe', email: 'zoe@example.test', timezone: 'UTC' };
    const onAdd = vi.fn(async () => undefined);
    const onOpen = vi.fn();
    const people = { candidates: [zoe, alice], onAdd, onOpen, adding: false };
    const { rerender } = renderChannelPill({ people });
    openMenu();
    await waitFor(() => expect(onOpen).toHaveBeenCalledOnce());
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add people' }));
    expect(screen.getAllByRole('button', { name: /^Add /u }).map((button) => button.getAttribute('aria-label')))
      .toEqual(['Add Alice', 'Add Zoe']);
    rerender(channelPill({ people: { ...people, ranking: { channel: ['zoe'], organization: ['zoe'] } } }));
    expect(screen.getAllByRole('button', { name: /^Add /u }).map((button) => button.getAttribute('aria-label')))
      .toEqual(['Add Alice', 'Add Zoe']);
    fireEvent.click(screen.getByRole('button', { name: 'Add Alice' }));
    expect(onAdd).toHaveBeenCalledWith(alice);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Add Alice' }), { key: 'Escape' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add people' }));
    expect(screen.getAllByRole('button', { name: /^Add /u }).map((button) => button.getAttribute('aria-label')))
      .toEqual(['Add Zoe', 'Add Alice']);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('invites new addresses as guests on Enter, adds people already in the organization, and stays open', async () => {
    const onAdd = vi.fn(() => Promise.resolve());
    const onInvite = vi.fn(() => Promise.resolve());
    const newcomer = { id: 'user-2', name: 'Jordan', email: 'jordan@example.test', timezone: 'UTC' };
    renderChannelPill({ people: {
      candidates: [member, newcomer], onAdd, adding: false, currentUserId: member.id,
      invites: { pending: ['waiting@example.test'], onInvite },
    } });
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add people' }));
    const search = await screen.findByRole('textbox', { name: 'Add someone by name or email' });

    fireEvent.change(search, { target: { value: 'New@Guest.test, jordan@example.test;adam@example.test waiting@example.test other@guest.test' } });
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(onAdd).toHaveBeenCalledExactlyOnceWith(newcomer);
    await vi.waitFor(() => expect(onInvite).toHaveBeenCalledExactlyOnceWith(['new@guest.test', 'other@guest.test']));
    await vi.waitFor(() => expect(search).toHaveValue(''));
    expect(screen.getByRole('button', { name: 'Thread menu: Launch, People' })).toBeInTheDocument();
  });

  it('suggests people invited to the organization who have not joined, and invites one here with Add', async () => {
    const onInvite = vi.fn(() => Promise.resolve());
    renderChannelPill({ people: {
      candidates: [member], onAdd: vi.fn(() => Promise.resolve()), adding: false, currentUserId: member.id,
      invitees: ['dana@example.test', 'waiting@example.test'],
      invites: { pending: ['waiting@example.test'], onInvite },
    } });
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add people' }));

    // Already invited here is listed among the people, not suggested again.
    expect(screen.queryByRole('button', { name: 'Add waiting@example.test' })).not.toBeInTheDocument();
    expect(screen.getByText('Invited', { selector: '.title-menu-person-detail' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add dana@example.test' }));

    await vi.waitFor(() => expect(onInvite).toHaveBeenCalledExactlyOnceWith(['dana@example.test']));
  });

  it('adds nobody on Enter while a name matches a member and an invitee', async () => {
    const onAdd = vi.fn(() => Promise.resolve());
    const onInvite = vi.fn(() => Promise.resolve());
    const daniel = { id: 'user-2', name: 'Daniel', email: 'daniel@example.test', timezone: 'UTC' };
    renderChannelPill({ people: {
      candidates: [member, daniel], onAdd, adding: false, currentUserId: member.id,
      invitees: ['dana@example.test'], invites: { pending: [], onInvite },
    } });
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add people' }));
    const search = await screen.findByRole('textbox', { name: 'Add someone by name or email' });

    fireEvent.change(search, { target: { value: 'dan' } });
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(screen.getByRole('alert')).toHaveTextContent('Enter email addresses separated by spaces, commas or semicolons.');
    expect(onAdd).not.toHaveBeenCalled();
    expect(onInvite).not.toHaveBeenCalled();
  });

  it('invites the one invitee a name narrows to on Enter', async () => {
    const onInvite = vi.fn(() => Promise.resolve());
    renderChannelPill({ people: {
      candidates: [member], onAdd: vi.fn(() => Promise.resolve()), adding: false, currentUserId: member.id,
      invitees: ['dana@example.test'], invites: { pending: [], onInvite },
    } });
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add people' }));
    const search = await screen.findByRole('textbox', { name: 'Add someone by name or email' });

    fireEvent.change(search, { target: { value: 'dana' } });
    fireEvent.keyDown(search, { key: 'Enter' });

    await vi.waitFor(() => expect(onInvite).toHaveBeenCalledExactlyOnceWith(['dana@example.test']));
  });

  it('keeps the typed addresses when the invite fails, and names text that is not an address', async () => {
    const onInvite = vi.fn(() => Promise.reject(new Error('refused')));
    renderChannelPill({ people: { candidates: [], onAdd: vi.fn(() => Promise.resolve()), adding: false, invites: { pending: [], onInvite } } });
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add people' }));
    const search = await screen.findByRole('textbox', { name: 'Add someone by name or email' });

    fireEvent.change(search, { target: { value: 'nobody' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(screen.getByRole('alert')).toHaveTextContent('Enter email addresses separated by spaces, commas or semicolons.');

    fireEvent.change(search, { target: { value: 'guest@example.test' } });
    expect(screen.getByText('Press Enter to invite them as a guest.')).toBeInTheDocument();
    fireEvent.keyDown(search, { key: 'Enter' });
    await vi.waitFor(() => expect(onInvite).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(search).toHaveValue('guest@example.test'));
  });

  it('adds one at a time and keeps only what failed in the box', async () => {
    let releaseFirst: () => void = () => {};
    const jordan = { id: 'user-2', name: 'Jordan', email: 'jordan@example.test', timezone: 'UTC' };
    const sam = { id: 'user-3', name: 'Sam', email: 'sam@example.test', timezone: 'UTC' };
    const onAdd = vi.fn((member: { id: string }) => member.id === jordan.id
      ? new Promise<void>((resolve) => { releaseFirst = resolve; })
      : Promise.reject(new Error('refused')));
    const onInvite = vi.fn(() => Promise.resolve());
    renderChannelPill({ people: {
      candidates: [member, jordan, sam], onAdd, adding: false, currentUserId: member.id,
      invites: { pending: [], onInvite },
    } });
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add people' }));
    const search = await screen.findByRole('textbox', { name: 'Add someone by name or email' });

    fireEvent.change(search, { target: { value: 'jordan@example.test sam@example.test guest@example.test' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    // The second add waits for the first, and a second Enter does not start another run.
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onAdd).toHaveBeenCalledExactlyOnceWith(jordan);
    releaseFirst();

    await vi.waitFor(() => expect(search).toHaveValue('sam@example.test'));
    expect(onAdd).toHaveBeenLastCalledWith(sam);
    expect(onInvite).toHaveBeenCalledExactlyOnceWith(['guest@example.test']);
  });

  it('does not submit the Enter that finishes an input method composition', async () => {
    const onAdd = vi.fn(() => Promise.resolve());
    const jordan = { id: 'user-2', name: 'Jordan', email: 'jordan@example.test', timezone: 'UTC' };
    renderChannelPill({ people: { candidates: [member, jordan], onAdd, adding: false } });
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add people' }));
    const search = await screen.findByRole('textbox', { name: 'Add someone by name or email' });

    fireEvent.change(search, { target: { value: 'jor' } });
    fireEvent.keyDown(search, { key: 'Enter', isComposing: true });
    expect(onAdd).not.toHaveBeenCalled();
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onAdd).toHaveBeenCalledWith(jordan);
  });

  it('holds new addresses until invitations load, and offers a retry when they fail', async () => {
    const onInvite = vi.fn(() => Promise.resolve());
    const onRetryLoad = vi.fn();
    renderChannelPill({ people: {
      candidates: [], onAdd: vi.fn(() => Promise.resolve()), adding: false,
      invites: { pending: undefined, loadFailed: true, onRetryLoad, onInvite },
    } });
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add people' }));
    const search = await screen.findByRole('textbox', { name: 'Add someone by name or email' });

    fireEvent.change(search, { target: { value: 'guest@example.test' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onInvite).not.toHaveBeenCalled();
    expect(screen.getByText('Invitations couldn’t be loaded. Try again.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetryLoad).toHaveBeenCalledOnce();
  });

  it('does not invite an organization member whose account is not active', async () => {
    const onInvite = vi.fn(() => Promise.resolve());
    const former = { id: 'user-4', name: 'Former', email: 'former@example.test', timezone: 'UTC', status: 'suspended' as const };
    renderChannelPill({ people: {
      candidates: [member, former], onAdd: vi.fn(() => Promise.resolve()), adding: false,
      invites: { pending: [], onInvite },
    } });
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add people' }));
    const search = await screen.findByRole('textbox', { name: 'Add someone by name or email' });

    fireEvent.change(search, { target: { value: 'former@example.test' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onInvite).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('former@example.test has an organization account that isn’t active.');
  });

  it('lists invitations still waiting among the people, and cancels one from its dots menu', async () => {
    const onRevoke = vi.fn();
    const onLoad = vi.fn();
    renderChannelPill({ people: {
      candidates: [], onAdd: vi.fn(() => Promise.resolve()), adding: false, currentUserId: member.id,
      invites: { pending: ['waiting@example.test'], onInvite: vi.fn(), onRevoke, onLoad },
    } });
    openMenu();
    expect(onLoad).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add people' }));

    expect(await screen.findByText('waiting@example.test')).toBeInTheDocument();
    expect(screen.getByText('Joins when they sign in')).toBeInTheDocument();
    expect(onLoad).toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'waiting@example.test actions' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Cancel invite' }));
    expect(onRevoke).toHaveBeenCalledWith('waiting@example.test');
  });

  it('offers to remove someone else, and to leave for the reader, from each person’s dots menu', async () => {
    const onRemove = vi.fn();
    const colleague = { id: 'user-2', name: 'Jordan', email: 'jordan@example.test', timezone: 'UTC' };
    renderChannelPill({
      people: { candidates: [], onAdd: vi.fn(() => Promise.resolve()), onRemove, adding: false, currentUserId: member.id },
      workstream: { id: 'c1', title: 'Launch', scope: 'personal', participants: [member, colleague], resources: [] },
    });
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add people' }));

    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Jordan actions' }), { button: 0, ctrlKey: false });
    const remove = await screen.findByRole('menuitem', { name: 'Remove from thread' });
    expect(remove).toHaveClass('menu-item-danger');
    fireEvent.click(remove);
    expect(onRemove).toHaveBeenCalledWith(colleague);

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Adam actions' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Leave the thread' }));
    expect(onRemove).toHaveBeenLastCalledWith(member);
  });

  it('does not let the last participant leave', async () => {
    const onRemove = vi.fn();
    renderChannelPill({ people: { candidates: [], onAdd: vi.fn(() => Promise.resolve()), onRemove, adding: false, currentUserId: member.id } });
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add people' }));

    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Adam actions' }), { button: 0, ctrlKey: false });
    expect(await screen.findByRole('menuitem', { name: 'Leave the thread' })).toHaveAttribute('data-disabled');
  });

  it('keeps keyboard focus in the menu across levels, and returns it to the row it left', async () => {
    const newcomer = { id: 'user-2', name: 'Jordan', email: 'jordan@example.test', timezone: 'UTC' };
    renderChannelPill({ people: { candidates: [member, newcomer], onAdd: vi.fn(() => Promise.resolve()), adding: false, currentUserId: member.id } });
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
