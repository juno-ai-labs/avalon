import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { describe, expect, it, vi } from 'vitest';

import type { HyperSight } from '../lib/types';
import { HyperSightPanel, HyperSightResizeHandle } from './hypersight-panel';

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

describe('HyperSightPanel', () => {
  it('clamps panel resizing to 18–58 percent of the main view', () => {
    const onResize = vi.fn();
    const { container } = render(
      <div className="workstream-screen">
        <div className="hypersight-shell">
          <HyperSightResizeHandle onResize={onResize} />
        </div>
      </div>,
    );
    const mainView = container.querySelector('.workstream-screen') as HTMLElement;
    const shell = container.querySelector('.hypersight-shell') as HTMLElement;
    vi.spyOn(mainView, 'getBoundingClientRect').mockReturnValue({ height: 1_000 } as DOMRect);
    vi.spyOn(shell, 'getBoundingClientRect').mockReturnValue({ height: 300 } as DOMRect);

    fireEvent.pointerDown(screen.getByRole('separator', { name: 'Resize HyperSight' }), { clientY: 300 });
    fireEvent.pointerMove(window, { clientY: 1_000 });
    expect(onResize).toHaveBeenLastCalledWith(580);
    fireEvent.pointerMove(window, { clientY: -1_000 });
    expect(onResize).toHaveBeenLastCalledWith(180);
    fireEvent.pointerUp(window);
  });

  it('renders model Markdown and live refresh state inside separate blocks', () => {
    renderPanel();

    expect(screen.getByRole('heading', { name: 'HyperSight' })).toBeVisible();
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
    expect(within(screen.getByRole('region', { name: 'HyperSight' }))
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
});
