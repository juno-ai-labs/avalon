import { act, fireEvent, render, screen, within } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkstreamResource } from '../lib/types';
import { asSubstreamId, asUserId } from '@rally/contracts';
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

function setup(detail = workstream) {
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
    disconnect() {}
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('WorkstreamSidebar', () => {
  it('shows the work stream, generated artifacts, then participants, excluding sources and substreams', () => {
    setup();
    const sidebar = screen.getByRole('complementary', { name: 'Work-stream sidebar' });
    const buttons = within(sidebar).getAllByRole('button');
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Collapse work-stream sidebar', 'Go to conversation: Launch preparation', 'Open Launch draft.md', 'Manage work-stream participants',
    ]);
    expect(screen.queryByText('Source ticket')).not.toBeInTheDocument();
    expect(screen.queryByText('Substreams')).not.toBeInTheDocument();
    expect(screen.getByText('document · v2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go to conversation: Launch preparation' }).querySelector('svg, img')).toBeNull();
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
    fireEvent.click(screen.getByRole('button', { name: 'Manage work-stream participants' }));
    expect(onParticipants).toHaveBeenCalledTimes(1);
  });

  it('persists an independent icon-mode preference and restores expanded mode', () => {
    const view = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse work-stream sidebar' }));
    expect(screen.getByRole('complementary')).toHaveClass('is-compact');
    expect(screen.getByRole('button', { name: 'Go to conversation: Launch preparation' })).toBeInTheDocument();
    expect(localStorage.getItem('rally.sidebar-collapsed')).toBeNull();
    view.unmount();
    setup();
    expect(screen.getByRole('button', { name: 'Expand work-stream sidebar' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'Open Launch draft.md' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expand work-stream sidebar' }));
    expect(screen.getByRole('complementary')).not.toHaveClass('is-compact');
  });

  it('places creator-attributed children below Main and creation last while retaining compact navigation', async () => {
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
    expect(await within(child).findByText('AL')).toBeInTheDocument();
    const sidebar = screen.getByRole('complementary');
    const navigation = within(sidebar).getAllByRole('button').slice(1, 4);
    expect(navigation.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Go to conversation: Launch preparation', 'Go to substream: Launch risks', 'New substream',
    ]);
    expect(sidebar.querySelectorAll('.tabler-icon-border-corner-pill')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'New substream' }).querySelector('.tabler-icon-plus')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Launch risks/ }));
    expect(onSelectSubstream).toHaveBeenCalledWith('00000000-0000-7000-8000-000000000099');
    fireEvent.click(screen.getByRole('button', { name: 'New substream' }));
    expect(onNewSubstream).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse work-stream sidebar' }));
    expect(sidebar).toHaveClass('is-compact');
    fireEvent.click(child);
    expect(onSelectSubstream).toHaveBeenLastCalledWith('00000000-0000-7000-8000-000000000099');
    fireEvent.click(screen.getByRole('button', { name: 'Go to conversation: Launch preparation' }));
    expect(onSelectSubstream).toHaveBeenLastCalledWith('0');
  });

  it('offers the substream row menu on right-click and names the row each item acts on', async () => {
    const actions = {
      onParticipants: vi.fn(), onMarkUnread: vi.fn(), onRename: vi.fn(), onArchive: vi.fn(),
    };
    const target = { substreamId: '00000000-0000-7000-8000-000000000099', title: 'Launch risks' };
    render(<Tooltip.Provider><WorkstreamSidebar
      workstream={{ ...workstream, privateChildren: [{
        substreamId: asSubstreamId(target.substreamId), title: target.title, createdByUserId: asUserId(person.id),
        createdAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z',
      }] }}
      presentUserIds={[]}
      onSelectSubstream={vi.fn()}
      onOpenArtifact={vi.fn()}
      onParticipants={vi.fn()}
      onFocusTranscript={vi.fn()}
      substreamActions={actions}
    /></Tooltip.Provider>);
    fireEvent.contextMenu(screen.getByRole('button', { name: /Launch risks/ }));
    const menu = await screen.findByRole('menu');
    // The work stream's own items, less the two that place a row in the
    // workspace directory a private child never enters, plus the roster
    // control the sidebar section gives a work stream and not a substream.
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent?.trim())).toEqual([
      'Participants', 'Mark as unread', 'Rename', 'Archive substream',
    ]);
    fireEvent.keyDown(menu, { key: 'Escape' });
    for (const [label, handler] of [
      ['Participants', actions.onParticipants],
      ['Mark as unread', actions.onMarkUnread],
      ['Rename', actions.onRename],
      ['Archive substream', actions.onArchive],
    ] as const) {
      // An open menu takes the row out of the accessibility tree, so each pass
      // waits for it to come back before opening the menu again.
      const row = await screen.findByRole('button', { name: /Launch risks/ });
      fireEvent.contextMenu(row);
      fireEvent.click(await within(await screen.findByRole('menu')).findByRole('menuitem', { name: label }));
      expect(handler).toHaveBeenCalledWith(target);
    }
  });

  it('marks a substream row unread until it is the row being read', () => {
    const child = {
      substreamId: asSubstreamId('00000000-0000-7000-8000-000000000099'), title: 'Launch risks',
      createdByUserId: asUserId(person.id),
      createdAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z',
      unreadCount: 3, youAreMentioned: true,
    };
    const view = render(<Tooltip.Provider><WorkstreamSidebar
      workstream={{ ...workstream, privateChildren: [child] }}
      presentUserIds={[]}
      onSelectSubstream={vi.fn()}
      onOpenArtifact={vi.fn()}
      onParticipants={vi.fn()}
      onFocusTranscript={vi.fn()}
    /></Tooltip.Provider>);
    expect(screen.getByRole('button', { name: 'Go to substream: Launch risks, mentions you' })
      .querySelector('.workstream-substream-marker.is-mention')).not.toBeNull();
    // Reading it is what clears it; the row on screen never nags about itself.
    view.rerender(<Tooltip.Provider><WorkstreamSidebar
      workstream={{ ...workstream, privateChildren: [child] }}
      presentUserIds={[]}
      selectedSubstreamId={child.substreamId}
      onSelectSubstream={vi.fn()}
      onOpenArtifact={vi.fn()}
      onParticipants={vi.fn()}
      onFocusTranscript={vi.fn()}
    /></Tooltip.Provider>);
    expect(screen.getByRole('button', { name: 'Go to substream: Launch risks' })
      .querySelector('.workstream-substream-marker')).toBeNull();
  });

  it('collapses for available pane width without overwriting the manual preference', () => {
    setup();
    act(() => { width = 703; resized(); });
    expect(screen.getByRole('complementary')).toHaveClass('is-compact');
    expect(screen.getByRole('button', { name: 'Expand work-stream sidebar' })).toBeDisabled();
    act(() => { width = 900; resized(); });
    expect(screen.getByRole('complementary')).not.toHaveClass('is-compact');
    expect(localStorage.getItem('rally.workstream-sidebar-collapsed')).toBeNull();
  });

  it('shows an honest empty artifact state', () => {
    setup({ ...workstream, resources: [], participants: [] });
    expect(screen.getByText('No generated artifacts yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manage work-stream participants' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Launch draft.md' })).not.toBeInTheDocument();
  });

  it('drags relative to the second sidebar, persists its width, and stops after release', () => {
    const view = setup();
    const handle = screen.getByRole('separator', { name: 'Resize work-stream sidebar' });
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(handle, { clientX: 563, pointerId: 1, button: 0 });
    fireEvent.pointerMove(handle, { clientX: 643, pointerId: 1 });
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

  it('replaces resources and participants when the selected work stream changes', () => {
    const { rerender, onOpenArtifact, onParticipants } = setup();
    rerender(<Tooltip.Provider><div><WorkstreamSidebar workstream={{ ...workstream, id: '00000000-0000-7000-8000-000000000022', title: 'Another work stream', resources: [], participants: [] }} presentUserIds={[]} onOpenArtifact={onOpenArtifact} onParticipants={onParticipants} onFocusTranscript={vi.fn()} /></div></Tooltip.Provider>);
    expect(screen.getByRole('button', { name: 'Go to conversation: Another work stream' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('button', { name: 'Open Launch draft.md' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Ada Lovelace/ })).not.toBeInTheDocument();
  });
});
