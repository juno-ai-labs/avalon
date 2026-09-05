import { act, fireEvent, render, screen, within } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkstreamResource } from '../lib/types';
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
  const view = render(<Tooltip.Provider><div><WorkstreamSidebar workstream={detail} presentUserIds={[person.id]} onOpenArtifact={onOpenArtifact} onParticipants={onParticipants} /><div role="log" tabIndex={0} /></div></Tooltip.Provider>);
  return { ...view, onOpenArtifact, onParticipants };
}

beforeEach(() => {
  localStorage.clear();
  width = 900;
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
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
      'Collapse work-stream sidebar', 'Launch preparation', 'Open Launch draft.md', 'Ada Lovelace, viewing now', 'Manage work-stream participants',
    ]);
    expect(screen.queryByText('Source ticket')).not.toBeInTheDocument();
    expect(screen.queryByText('Substreams')).not.toBeInTheDocument();
    expect(screen.getByText('document · v2')).toBeInTheDocument();
  });

  it('opens artifacts only on click with the clicked button as the preview focus return target', () => {
    const { onOpenArtifact } = setup();
    expect(onOpenArtifact).not.toHaveBeenCalled();
    const button = screen.getByRole('button', { name: 'Open Launch draft.md' });
    fireEvent.click(button);
    expect(onOpenArtifact).toHaveBeenCalledWith(artifact.id, button);
  });

  it('focuses the conversation and offers participant management', () => {
    const { onParticipants } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Launch preparation' }));
    expect(screen.getByRole('log')).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Ada Lovelace, viewing now' }));
    expect(onParticipants).toHaveBeenCalledTimes(1);
  });

  it('persists an independent icon-mode preference and restores expanded mode', () => {
    const view = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse work-stream sidebar' }));
    expect(screen.getByRole('complementary')).toHaveClass('is-compact');
    expect(localStorage.getItem('rally.sidebar-collapsed')).toBeNull();
    view.unmount();
    setup();
    expect(screen.getByRole('button', { name: 'Expand work-stream sidebar' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'Open Launch draft.md' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expand work-stream sidebar' }));
    expect(screen.getByRole('complementary')).not.toHaveClass('is-compact');
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

  it('replaces resources and participants when the selected work stream changes', () => {
    const { rerender, onOpenArtifact, onParticipants } = setup();
    rerender(<Tooltip.Provider><div><WorkstreamSidebar workstream={{ ...workstream, id: '00000000-0000-7000-8000-000000000022', title: 'Another work stream', resources: [], participants: [] }} presentUserIds={[]} onOpenArtifact={onOpenArtifact} onParticipants={onParticipants} /></div></Tooltip.Provider>);
    expect(screen.getByRole('button', { name: 'Another work stream' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('button', { name: 'Open Launch draft.md' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Ada Lovelace/ })).not.toBeInTheDocument();
  });
});
