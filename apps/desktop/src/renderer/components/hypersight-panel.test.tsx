import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HyperSight } from '../lib/types';
import { useUiStore } from '../lib/ui-store';
import { HyperSightPanel, HyperSightRail } from './hypersight-panel';

const hypersight: HyperSight = {
  versionId: '11111111-1111-4111-8111-111111111111',
  versionNumber: 2,
  updatedAt: '2026-08-07T12:00:00.000Z',
  blocks: [
    {
      id: '22222222-2222-4222-8222-222222222222',
      prompt: 'List the last tasks',
      latestRun: {
        id: '33333333-3333-4333-8333-333333333333',
        blockId: '22222222-2222-4222-8222-222222222222',
        configurationVersionId: '11111111-1111-4111-8111-111111111111',
        triggerSequence: 1,
        status: 'completed',
        markdown: '1. Ship the release\n2. Review telemetry',
        error: null,
        createdAt: '2026-08-07T12:00:01.000Z',
        startedAt: '2026-08-07T12:00:02.000Z',
        completedAt: '2026-08-07T12:00:03.000Z',
      },
    },
    {
      id: '44444444-4444-4444-8444-444444444444',
      prompt: 'Summarize the decision',
      latestRun: {
        id: '55555555-5555-4555-8555-555555555555',
        blockId: '44444444-4444-4444-8444-444444444444',
        configurationVersionId: '11111111-1111-4111-8111-111111111111',
        triggerSequence: 1,
        status: 'running',
        markdown: null,
        error: null,
        createdAt: '2026-08-07T12:00:04.000Z',
        startedAt: '2026-08-07T12:00:05.000Z',
        completedAt: null,
      },
    },
  ],
};

function renderPanel(onChange = vi.fn(async () => {})) {
  return {
    onChange,
    ...render(
      <Tooltip.Provider>
        <HyperSightPanel hypersight={hypersight} onChange={onChange} pending={false} />
      </Tooltip.Provider>,
    ),
  };
}

describe('HyperSightRail', () => {
  beforeEach(() => {
    useUiStore.setState({ hypersightOpen: true, hypersightWidth: 360 });
    window.innerWidth = 1_400;
  });

  it('resizes from the sidebar edge, clamps to 320–560, and stops after release', () => {
    render(
      <Tooltip.Provider>
        <HyperSightRail blockCount={2} onClose={vi.fn()}>content</HyperSightRail>
      </Tooltip.Provider>,
    );
    const handle = screen.getByRole('separator', { name: 'Resize HyperSight' });

    fireEvent.pointerDown(handle, { clientX: 1_040, pointerId: 7 });
    fireEvent.pointerMove(handle, { clientX: 1_000, pointerId: 7 });
    expect(useUiStore.getState().hypersightWidth).toBe(392);
    fireEvent.pointerMove(handle, { clientX: 1_400, pointerId: 7 });
    expect(useUiStore.getState().hypersightWidth).toBe(320);
    fireEvent.pointerMove(handle, { clientX: 0, pointerId: 7 });
    expect(useUiStore.getState().hypersightWidth).toBe(560);
    fireEvent.pointerUp(handle, { pointerId: 7 });
    fireEvent.pointerMove(handle, { clientX: 1_100, pointerId: 7 });
    expect(useUiStore.getState().hypersightWidth).toBe(560);
    expect(document.body).not.toHaveClass('is-resizing-rail');
  });

  it('resizes from the keyboard and closes on Escape', () => {
    const onClose = vi.fn();
    render(
      <Tooltip.Provider>
        <HyperSightRail blockCount={1} onClose={onClose}>content</HyperSightRail>
      </Tooltip.Provider>,
    );

    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize HyperSight' }), { key: 'ArrowLeft' });
    expect(useUiStore.getState().hypersightWidth).toBe(376);

    expect(screen.getByText('1 block')).toBeVisible();
    fireEvent.keyDown(screen.getByRole('complementary', { name: 'HyperSight' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    // The scrim behind the sidebar and the header control close it alike.
    const closeControls = screen.getAllByRole('button', { name: 'Close HyperSight' });
    expect(closeControls).toHaveLength(2);
    fireEvent.click(closeControls[1]!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('HyperSightPanel', () => {
  it('renders model Markdown and live refresh state inside separate blocks', () => {
    renderPanel();

    expect(screen.getByText('Ship the release')).toBeVisible();
    expect(screen.getByText('Review telemetry')).toBeVisible();
    expect(screen.getByText('Refreshing…')).toBeVisible();
  });

  it('edits a block prompt through the sparkle modal', async () => {
    const { onChange } = renderPanel();

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit HyperSight prompt' })[0]!);
    const prompt = screen.getByRole('textbox', { name: 'Prompt' });
    expect(prompt).toHaveValue('List the last tasks');
    fireEvent.change(prompt, { target: { value: 'Give me the five newest tasks' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save prompt' }));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith([
      { id: '22222222-2222-4222-8222-222222222222', prompt: 'Give me the five newest tasks' },
      { id: '44444444-4444-4444-8444-444444444444', prompt: 'Summarize the decision' },
    ]));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('deletes a block from the shared configuration', async () => {
    const { onChange } = renderPanel();

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete HyperSight block' })[0]!);

    await waitFor(() => expect(onChange).toHaveBeenCalledWith([
      { id: '44444444-4444-4444-8444-444444444444', prompt: 'Summarize the decision' },
    ]));
  });

  it('appends an empty block and opens its prompt editor', async () => {
    const { onChange } = renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Add block' }));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith([
      { id: '22222222-2222-4222-8222-222222222222', prompt: 'List the last tasks' },
      { id: '44444444-4444-4444-8444-444444444444', prompt: 'Summarize the decision' },
      { id: expect.any(String), prompt: '' },
    ]));
    expect(await screen.findByRole('dialog', { name: 'HyperSight block prompt' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue('');
  });

  it('moves blocks live during a grip drag and persists the final order once', async () => {
    const { onChange } = renderPanel();
    const grips = screen.getAllByRole('button', { name: 'Reorder HyperSight block' });
    const firstArticle = screen.getByText('Ship the release').closest('article');
    const secondArticle = screen.getByText('Refreshing…').closest('article');
    expect(firstArticle).not.toBeNull();
    expect(secondArticle).not.toBeNull();
    const dataTransfer = {
      effectAllowed: 'none',
      setData: vi.fn(),
      setDragImage: vi.fn(),
    };

    fireEvent.dragStart(grips[0]!, { dataTransfer });
    fireEvent.dragEnter(secondArticle!, { dataTransfer });
    expect(within(screen.getByRole('region', { name: 'HyperSight blocks' }))
      .getAllByRole('article').map((article) => article.textContent)).toEqual([
      expect.stringContaining('Refreshing'),
      expect.stringContaining('Ship the release'),
    ]);
    fireEvent.drop(secondArticle!, { dataTransfer });
    fireEvent.dragEnd(grips[0]!, { dataTransfer });

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange).toHaveBeenCalledWith([
      { id: '44444444-4444-4444-8444-444444444444', prompt: 'Summarize the decision' },
      { id: '22222222-2222-4222-8222-222222222222', prompt: 'List the last tasks' },
    ]);
  });

  it('preserves the live drag order when a block refresh arrives', async () => {
    const { onChange, rerender } = renderPanel();
    const grips = screen.getAllByRole('button', { name: 'Reorder HyperSight block' });
    const secondArticle = screen.getByText('Refreshing…').closest('article');
    const dataTransfer = {
      effectAllowed: 'none',
      setData: vi.fn(),
      setDragImage: vi.fn(),
    };

    fireEvent.dragStart(grips[0]!, { dataTransfer });
    fireEvent.dragEnter(secondArticle!, { dataTransfer });
    rerender(
      <Tooltip.Provider>
        <HyperSightPanel
          hypersight={{
            ...hypersight,
            blocks: hypersight.blocks.map((block) => block.id === hypersight.blocks[1]!.id
              ? { ...block, latestRun: { ...block.latestRun!, status: 'completed', markdown: 'Fresh summary' } }
              : block),
          }}
          onChange={onChange}
          pending={false}
        />
      </Tooltip.Provider>,
    );

    const panel = screen.getByRole('region', { name: 'HyperSight blocks' });
    expect(within(panel).getAllByRole('article').map((article) => article.textContent)).toEqual([
      expect.stringContaining('Fresh summary'),
      expect.stringContaining('Ship the release'),
    ]);
    fireEvent.drop(within(panel).getByText('Fresh summary').closest('article')!, { dataTransfer });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith([
      { id: '44444444-4444-4444-8444-444444444444', prompt: 'Summarize the decision' },
      { id: '22222222-2222-4222-8222-222222222222', prompt: 'List the last tasks' },
    ]));
  });

  it('reorders blocks from the keyboard and announces the new position', async () => {
    const { onChange } = renderPanel();
    const grips = screen.getAllByRole('button', { name: 'Reorder HyperSight block' });

    fireEvent.keyDown(grips[1]!, { key: 'ArrowUp' });

    await waitFor(() => expect(onChange).toHaveBeenCalledWith([
      { id: '44444444-4444-4444-8444-444444444444', prompt: 'Summarize the decision' },
      { id: '22222222-2222-4222-8222-222222222222', prompt: 'List the last tasks' },
    ]));
    expect(screen.getByText('Moved block to position 1 of 2.')).toBeInTheDocument();
  });
});
