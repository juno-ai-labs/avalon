import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  formatCell,
  SiteResourceDetail,
  type SiteArtifactAccess,
  type SiteResourceDetailProps,
} from './site-resource-detail';

const ARTIFACT = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const RESOURCE = '3f2504e0-4f89-41d3-9a0c-0305e82c3302';
const OPEN_URL = `https://${ARTIFACT}-g.rallyusercontent.test/__rally/open#code`;
const CANONICAL = `https://${ARTIFACT}-g.rallyusercontent.test`;

function surface(overrides: Partial<SiteResourceDetailProps['surface']> = {}) {
  return {
    present: vi.fn(async () => true),
    setBounds: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    popOut: vi.fn(async () => undefined),
    copyText: vi.fn(async () => undefined),
    openExternal: vi.fn(async () => undefined),
    ...overrides,
  };
}

function setup(overrides: Partial<SiteResourceDetailProps> = {}) {
  const access: SiteArtifactAccess = {
    openUrl: OPEN_URL,
    canonicalUrl: CANONICAL,
    artifactId: ARTIFACT,
    mode: 'active',
    stateful: true,
  };
  const props: SiteResourceDetailProps = {
    resourceId: RESOURCE,
    title: 'Offsite RSVP',
    openArtifact: vi.fn(async () => access),
    describeData: vi.fn(async () => ({
      tables: [{
        name: 'rsvps',
        columns: [{ name: 'name', type: 'TEXT' }, { name: 'answer', type: 'TEXT' }],
        rowCount: 2,
      }],
    })),
    loadTable: vi.fn(async () => ({
      rows: [{ name: 'Ada', answer: 'yes' }, { name: 'Grace', answer: null }],
      csv: '"name","answer"\r\n"Ada","yes"\r\n"Grace",""',
    })),
    loadErrors: vi.fn(async () => []),
    surface: surface(),
    ...overrides,
  };
  return { props, ...render(<SiteResourceDetail {...props} />) };
}

describe('showing a live artifact in the rail', () => {
  it('mints access once and hands the pane to the main process', async () => {
    // The renderer measures a rectangle and gets out of the way; it never
    // embeds artifact content itself.
    const { props } = setup();
    await waitFor(() => expect(props.surface.present).toHaveBeenCalled());
    expect(props.openArtifact).toHaveBeenCalledTimes(1);
    expect(props.surface.present).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: ARTIFACT,
      url: OPEN_URL,
      bounds: expect.objectContaining({ width: expect.any(Number), height: expect.any(Number) }),
    }));
  });

  it('renders nothing into the pane while a view is composited over it', async () => {
    // The view covers the rectangle, so anything drawn here would be either
    // invisible or peeking out from behind model-authored content.
    const { props } = setup();
    await waitFor(() => expect(props.surface.present).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('site-preview-pane').textContent).toBe(''));
  });

  it('never flashes its unavailable state on a preview that is about to work', async () => {
    // The gap between access arriving and the main process answering is not a
    // failure, and a boolean could not tell the two apart — which is why the
    // component tracks "not attempted" separately from "refused".
    let answer: ((shown: boolean) => void) | null = null;
    const pending = new Promise<boolean>((resolve) => { answer = resolve; });
    setup({ surface: surface({ present: vi.fn(() => pending) }) });
    await waitFor(() => expect(answer).not.toBeNull());
    expect(screen.queryByText('Preview unavailable here')).not.toBeInTheDocument();
    answer!(true);
    await waitFor(() => expect(screen.getByTestId('site-preview-pane').textContent).toBe(''));
  });

  it('falls back to a legible state where nothing can be composited', async () => {
    // The browser build, or a URL the main process refused.
    setup({ surface: surface({ present: vi.fn(async () => false) }) });
    expect(await screen.findByText('Preview unavailable here')).toBeInTheDocument();
    expect(screen.getByText(/Open it in your browser/u)).toBeInTheDocument();
  });

  it('says so plainly when the artifact could not be opened', async () => {
    setup({ openArtifact: vi.fn(async () => { throw new Error('You can no longer see this work stream.'); }) });
    expect(await screen.findByText('This site could not be opened')).toBeInTheDocument();
    expect(screen.getByText('You can no longer see this work stream.')).toBeInTheDocument();
  });

  it('tears the preview down when it goes away', async () => {
    const { props, unmount } = setup();
    await waitFor(() => expect(props.surface.present).toHaveBeenCalled());
    unmount();
    expect(props.surface.close).toHaveBeenCalled();
  });
});

describe('the actions beside the preview', () => {
  it('copies the canonical link, which carries no access code', async () => {
    // That is precisely what makes it safe to paste anywhere.
    const { props } = setup();
    await waitFor(() => expect(props.surface.present).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /Copy link/u }));
    expect(props.surface.copyText).toHaveBeenCalledWith(CANONICAL);
    expect(props.surface.copyText).not.toHaveBeenCalledWith(expect.stringContaining('#'));
  });

  it('pops out the artifact with its own access url', async () => {
    const { props } = setup();
    await waitFor(() => expect(props.surface.present).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /Pop out/u }));
    expect(props.surface.popOut).toHaveBeenCalledWith({
      artifactId: ARTIFACT,
      url: OPEN_URL,
      title: 'Offsite RSVP',
    });
  });

  it('keeps every action disabled until access exists', () => {
    setup({ openArtifact: vi.fn(() => new Promise<SiteArtifactAccess>(() => undefined)) });
    for (const name of [/Pop out/u, /Copy link/u, /Open in browser/u]) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
  });
});

describe('the data a stateful site collected', () => {
  it('shows the tables, and only offers the panel for a site that keeps data', async () => {
    const { props } = setup();
    await waitFor(() => expect(props.surface.present).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('tab', { name: /Data/u }));
    expect(await screen.findByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('yes')).toBeInTheDocument();
  });

  it('offers no data panel for a site that keeps none', async () => {
    setup({
      openArtifact: vi.fn(async () => ({
        openUrl: OPEN_URL, canonicalUrl: CANONICAL, artifactId: ARTIFACT,
        mode: 'static' as const, stateful: false,
      })),
    });
    await waitFor(() => expect(screen.getByText('Live page')).toBeInTheDocument());
    expect(screen.queryByRole('tab', { name: /Data/u })).not.toBeInTheDocument();
  });

  it('shows an empty stored table as such rather than as a broken panel', async () => {
    const { props } = setup({ describeData: vi.fn(async () => ({ tables: [] })) });
    await waitFor(() => expect(props.surface.present).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('tab', { name: /Data/u }));
    expect(await screen.findByText('No data yet')).toBeInTheDocument();
  });

  it('copies the CSV the server rendered rather than rebuilding it', async () => {
    // One read, one CSV: a renderer that re-derived it could disagree with the
    // export a person got from anywhere else.
    const { props } = setup();
    await waitFor(() => expect(props.surface.present).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('tab', { name: /Data/u }));
    await screen.findByText('Ada');
    fireEvent.click(screen.getByRole('button', { name: /Copy as CSV/u }));
    await waitFor(() => expect(props.surface.copyText)
      .toHaveBeenCalledWith('"name","answer"\r\n"Ada","yes"\r\n"Grace",""'));
  });
});

describe('what the site itself threw', () => {
  it('shows an error a participant can paste back into chat', async () => {
    const { props } = setup({
      loadErrors: vi.fn(async () => [{
        occurredAt: Date.parse('2026-09-01T10:00:00Z'),
        version: 2,
        requestPath: '/api/rsvps',
        message: 'TypeError: rows is not iterable',
        stack: null,
      }]),
    });
    await waitFor(() => expect(props.surface.present).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('tab', { name: /Errors/u }));
    expect(await screen.findByText('TypeError: rows is not iterable')).toBeInTheDocument();
    expect(screen.getByText('/api/rsvps')).toBeInTheDocument();
  });

  it('says a healthy site has thrown nothing', async () => {
    const { props } = setup();
    await waitFor(() => expect(props.surface.present).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('tab', { name: /Errors/u }));
    expect(await screen.findByText('No errors')).toBeInTheDocument();
  });
});

describe('rendering one stored value', () => {
  it('distinguishes an absent value from an empty one', () => {
    // React renders null as nothing, which reads as an empty string rather
    // than as a value that was never there.
    expect(formatCell(null)).toBe('—');
    expect(formatCell(undefined)).toBe('—');
    expect(formatCell('')).toBe('');
  });

  it('renders numbers and booleans rather than dropping false and zero', () => {
    expect(formatCell(0)).toBe('0');
    expect(formatCell(false)).toBe('false');
  });

  it('never renders an object as [object Object]', () => {
    expect(formatCell({ a: 1 })).toBe('{"a":1}');
  });
});
