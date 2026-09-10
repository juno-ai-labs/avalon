import { act, fireEvent, render, screen, within } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkstreamResource } from '../lib/types';
import { SITE_MANIFEST_MIME_TYPE, asSubstreamId, asUserId } from '@rally/contracts';
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

describe('WorkstreamSidebar', () => {
  it('shows the work stream, its artifacts, then participants, excluding sources and substreams', () => {
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
    // The ↳ arrow is the substream's own mark, in the slot the main row gives
    // the work stream's icon: no creator avatar, no outer connector, and not
    // the faint branch line this rail once drew.
    expect(child.querySelector('.workstream-context-mark > .tabler-icon-corner-down-right')).not.toBeNull();
    expect(child.querySelector('.tabler-icon-border-corner-pill')).toBeNull();
    expect(child.querySelector('.avatar')).toBeNull();
    // Never a conversation glyph, even though a substream now has an icon of
    // its own: the naming pass stores what it chose, and this rail draws the
    // arrow regardless — the payload behind these rows carries no appearance
    // to draw instead.
    expect(child.querySelector('.workstream-mark')).toBeNull();
    const sidebar = screen.getByRole('complementary');
    const navigation = within(sidebar).getAllByRole('button').slice(0, 3);
    expect(navigation.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Go to conversation: Launch preparation', 'Go to substream: Launch risks', 'New substream',
    ]);
    expect(sidebar.querySelectorAll('.tabler-icon-corner-down-right')).toHaveLength(1);
    // A plus, so the row that starts a substream is not marked like the rows
    // that are one.
    expect(screen.getByRole('button', { name: 'New substream' }).querySelector('.workstream-context-mark > .tabler-icon-plus')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'New substream' }).querySelector('.tabler-icon-corner-down-right')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Launch risks/ }));
    expect(onSelectSubstream).toHaveBeenCalledWith('00000000-0000-7000-8000-000000000099');
    fireEvent.click(screen.getByRole('button', { name: 'New substream' }));
    expect(onNewSubstream).toHaveBeenCalledOnce();
    // Compact has no title, so the mark carries the substream's first letter.
    // Both marks are in the slot in both widths — the stylesheet cross-fades
    // one into the other as the rail narrows — so the letter is already
    // there, and the arrow stays after the toggle.
    expect(child.querySelector('.workstream-substream-initial')?.textContent).toBe('L');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse work-stream sidebar' }));
    expect(sidebar).toHaveClass('is-compact');
    expect(screen.getByRole('button', { name: /Launch risks/ }).querySelector('.workstream-substream-initial')?.textContent).toBe('L');
    expect(sidebar.querySelectorAll('.tabler-icon-corner-down-right')).toHaveLength(1);
    fireEvent.click(child);
    expect(onSelectSubstream).toHaveBeenLastCalledWith('00000000-0000-7000-8000-000000000099');
    fireEvent.click(screen.getByRole('button', { name: 'Go to conversation: Launch preparation' }));
    expect(onSelectSubstream).toHaveBeenLastCalledWith('0');
  });

  it('keeps the arrow for a substream whose title has no first character', () => {
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
    expect(sidebar.querySelector('.tabler-icon-corner-down-right')).not.toBeNull();
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
      expect(row.querySelector('.tabler-icon-rosette-asterisk'), title).not.toBeNull();
    }
  });

  // Same divider, same silence: the double-click that collapses this rail is
  // written down nowhere else, so which way the hint names has to follow the
  // state the next one would leave behind.
  it('names the drag and the double-click, in the direction the next one goes', () => {
    setup();
    const edge = screen.getByRole('separator', { name: 'Resize work-stream sidebar' });

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
    const edge = screen.getByRole('separator', { name: 'Resize work-stream sidebar' });

    fireEvent.keyDown(edge, { key: 'Enter' });
    expect(edge).toHaveAttribute('aria-valuenow', '96');
    fireEvent.keyDown(edge, { key: 'Enter' });
    expect(edge).toHaveAttribute('aria-valuenow', '280');

    act(() => { width = 703; resized(); });
    expect(edge).toHaveAttribute('aria-valuenow', '96');
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
    const edge = screen.getByRole('separator', { name: 'Resize work-stream sidebar' });

    fireEvent.focus(edge);

    expect(screen.getByRole('tooltip')).toHaveTextContent('Drag to resize');
    expect(screen.getByRole('tooltip')).not.toHaveTextContent('Double-click');
  });

  it('drops the artifact section entirely until a work stream has one', () => {
    setup({ ...workstream, resources: [], participants: [] });
    expect(screen.queryByRole('region', { name: 'Artifacts' })).not.toBeInTheDocument();
    expect(screen.queryByText('Artifacts')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manage work-stream participants' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Launch draft.md' })).not.toBeInTheDocument();
  });

  it('heads the section with the artifacts a work stream has produced', () => {
    setup();
    expect(within(screen.getByRole('region', { name: 'Artifacts' })).getByRole('heading', { name: 'Artifacts' })).toBeInTheDocument();
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
