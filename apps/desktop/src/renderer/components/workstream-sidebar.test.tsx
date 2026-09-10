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
      'Go to conversation: Launch preparation', 'Open Launch draft.md', 'Manage work-stream participants', 'Collapse work-stream sidebar',
    ]);
    expect(screen.queryByText('Source ticket')).not.toBeInTheDocument();
    expect(screen.queryByText('Substreams')).not.toBeInTheDocument();
    expect(screen.getByText('document · v2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go to conversation: Launch preparation' }).querySelector('.workstream-mark')).not.toBeNull();
  });

  it('marks the main conversation with the work stream\u2019s own icon and colour', () => {
    // 'rocket' is not what this id generates ('atom'), so the assertion fails
    // if the saved icon stops being read rather than passing down either branch.
    setup({ ...workstream, appearance: { icon: 'rocket', color: 'teal' } });
    const mark = screen.getByRole('button', { name: 'Go to conversation: Launch preparation' }).querySelector('.workstream-mark');
    expect(mark).toHaveClass('lucide-rocket');
    expect(mark).toHaveStyle({ color: 'var(--av-sys-color-project-teal)' });
  });

  it('toggles from the right edge and labels the main conversation with its title', () => {
    setup();
    expect(screen.getByText('Launch preparation')).toBeInTheDocument();
    expect(screen.queryByText('Main log')).not.toBeInTheDocument();
    const edge = screen.getByRole('separator', { name: 'Resize work-stream sidebar' });
    fireEvent.doubleClick(edge);
    expect(edge).toHaveAttribute('aria-valuenow', '96');
    fireEvent.doubleClick(edge);
    expect(edge).toHaveAttribute('aria-valuenow', '280');
  });

  // As for the navigation: `flex-basis` is transitioned, and the drag takes that
  // transition off while it tracks the pointer. The second release of a
  // double-click has to have restored it before the toggle lands, or the one
  // gesture that asks for the animation is the one that does not get it.
  it('leaves the resize suppression off when a double-click on the edge toggles', () => {
    setup();
    const edge = screen.getByRole('separator', { name: 'Resize work-stream sidebar' });
    edge.setPointerCapture = vi.fn();
    edge.releasePointerCapture = vi.fn();
    const sidebar = screen.getByRole('complementary', { name: 'Work-stream sidebar' });

    for (const pointerId of [7, 8]) {
      fireEvent.pointerDown(edge, { button: 0, clientX: 563, pointerId });
      expect(sidebar).toHaveClass('is-resizing');
      fireEvent.pointerUp(edge, { pointerId });
    }

    expect(sidebar).not.toHaveClass('is-resizing');
    fireEvent.doubleClick(edge);
    expect(edge).toHaveAttribute('aria-valuenow', '96');
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

  it('places children below Main and creation last while retaining compact navigation', () => {
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
    // The branch line is the substream's own mark now, in the slot the main
    // row gives the work stream's icon: no creator avatar, no outer connector.
    expect(child.querySelector('.workstream-context-mark > .tabler-icon-border-corner-pill')).not.toBeNull();
    expect(child.querySelector('.avatar')).toBeNull();
    // Never a conversation glyph, even though a substream now has an icon of
    // its own: the naming pass stores what it chose, and this rail draws the
    // branch line regardless — the payload behind these rows carries no
    // appearance to draw instead.
    expect(child.querySelector('.workstream-mark')).toBeNull();
    const sidebar = screen.getByRole('complementary');
    const navigation = within(sidebar).getAllByRole('button').slice(0, 3);
    expect(navigation.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Go to conversation: Launch preparation', 'Go to substream: Launch risks', 'New substream',
    ]);
    expect(sidebar.querySelectorAll('.tabler-icon-border-corner-pill')).toHaveLength(1);
    // The same arrow the main feed's New substream control carries, not an icon.
    expect(screen.getByRole('button', { name: 'New substream' }).querySelector('.workstream-new-substream-mark')?.textContent).toBe('\u21b3');
    fireEvent.click(screen.getByRole('button', { name: /Launch risks/ }));
    expect(onSelectSubstream).toHaveBeenCalledWith('00000000-0000-7000-8000-000000000099');
    fireEvent.click(screen.getByRole('button', { name: 'New substream' }));
    expect(onNewSubstream).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse work-stream sidebar' }));
    expect(sidebar).toHaveClass('is-compact');
    // Compact has no title, so the mark carries the substream's first letter.
    expect(screen.getByRole('button', { name: /Launch risks/ }).querySelector('.workstream-substream-initial')?.textContent).toBe('L');
    expect(sidebar.querySelectorAll('.tabler-icon-border-corner-pill')).toHaveLength(0);
    fireEvent.click(child);
    expect(onSelectSubstream).toHaveBeenLastCalledWith('00000000-0000-7000-8000-000000000099');
    fireEvent.click(screen.getByRole('button', { name: 'Go to conversation: Launch preparation' }));
    expect(onSelectSubstream).toHaveBeenLastCalledWith('0');
  });

  it('keeps the branch line for a substream whose title has no first character', () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Collapse work-stream sidebar' }));
    expect(sidebar).toHaveClass('is-compact');
    // A lone space is wire-legal, and an empty mark square says nothing at all.
    expect(sidebar.querySelector('.workstream-substream-initial')).toBeNull();
    expect(sidebar.querySelector('.tabler-icon-border-corner-pill')).not.toBeNull();
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
    expect(handle).toHaveAttribute('aria-valuenow', '96');
    fireEvent.pointerMove(handle, { clientX: 499, pointerId: 1 });
    expect(handle).toHaveAttribute('aria-valuenow', '96');
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
    expect(handle).toHaveAttribute('aria-valuenow', '96');
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
