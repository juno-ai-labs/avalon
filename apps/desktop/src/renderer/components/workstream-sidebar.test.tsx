import { act, createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { MemoryRouter, NavLink } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkstreamResource } from '../lib/types';
import { SITE_MANIFEST_MIME_TYPE, asSubstreamId, asUserId } from '@rally/contracts';
import { SidebarList } from '@rally/ui/components/resizable-sidebar';
import { WorkstreamSidebar } from './workstream-sidebar';

const artifact: WorkstreamResource = {
  id: '00000000-0000-7000-8000-000000000031', title: 'Launch draft.md',
  resourceType: 'document', currentVersion: 2, direction: 'artifact',
  relationshipType: 'generated', refreshSupported: false, watchEnabled: false, watchStatus: 'unsupported',
};
const person = { id: '00000000-0000-7000-8000-000000000011', name: 'Ada Lovelace', email: 'ada@example.test', timezone: 'UTC' };
const workstream = { id: '00000000-0000-7000-8000-000000000021', title: 'Launch preparation', participants: [person], resources: [artifact, { ...artifact, id: 'source', title: 'Source ticket', direction: 'source' as const }] };
let width: number;
let resized: () => void;

function setup(detail: React.ComponentProps<typeof WorkstreamSidebar>['workstream'] = workstream) {
  const onOpenArtifact = vi.fn();
  const onParticipants = vi.fn();
  const onFocusTranscript = vi.fn();
  const view = render(<Tooltip.Provider><div><WorkstreamSidebar workstream={detail} presentUserIds={[person.id]} onOpenArtifact={onOpenArtifact} onParticipants={onParticipants} onFocusTranscript={onFocusTranscript} /></div></Tooltip.Provider>);
  return { ...view, onOpenArtifact, onParticipants, onFocusTranscript };
}

beforeEach(() => {
  localStorage.clear();
  width = 900;
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  vi.stubGlobal('PointerEvent', class extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; }
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 280, y: 0, left: 280, right: 560, top: 0, bottom: 900, width: 280, height: 900, toJSON: () => ({}) });
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resized = callback; }
    observe() {}
    // Radix measures the tooltip arrow through `useSize`, which unobserves on
    // unmount; a stub without it throws during teardown, not during the assert.
    // Both the artifact rows' `Tip` and the resize handle's `DragHint` mount
    // one, so every test that opens this sidebar needs it.
    unobserve() {}
    disconnect() {}
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('SidebarList', () => {
  it('preserves string and polymorphic callback class names', () => {
    const { rerender } = render(<SidebarList className="local-list" />);
    expect(document.querySelector('.sidebar-list')).toHaveClass('local-list');

    rerender(<MemoryRouter><SidebarList
      as={NavLink}
      className={({ isActive }) => isActive ? 'current-list' : undefined}
      to="/"
    /></MemoryRouter>);
    expect(screen.getByRole('link')).toHaveClass('sidebar-list', 'current-list');
  });
});

describe('WorkstreamSidebar', () => {
  it('shows the channel, its artifacts, then participants, excluding sources and breakouts', () => {
    setup();
    const sidebar = screen.getByRole('complementary', { name: 'Channel sidebar' });
    expect(within(sidebar).getByRole('heading', { name: 'Launch preparation' })).toHaveClass('sidebar-title');
    const header = sidebar.querySelector('.sidebar-header');
    expect(header).toHaveClass('sidebar-row');
    expect(header?.nextElementSibling).toHaveClass('sidebar-horizontal-line', 'sidebar-header-line');
    expect(sidebar.querySelector('.sidebar-horizontal-line')).not.toBeNull();
    expect(sidebar.querySelector('.workstream-context-scroll')).toHaveClass('sidebar-scroll');
    const titleIcon = sidebar.querySelector('.sidebar-title-header-icon');
    expect(titleIcon?.querySelector('.workstream-mark')).toHaveAttribute('width', '20');
    expect(titleIcon?.querySelector('.workstream-mark')).toHaveAttribute('height', '20');
    expect(titleIcon?.nextElementSibling).toBe(within(sidebar).getByRole('heading', { name: 'Launch preparation' }));
    const buttons = within(sidebar).getAllByRole('button');
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Go to conversation: Launch preparation', 'Open Launch draft.md', 'Manage channel participants', 'Collapse channel',
    ]);
    expect(screen.queryByText('Source ticket')).not.toBeInTheDocument();
    expect(screen.queryByText('Breakouts')).not.toBeInTheDocument();
    expect(screen.getByText('document · v2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go to conversation: Launch preparation' }).querySelector('.workstream-mark')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Go to conversation: Launch preparation' })).toHaveClass('sidebar-row');
  });

  it('marks the main conversation with the channel\u2019s own icon and colour', () => {
    // 'rocket' is not what this id generates ('atom'), so the assertion fails
    // if the saved icon stops being read rather than passing down either branch.
    setup({ ...workstream, appearance: { icon: 'rocket', color: 'teal' } });
    const mark = screen.getByRole('button', { name: 'Go to conversation: Launch preparation' }).querySelector('.workstream-mark');
    expect(mark).toHaveClass('lucide-rocket');
    expect(mark).toHaveStyle({ color: 'var(--av-sys-color-project-teal)' });
  });

  it('toggles from the right edge and labels the main conversation with its title', () => {
    setup();
    expect(screen.getAllByText('Launch preparation')).toHaveLength(2);
    expect(screen.queryByText('Main log')).not.toBeInTheDocument();
    const edge = screen.getByRole('separator', { name: 'Resize channel sidebar' });
    expect(edge.querySelector('svg')).toHaveAttribute('width', '11');
    expect(edge.querySelector('svg')).toHaveAttribute('height', '11');
    expect(edge.querySelector('svg')).toHaveAttribute('stroke-width', '2');
    fireEvent.doubleClick(edge);
    expect(edge).toHaveAttribute('aria-valuenow', '88');
    fireEvent.doubleClick(edge);
    expect(edge).toHaveAttribute('aria-valuenow', '280');
  });

  // As for the navigation: `flex-basis` is transitioned, and the drag takes that
  // transition off while it tracks the pointer. The second release of a
  // double-click has to have restored it before the toggle lands, or the one
  // gesture that asks for the animation is the one that does not get it.
  it('leaves the resize suppression off when a double-click on the edge toggles', () => {
    setup();
    const edge = screen.getByRole('separator', { name: 'Resize channel sidebar' });
    edge.setPointerCapture = vi.fn();
    edge.releasePointerCapture = vi.fn();
    const sidebar = screen.getByRole('complementary', { name: 'Channel sidebar' });

    for (const pointerId of [7, 8]) {
      fireEvent.pointerDown(edge, { button: 0, clientX: 563, pointerId });
      expect(sidebar).toHaveClass('is-resizing');
      fireEvent.pointerUp(edge, { pointerId });
    }

    expect(sidebar).not.toHaveClass('is-resizing');
    fireEvent.doubleClick(edge);
    expect(edge).toHaveAttribute('aria-valuenow', '88');
    expect(sidebar).not.toHaveClass('is-resizing');
  });

  it('opens artifacts only on click with the clicked button as the preview focus return target', () => {
    const { onOpenArtifact } = setup();
    expect(onOpenArtifact).not.toHaveBeenCalled();
    const button = screen.getByRole('button', { name: 'Open Launch draft.md' });
    fireEvent.click(button);
    expect(onOpenArtifact).toHaveBeenCalledWith(artifact.id, button);
  });

  it('focuses the conversation and offers participant management', () => {
    const { onParticipants, onFocusTranscript } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Go to conversation: Launch preparation' }));
    expect(onFocusTranscript).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Manage channel participants' }));
    expect(onParticipants).toHaveBeenCalledTimes(1);
  });

  it('persists an independent icon-mode preference and restores expanded mode', () => {
    const view = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse channel' }));
    expect(screen.getByRole('complementary')).toHaveClass('is-compact');
    expect(screen.getByRole('complementary').querySelector('.sidebar-title-header-icon .workstream-mark')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Go to conversation: Launch preparation' })).toBeInTheDocument();
    expect(localStorage.getItem('rally.sidebar-collapsed')).toBeNull();
    view.unmount();
    setup();
    expect(screen.getByRole('button', { name: 'Expand channel' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'Open Launch draft.md' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expand channel' }));
    expect(screen.getByRole('complementary')).not.toHaveClass('is-compact');
  });

  it('places children below Main and creation last without collapsing on navigation', () => {
    const onSelectSubstream = vi.fn();
    const onNewSubstream = vi.fn();
    render(<Tooltip.Provider><WorkstreamSidebar
      workstream={{ ...workstream, privateChildren: [{
        substreamId: asSubstreamId('00000000-0000-7000-8000-000000000099'), title: 'Launch risks', createdByUserId: asUserId(person.id),
        createdAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z',
      }] }}
      presentUserIds={[]}
      selectedSubstreamId="00000000-0000-7000-8000-000000000099"
      onSelectSubstream={onSelectSubstream}
      onNewSubstream={onNewSubstream}
      onOpenArtifact={vi.fn()}
      onParticipants={vi.fn()}
      onFocusTranscript={vi.fn()}
    /></Tooltip.Provider>);
    expect(screen.getByRole('button', { name: /Launch risks/ })).toHaveAttribute('aria-current', 'page');
    const child = screen.getByRole('button', { name: /Launch risks/ });
    // A Breakout derives its own stable icon and colour from its identity, in
    // the same icon slot Main uses. It does not borrow the Channel's mark.
    expect(child.querySelector('.sidebar-row-icon > .workstream-mark')).not.toBeNull();
    expect(child.querySelector('.tabler-icon-border-corner-pill')).toBeNull();
    expect(child.querySelector('.avatar')).toBeNull();
    expect(child.querySelector('.workstream-mark')).toHaveStyle({ color: 'var(--av-sys-color-project-rose)' });
    const sidebar = screen.getByRole('complementary');
    const navigation = within(sidebar).getAllByRole('button').slice(0, 3);
    expect(navigation.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Go to conversation: Launch preparation', 'Go to breakout: Launch risks', 'New breakout',
    ]);
    expect(sidebar.querySelectorAll('.lucide-git-branch')).toHaveLength(0);
    // The blue enter mark starts a Breakout; the generic plus is no longer
    // used in this hierarchy rail.
    expect(screen.getByRole('button', { name: 'New breakout' }).querySelector('.sidebar-row-icon > .tabler-icon-corner-down-right')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'New breakout' }).querySelector('.tabler-icon-plus')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Launch risks/ }));
    expect(onSelectSubstream).toHaveBeenCalledWith('00000000-0000-7000-8000-000000000099');
    fireEvent.click(screen.getByRole('button', { name: 'New breakout' }));
    expect(onNewSubstream).toHaveBeenCalledOnce();
    // Navigation preserves the person's chosen rail width. Only its explicit
    // toggle or a narrow pane compacts it.
    expect(sidebar).not.toHaveClass('is-compact');
    expect(localStorage.getItem('rally.workstream-sidebar-collapsed')).toBeNull();
    expect(screen.getByRole('button', { name: /Launch risks/ }).querySelector('.workstream-mark')).not.toBeNull();
    expect(sidebar.querySelectorAll('.tabler-icon-corner-down-right')).toHaveLength(1);
    fireEvent.click(child);
    expect(onSelectSubstream).toHaveBeenLastCalledWith('00000000-0000-7000-8000-000000000099');
    fireEvent.click(screen.getByRole('button', { name: 'Go to conversation: Launch preparation' }));
    expect(onSelectSubstream).toHaveBeenLastCalledWith('0');
  });

  it('uses sidebar preview cards for the main conversation and each breakout', async () => {
    setup({ ...workstream, privateChildren: [{
      substreamId: asSubstreamId('00000000-0000-7000-8000-000000000099'), title: 'Launch risks',
      createdByUserId: asUserId(person.id),
      createdAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z',
    }] });

    const main = screen.getByRole('button', { name: 'Go to conversation: Launch preparation' });
    expect(main).not.toHaveAttribute('title');
    fireEvent.focus(main);
    let tip = await screen.findByRole('tooltip');
    expect(tip).toHaveClass('sidebar-workstream-preview-surface');
    expect(tip).toHaveTextContent('Launch preparation');
    expect(main).not.toHaveAttribute('aria-describedby');
    fireEvent.blur(main);

    const breakout = screen.getByRole('button', { name: 'Go to breakout: Launch risks' });
    expect(breakout).not.toHaveAttribute('title');
    fireEvent.focus(breakout);
    tip = await screen.findByRole('tooltip');
    expect(tip).toHaveClass('sidebar-workstream-preview-surface');
    expect(tip).toHaveTextContent('Launch risks');
    expect(breakout).not.toHaveAttribute('aria-describedby');
  });

  it('leaves right-click native when a conversation has no application menu', () => {
    setup({ ...workstream, privateChildren: [{
      substreamId: asSubstreamId('00000000-0000-7000-8000-000000000099'), title: 'Launch risks',
    }] });

    for (const row of [
      screen.getByRole('button', { name: 'Go to conversation: Launch preparation' }),
      screen.getByRole('button', { name: 'Go to breakout: Launch risks' }),
    ]) {
      const event = createEvent.contextMenu(row);
      fireEvent(row, event);
      expect(event.defaultPrevented).toBe(false);
    }
  });

  it('labels the new Breakout and participant tooltips', async () => {
    const onNewSubstream = vi.fn();
    render(<Tooltip.Provider><WorkstreamSidebar
      workstream={workstream}
      presentUserIds={[]}
      onNewSubstream={onNewSubstream}
      onOpenArtifact={vi.fn()}
      onParticipants={vi.fn()}
      onFocusTranscript={vi.fn()}
    /></Tooltip.Provider>);

    const create = screen.getByRole('button', { name: 'New breakout' });
    fireEvent.focus(create);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('New breakout');
    fireEvent.blur(create);

    const participants = screen.getByRole('button', { name: 'Manage channel participants' });
    fireEvent.focus(participants);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Participants');
    expect(participants).toHaveAttribute('aria-description', 'Ada Lovelace');
    expect(participants).not.toHaveAttribute('aria-describedby');
    expect(participants.querySelector('.avatar-stack-item')).not.toHaveAttribute('data-state');
  });

  it('gives each breakout its own stable generated mark', () => {
    setup({ ...workstream, privateChildren: [
      { substreamId: asSubstreamId('00000000-0000-7000-8000-000000000099'), title: 'Launch risks' },
      { substreamId: asSubstreamId('00000000-0000-7000-8000-000000000098'), title: 'Launch follow-ups' },
      { substreamId: asSubstreamId('00000000-0000-7000-8000-000000000097'), title: 'Launch visuals', appearance: { icon: 'rocket', color: 'purple' } },
    ] });

    const risks = screen.getByRole('button', { name: 'Go to breakout: Launch risks' }).querySelector('.workstream-mark');
    const followUps = screen.getByRole('button', { name: 'Go to breakout: Launch follow-ups' }).querySelector('.workstream-mark');
    const visuals = screen.getByRole('button', { name: 'Go to breakout: Launch visuals' }).querySelector('.workstream-mark');
    expect(risks).toHaveClass('lucide-wand-sparkles');
    expect(risks).toHaveStyle({ color: 'var(--av-sys-color-project-rose)' });
    expect(followUps).toHaveClass('lucide-orbit');
    expect(followUps).toHaveStyle({ color: 'var(--av-sys-color-project-green)' });
    expect(visuals).toHaveClass('lucide-rocket');
    expect(visuals).toHaveStyle({ color: 'var(--av-sys-color-project-purple)' });
  });

  it('holds the place of a breakout being created, last and without a destination', () => {
    const onNewSubstream = vi.fn();
    render(<Tooltip.Provider><WorkstreamSidebar
      workstream={{ ...workstream, privateChildren: [{
        substreamId: asSubstreamId('00000000-0000-7000-8000-000000000097'), title: 'Launch risks', createdByUserId: asUserId(person.id),
        createdAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z',
      }] }}
      creatingSubstream={{ reservedSubstreamId: null }}
      presentUserIds={[]}
      selectedSubstreamId="new"
      onSelectSubstream={vi.fn()}
      onNewSubstream={onNewSubstream}
      onOpenArtifact={vi.fn()}
      onParticipants={vi.fn()}
      onFocusTranscript={vi.fn()}
    /></Tooltip.Provider>);
    const sidebar = screen.getByRole('complementary');
    const rows = [...sidebar.querySelectorAll('.workstream-conversation-list > .sidebar-row')];
    // Last, where a child created now will be listed: the directory orders
    // children oldest first, so the row does not move when it becomes real.
    expect(rows.map((row) => row.className)).toEqual([
      expect.stringContaining('workstream-conversation-row'),
      expect.stringContaining('workstream-conversation-row'),
      expect.stringContaining('workstream-pending-substream'),
      expect.stringContaining('workstream-new-substream'),
    ]);
    const pending = sidebar.querySelector('.workstream-pending-substream');
    expect(pending).toHaveAttribute('aria-current', 'page');
    expect(pending?.querySelector('.sidebar-row-icon > .lucide-git-branch')).not.toBeNull();
    expect(pending?.querySelector('.title-skeleton')).not.toBeNull();
    expect(within(sidebar).getByText('Rally is creating this breakout')).toBeInTheDocument();
    // Nothing to click: the reader is already on the surface this row stands
    // for, and the row that starts the next substream is no longer the one
    // saying where they are. Asserted as the list's whole button inventory, so
    // it fails the moment the placeholder becomes navigable rather than
    // depending on the label a regression would happen to give it.
    const list = sidebar.querySelector('.workstream-conversation-list');
    expect([...list?.querySelectorAll('button') ?? []].map((button) => button.getAttribute('aria-label')))
      .toEqual(['Go to conversation: Launch preparation', 'Go to breakout: Launch risks', 'New breakout']);
    const create = screen.getByRole('button', { name: 'New breakout' });
    expect(create).not.toHaveAttribute('aria-current');
    expect(create.className).not.toContain('is-current');
    // Compact hides `.sidebar-row-main` with `visibility: hidden`, which
    // takes everything inside it out of the accessibility tree — so the row's
    // only name must not live there. Every other row survives the collapse on
    // its button's `aria-label`; this one has no button, so the text is on the
    // row. jsdom applies no stylesheet, so the assertion is where the text sits
    // rather than whether it computed to hidden.
    fireEvent.click(screen.getByRole('button', { name: 'Collapse channel' }));
    expect(sidebar).toHaveClass('is-compact');
    const name = within(sidebar).getByText('Rally is creating this breakout');
    expect(name.closest('.workstream-pending-substream')).toBe(pending);
    expect(name.closest('.sidebar-row-main')).toBeNull();
    expect(pending?.querySelector('.sidebar-row-main')).not.toBeNull();
  });

  it('yields the creating row the moment the child it reserved is published', () => {
    // The child is published to the parent's directory from inside the
    // confirmation, so its real row can arrive before the response that
    // navigates. Two rows for one conversation is the thing this list must
    // never show, and the reserved id is what tells them apart.
    const reserved = asSubstreamId('00000000-0000-7000-8000-000000000096');
    render(<Tooltip.Provider><WorkstreamSidebar
      workstream={{ ...workstream, privateChildren: [{
        substreamId: reserved, title: 'Retry budget failures', createdByUserId: asUserId(person.id),
        createdAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z',
      }] }}
      creatingSubstream={{ reservedSubstreamId: reserved }}
      presentUserIds={[]}
      selectedSubstreamId="new"
      onSelectSubstream={vi.fn()}
      onNewSubstream={vi.fn()}
      onOpenArtifact={vi.fn()}
      onParticipants={vi.fn()}
      onFocusTranscript={vi.fn()}
    /></Tooltip.Provider>);
    const sidebar = screen.getByRole('complementary');
    expect(sidebar.querySelector('.workstream-pending-substream')).toBeNull();
    // Current on the published row rather than on nothing: the route still says
    // `new` for the tick before the response navigates, and the reader is in
    // that conversation either way.
    expect(screen.getByRole('button', { name: 'Go to breakout: Retry budget failures' }))
      .toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'New breakout' })).not.toHaveAttribute('aria-current');
  });

  it('keeps the breakout icon when its title has no first character', () => {
    render(<Tooltip.Provider><WorkstreamSidebar
      workstream={{ ...workstream, privateChildren: [{
        substreamId: asSubstreamId('00000000-0000-7000-8000-000000000098'), title: '   ', createdByUserId: asUserId(person.id),
        createdAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z',
      }] }}
      presentUserIds={[]}
      onOpenArtifact={vi.fn()}
      onParticipants={vi.fn()}
      onFocusTranscript={vi.fn()}
    /></Tooltip.Provider>);
    const sidebar = screen.getByRole('complementary');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse channel' }));
    expect(sidebar).toHaveClass('is-compact');
    // A lone space is wire-legal, and an empty mark square says nothing at all.
    expect(sidebar.querySelector('.workstream-substream-initial')).toBeNull();
    expect(sidebar.querySelector('.workstream-mark')).not.toBeNull();
  });

  it('collapses for available pane width without overwriting the manual preference', () => {
    setup();
    act(() => { width = 703; resized(); });
    expect(screen.getByRole('complementary')).toHaveClass('is-compact');
    const toggle = screen.getByRole('button', { name: 'Expand channel' });
    expect(toggle).toBeDisabled();
    expect(toggle).not.toHaveAttribute('title');
    expect(toggle.parentElement).toHaveClass('sidebar-collapse-footer-toggle');
    expect(toggle.parentElement).toHaveAttribute('tabindex', '0');
    act(() => { width = 900; resized(); });
    expect(screen.getByRole('complementary')).not.toHaveClass('is-compact');
    expect(localStorage.getItem('rally.workstream-sidebar-collapsed')).toBeNull();
  });

  it('explains a truncated artifact with the rail\u2019s own tooltip, never the platform\u2019s', async () => {
    setup();
    const row = screen.getByRole('button', { name: 'Open Launch draft.md' });
    // The native tooltip is the thing being replaced: leaving `title` behind
    // means both fire, at different delays, in different type.
    expect(row).not.toHaveAttribute('title');
    fireEvent.focus(row);
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveClass('tooltip');
    expect(tip).toHaveTextContent('Launch draft.md');
  });

  it('marks a site by what it is, including one still typed as the file it was published from', () => {
    // `swapPublishedContent` rewrites `mime_type` on an archive\u2192site upgrade and
    // never `resource_type`, so a live site reaches this rail as a
    // `generated_file`. Reading the raw type here is what drew it as a sheet of
    // paper while the row beside it opened a live page.
    setup({ ...workstream, resources: [
      { ...artifact, id: 'site-fresh', title: 'Launch dashboard', resourceType: 'generated_site', mimeType: SITE_MANIFEST_MIME_TYPE },
      { ...artifact, id: 'site-upgraded', title: 'Offsite RSVP', resourceType: 'generated_file', mimeType: SITE_MANIFEST_MIME_TYPE },
    ] });
    for (const title of ['Launch dashboard', 'Offsite RSVP']) {
      const row = screen.getByRole('button', { name: `Open ${title}` });
      expect(row.querySelector('.tabler-icon-app-window'), title).not.toBeNull();
    }
  });

  // Same divider, same silence: the double-click that collapses this rail is
  // written down nowhere else, so which way the hint names has to follow the
  // state the next one would leave behind.
  it('names the drag and the double-click, in the direction the next one goes', () => {
    setup();
    const edge = screen.getByRole('separator', { name: 'Resize channel sidebar' });

    fireEvent.focus(edge);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Drag to resize');
    expect(screen.getByRole('tooltip')).toHaveTextContent('Double-click or Enter to collapse');

    fireEvent.doubleClick(edge);
    fireEvent.blur(edge);
    fireEvent.focus(edge);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Double-click or Enter to expand');
  });

  // As in the navigation: the reader most likely to be reading the hint is the
  // one who cannot double-click, so Enter does what the double-click does and
  // is refused where the double-click is refused.
  it('collapses and expands from Enter on the divider, and refuses it in a narrow pane', () => {
    setup();
    const edge = screen.getByRole('separator', { name: 'Resize channel sidebar' });

    fireEvent.keyDown(edge, { key: 'Enter' });
    expect(edge).toHaveAttribute('aria-valuenow', '88');
    fireEvent.keyDown(edge, { key: 'Enter' });
    expect(edge).toHaveAttribute('aria-valuenow', '280');

    act(() => { width = 703; resized(); });
    expect(edge).toHaveAttribute('aria-valuenow', '88');
    fireEvent.keyDown(edge, { key: 'Enter' });
    expect(localStorage.getItem('rally.workstream-sidebar-collapsed')).toBe('false');
  });

  // A pane too narrow for the rail's contents holds it compact and disables the
  // toggle above; the double-click on the divider is guarded by the same
  // condition. The hint has to stop offering what the handle would refuse.
  // The pane narrows before the hint is ever opened: this file's observer stub
  // keeps only the newest callback, and an open tooltip's own observer is newer
  // than the sidebar's.
  it('drops the shortcut a narrow pane would refuse', () => {
    setup();
    act(() => { width = 703; resized(); });
    const edge = screen.getByRole('separator', { name: 'Resize channel sidebar' });

    fireEvent.focus(edge);

    expect(screen.getByRole('tooltip')).toHaveTextContent('Drag to resize');
    expect(screen.getByRole('tooltip')).not.toHaveTextContent('Double-click');
    fireEvent.blur(edge);
    const toggle = screen.getByRole('button', { name: 'Expand channel' });
    fireEvent.focus(toggle.parentElement as HTMLElement);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Widen the window to expand channel');
  });

  // A hint that rides along beside the divider for the whole drag is worse than
  // no hint: it sits over the transcript the drag is revealing, at the one
  // moment the reader is watching an edge move. The press has to leave it shut.
  it('keeps the hint shut through a grab that never waited for it', () => {
    setup();
    const edge = screen.getByRole('separator', { name: 'Resize channel sidebar' });
    edge.setPointerCapture = vi.fn();
    edge.releasePointerCapture = vi.fn();
    expect(screen.queryByRole('tooltip')).toBeNull();

    fireEvent.pointerDown(edge, { clientX: 563, pointerId: 1, button: 0 });
    expect(screen.queryByRole('tooltip')).toBeNull();

    fireEvent.pointerMove(edge, { clientX: 600, pointerId: 1 });
    expect(screen.queryByRole('tooltip')).toBeNull();

    fireEvent.pointerUp(edge, { pointerId: 1 });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('drops the artifact section entirely until a channel has one', () => {
    setup({ ...workstream, resources: [], participants: [] });
    expect(screen.queryByRole('region', { name: 'Artifacts' })).not.toBeInTheDocument();
    expect(screen.queryByText('Artifacts')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manage channel participants' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Launch draft.md' })).not.toBeInTheDocument();
  });

  it('heads the section with the artifacts a channel has produced', () => {
    setup();
    expect(within(screen.getByRole('region', { name: 'Artifacts' })).getByRole('heading', { name: 'Artifacts' })).toBeInTheDocument();
  });

  it('lists the room’s Sidekicks under the people, and drops the section when it has none', () => {
    const onRemove = vi.fn();
    const { rerender } = render(<Tooltip.Provider><WorkstreamSidebar
      workstream={workstream}
      presentUserIds={[]}
      sidekicks={[
        { id: 'sidekick-1', name: 'Release notes', description: 'Draft the notes.' },
        { id: 'sidekick-2', name: 'Editor', description: 'Review wording.', note: 'Unavailable', onRemove },
      ]}
      onOpenArtifact={vi.fn()}
      onParticipants={vi.fn()}
      onFocusTranscript={vi.fn()}
    /></Tooltip.Provider>);
    const sidebar = screen.getByRole('complementary', { name: 'Channel sidebar' });
    const sections = within(sidebar).getAllByRole('region').map((section) => section.getAttribute('aria-label'));
    expect(sections).toEqual(['Artifacts', 'Channel participants', 'Sidekicks']);
    const rows = within(within(sidebar).getByRole('region', { name: 'Sidekicks' })).getAllByRole('button');
    expect(rows.map((row) => row.getAttribute('aria-label')))
      .toEqual(['Release notes', 'Editor']);
    expect(screen.getByText('Unavailable · Review wording.')).toBeVisible();
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Editor' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from this breakout' }));
    expect(onRemove).toHaveBeenCalledOnce();

    // Neither an empty answer nor a pending one leaves a heading behind, the
    // way the artifact section above drops itself; the caller is where the two
    // states are kept apart.
    for (const pending of [{ sidekicks: [] }, {}]) {
      rerender(<Tooltip.Provider><WorkstreamSidebar
        workstream={workstream} presentUserIds={[]} {...pending}
        onOpenArtifact={vi.fn()} onParticipants={vi.fn()} onFocusTranscript={vi.fn()}
      /></Tooltip.Provider>);
      expect(screen.queryByRole('region', { name: 'Sidekicks' })).toBeNull();
      expect(screen.queryByText('Sidekicks')).toBeNull();
    }
  });

  it('drags relative to the second sidebar, persists its width, and stops after release', () => {
    const view = setup();
    const handle = screen.getByRole('separator', { name: 'Resize channel sidebar' });
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(handle, { clientX: 563, pointerId: 1, button: 0 });
    expect(handle).toHaveFocus();
    fireEvent.pointerMove(handle, { clientX: 643, pointerId: 1 });
    expect(document.querySelector('.sidebar-drag-guide')).not.toBeNull();
    expect(handle).toHaveAttribute('aria-valuenow', '360');
    expect(localStorage.getItem('rally.workstream-sidebar-width')).toBe('360');
    expect(localStorage.getItem('rally.sidebar-width')).toBeNull();
    fireEvent.pointerUp(handle, { pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 683, pointerId: 1 });
    expect(handle).toHaveAttribute('aria-valuenow', '360');
    expect(screen.getByRole('complementary')).not.toHaveClass('is-resizing');
    view.unmount();
    setup();
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '360');
  });

  it('uses drag hysteresis for collapse and expansion and cleans up cancellation', () => {
    setup();
    const handle = screen.getByRole('separator');
    handle.setPointerCapture = vi.fn();
    fireEvent.pointerDown(handle, { clientX: 560, pointerId: 1, button: 0 });
    fireEvent.pointerMove(handle, { clientX: 489, pointerId: 1 });
    expect(handle).toHaveAttribute('aria-valuenow', '88');
    fireEvent.pointerMove(handle, { clientX: 499, pointerId: 1 });
    expect(handle).toHaveAttribute('aria-valuenow', '88');
    fireEvent.pointerMove(handle, { clientX: 520, pointerId: 1 });
    expect(handle).toHaveAttribute('aria-valuenow', '240');
    fireEvent.pointerCancel(handle, { pointerId: 1 });
    expect(document.querySelector('.sidebar-drag-guide')).toBeNull();
    fireEvent.pointerMove(handle, { clientX: 650, pointerId: 1 });
    expect(handle).toHaveAttribute('aria-valuenow', '240');
    expect(screen.getByRole('complementary')).not.toHaveClass('is-resizing');
  });

  it('supports keyboard resizing and keeps room for the conversation', () => {
    setup();
    const handle = screen.getByRole('separator');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handle).toHaveAttribute('aria-valuenow', '296');
    for (let index = 0; index < 20; index++) fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handle).toHaveAttribute('aria-valuenow', '400');
    act(() => { width = 700; resized(); });
    expect(handle).toHaveAttribute('aria-valuenow', '88');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handle).toHaveAttribute('aria-valuenow', '240');
    for (let index = 0; index < 20; index++) fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handle).toHaveAttribute('aria-valuenow', '276');
  });

  it('replaces resources and participants when the selected channel changes', () => {
    const { rerender, onOpenArtifact, onParticipants } = setup();
    rerender(<Tooltip.Provider><div><WorkstreamSidebar workstream={{ ...workstream, id: '00000000-0000-7000-8000-000000000022', title: 'Another channel', resources: [], participants: [] }} presentUserIds={[]} onOpenArtifact={onOpenArtifact} onParticipants={onParticipants} onFocusTranscript={vi.fn()} /></div></Tooltip.Provider>);
    expect(screen.getByRole('button', { name: 'Go to conversation: Another channel' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('button', { name: 'Open Launch draft.md' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Ada Lovelace/ })).not.toBeInTheDocument();
  });

  /**
   * The third list a person arranges by hand, and the same gesture as the
   * other two: the rail draws the order it is given and reports the drag, and
   * the order itself is the host's, because it is stored per person on the
   * Organization.
   */
  describe('reordering breakouts', () => {
    const first = {
      substreamId: asSubstreamId('00000000-0000-7000-8000-0000000000b1'), title: 'Launch risks',
      createdByUserId: asUserId(person.id),
      createdAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z',
    };
    const second = { ...first, substreamId: asSubstreamId('00000000-0000-7000-8000-0000000000b2'), title: 'Launch comms' };

    function setupRail(drag?: React.ComponentProps<typeof WorkstreamSidebar>['substreamDrag']) {
      return render(<Tooltip.Provider><WorkstreamSidebar
        workstream={{ ...workstream, privateChildren: [first, second] }}
        presentUserIds={[]}
        onOpenArtifact={vi.fn()}
        onParticipants={vi.fn()}
        onFocusTranscript={vi.fn()}
        onNewSubstream={vi.fn()}
        {...(drag ? { substreamDrag: drag } : {})}
      /></Tooltip.Provider>);
    }

    /** jsdom implements no `DataTransfer`; `dropEffect` is the field that matters. */
    const transfer = (dropEffect: 'move' | 'none' = 'move') =>
      ({ dropEffect, effectAllowed: '', setData: () => undefined });

    it('given a breakout dragged over another, then the list reports the move it is building', () => {
      const drag = {
        draggingSubstreamId: null,
        onDragStart: vi.fn(), onDragOver: vi.fn(), onDragEnd: vi.fn(), onMove: vi.fn(),
      };
      setupRail(drag);
      const row = screen.getByRole('button', { name: /Launch comms/u });

      fireEvent.dragStart(row, { dataTransfer: transfer() });
      fireEvent.dragOver(screen.getByRole('button', { name: /Launch risks/u }), { dataTransfer: transfer() });
      fireEvent.dragEnd(row, { dataTransfer: transfer() });

      expect(drag.onDragStart).toHaveBeenCalledWith(second.substreamId);
      // The reorder is reported as the pointer crosses rather than on the
      // release, so the list settles under the pointer instead of jumping once
      // at the end.
      expect(drag.onDragOver).toHaveBeenCalledWith(first.substreamId);
      expect(drag.onDragEnd).toHaveBeenCalledWith(false);
    });

    it('given a breakout released in the gap between rows, then the drag is completed', () => {
      const drag = {
        draggingSubstreamId: null,
        onDragStart: vi.fn(), onDragOver: vi.fn(), onDragEnd: vi.fn(), onMove: vi.fn(),
      };
      const view = setupRail(drag);
      const row = screen.getByRole('button', { name: /Launch comms/u });
      const list = view.container.querySelector<HTMLElement>('.workstream-conversation-list');
      const dataTransfer = transfer('none');
      expect(list).not.toBeNull();
      if (!list) return;

      fireEvent.dragStart(row, { dataTransfer });
      fireEvent.dragOver(list, { dataTransfer });
      fireEvent.drop(list, { dataTransfer });
      fireEvent.dragEnd(row, { dataTransfer });

      expect(dataTransfer.dropEffect).toBe('move');
      expect(drag.onDragEnd).toHaveBeenCalledWith(false);
    });

    // Escape, or a release off the list, leaves `dropEffect` at `none` — and
    // backing out of a drag must not be the same thing as finishing it.
    it('given a drag backed out of, then the end is reported as cancelled', () => {
      const drag = {
        draggingSubstreamId: null,
        onDragStart: vi.fn(), onDragOver: vi.fn(), onDragEnd: vi.fn(), onMove: vi.fn(),
      };
      setupRail(drag);

      fireEvent.dragEnd(screen.getByRole('button', { name: /Launch comms/u }), { dataTransfer: transfer('none') });

      expect(drag.onDragEnd).toHaveBeenCalledWith(true);
    });

    it('given Alt and an arrow, then the same move is reported without a pointer', () => {
      const drag = {
        draggingSubstreamId: null,
        onDragStart: vi.fn(), onDragOver: vi.fn(), onDragEnd: vi.fn(), onMove: vi.fn(),
      };
      setupRail(drag);
      const row = screen.getByRole('button', { name: /Launch comms/u });

      // A bare arrow moves focus through the rail and must keep doing so for
      // somebody who is reading rather than rearranging.
      fireEvent.keyDown(row, { key: 'ArrowUp' });
      expect(drag.onMove).not.toHaveBeenCalled();

      fireEvent.keyDown(row, { altKey: true, key: 'ArrowUp' });
      expect(drag.onMove).toHaveBeenCalledWith(second.substreamId, -1);
      // Said once for the list; per row it would land inside every row's own
      // accessible name.
      expect(screen.getByText('Hold Alt and press the up or down arrow to move a breakout.')).toBeInTheDocument();
      expect(row).toHaveAccessibleName('Go to breakout: Launch comms, 2 of 2');
    });

    // A guest's ordering write is refused by the same gate every Space write
    // is, so the rail offers them no gesture at all rather than one that could
    // only fail.
    it('given a reader who cannot store an order, then the rows are not draggable', () => {
      setupRail();

      const row = screen.getByRole('button', { name: /Launch comms/u });
      expect(row).not.toHaveAttribute('draggable', 'true');
      expect(row).toHaveAccessibleName('Go to breakout: Launch comms');
      expect(screen.queryByText('Hold Alt and press the up or down arrow to move a breakout.'))
        .not.toBeInTheDocument();
    });
  });
});
