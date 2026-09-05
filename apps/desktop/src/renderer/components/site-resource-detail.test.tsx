import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

/**
 * Every mint returns a *different* code, because the real one is single-use.
 * A surface that reused an earlier code would be indistinguishable from a
 * correct one against a constant fixture — and that is the single-use URL bug
 * these navigation tests pin, so the fixture must tell them apart.
 */
function mintingAccess() {
  let minted = 0;
  return vi.fn(async (): Promise<SiteArtifactAccess> => {
    minted += 1;
    return {
      openUrl: `https://${ARTIFACT}-g.rallyusercontent.test/__rally/open#code-${minted}`,
      canonicalUrl: CANONICAL,
      artifactId: ARTIFACT,
      mode: 'active',
      stateful: true,
    };
  });
}

function setup(overrides: Partial<SiteResourceDetailProps> = {}) {
  const props: SiteResourceDetailProps = {
    resourceId: RESOURCE,
    title: 'Offsite RSVP',
    openArtifact: mintingAccess(),
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
  it('keeps the native preview below nested dialogs and restores it when they close', async () => {
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 20, y: 40, width: 500, height: 320 }),
    );
    const { props } = setup();
    await waitFor(() => expect(props.surface.setBounds).toHaveBeenCalledWith({ x: 20, y: 40, width: 500, height: 320 }));
    const overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    document.body.append(overlay);
    await waitFor(() => expect(props.surface.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 0, height: 0 }));
    overlay.remove();
    await waitFor(() => expect(props.surface.setBounds).toHaveBeenLastCalledWith({ x: 20, y: 40, width: 500, height: 320 }));
    geometry.mockRestore();
  });

  it('hands the pane to the main process rather than embedding anything', async () => {
    // The renderer measures a rectangle and gets out of the way; it never
    // embeds artifact content itself.
    const { props } = setup();
    await waitFor(() => expect(props.surface.present).toHaveBeenCalled());
    expect(props.surface.present).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: ARTIFACT,
      bounds: expect.objectContaining({ width: expect.any(Number), height: expect.any(Number) }),
    }));
  });

  it('gives every navigating surface its own code, because redemption spends it', async () => {
    // Redemption clears the code in the same statement that reads it, so a
    // second surface handed the first one redeems nothing and lands on the
    // neutral page. Pop out and Open in browser were both dead this way.
    const { props } = setup();
    await waitFor(() => expect(props.surface.present).toHaveBeenCalled());
    const presented = vi.mocked(props.surface.present).mock.calls[0]?.[0]?.url;

    fireEvent.click(screen.getByRole('button', { name: /pop out/i }));
    await waitFor(() => expect(props.surface.popOut).toHaveBeenCalled());
    const poppedOut = vi.mocked(props.surface.popOut).mock.calls[0]?.[0]?.url;

    fireEvent.click(screen.getByRole('button', { name: /open in browser/i }));
    await waitFor(() => expect(props.surface.openExternal).toHaveBeenCalled());
    const external = vi.mocked(props.surface.openExternal).mock.calls[0]?.[0];

    expect(presented).toBeDefined();
    expect(new Set([presented, poppedOut, external]).size).toBe(3);
  });

  it('pairs a navigation URL with the artifact identity minted alongside it', async () => {
    // The URL origin and artifact id enforce different halves of the native
    // viewer's isolation. They must come from one access response rather than
    // combining a fresh URL with identity retained from an earlier response.
    const navigationArtifact = '3f2504e0-4f89-41d3-9a0c-0305e82c3399';
    const openArtifact = vi.fn()
      .mockResolvedValueOnce({
        openUrl: OPEN_URL,
        canonicalUrl: CANONICAL,
        artifactId: ARTIFACT,
        mode: 'active' as const,
        stateful: true,
      })
      .mockResolvedValueOnce({
        openUrl: `https://${navigationArtifact}-g.rallyusercontent.test/__rally/open#fresh-code`,
        canonicalUrl: `https://${navigationArtifact}-g.rallyusercontent.test`,
        artifactId: navigationArtifact,
        mode: 'active' as const,
        stateful: true,
      });
    const { props } = setup({ openArtifact });

    await waitFor(() => expect(props.surface.present).toHaveBeenCalled());
    expect(props.surface.present).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: navigationArtifact,
      url: expect.stringContaining(navigationArtifact),
    }));
  });

  it('shows the unavailable state when the preview cannot be presented at all', async () => {
    // A rejected mint or a main process that cannot composite leaves the
    // tri-state at `null` unless this path sets it — an empty bordered box
    // with no message and no way out.
    const { props } = setup({
      surface: surface({ present: vi.fn(async () => { throw new Error('no view'); }) }),
    });
    await waitFor(() => expect(props.surface.present).toHaveBeenCalled());
    expect(await screen.findByText(/preview unavailable here/i)).toBeTruthy();
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

  it('does not present after it goes away while minting a navigation', async () => {
    // Switching work streams unmounts this detail. If its second, navigation-
    // specific mint finishes afterwards, presenting then resurrects the old
    // native view after the cleanup has already tried to close it.
    let finishMint: ((access: SiteArtifactAccess) => void) | undefined;
    const openArtifact = vi.fn()
      .mockResolvedValueOnce({
        openUrl: OPEN_URL,
        canonicalUrl: CANONICAL,
        artifactId: ARTIFACT,
        mode: 'active' as const,
        stateful: true,
      })
      .mockImplementationOnce(() => new Promise<SiteArtifactAccess>((resolve) => {
        finishMint = resolve;
      }));
    const previewSurface = surface();
    const { unmount } = setup({ openArtifact, surface: previewSurface });
    await waitFor(() => expect(openArtifact).toHaveBeenCalledTimes(2));

    unmount();
    await act(async () => finishMint?.({
      openUrl: `${OPEN_URL}-late`,
      canonicalUrl: CANONICAL,
      artifactId: ARTIFACT,
      mode: 'active',
      stateful: true,
    }));

    // Exactly one close proves cleanup ran without a late continuation trying
    // to compensate by closing a second time after stale content was shown.
    expect(previewSurface.close).toHaveBeenCalledOnce();
    expect(previewSurface.present).not.toHaveBeenCalled();
  });
});

describe('the actions beside the preview', () => {
  it('labels and copies the canonical public link, which carries no access code', async () => {
    const { props } = setup();
    await waitFor(() => expect(props.surface.present).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /Copy public link/u }));
    expect(props.surface.copyText).toHaveBeenCalledWith(CANONICAL);
    expect(props.surface.copyText).not.toHaveBeenCalledWith(expect.stringContaining('#'));
  });

  it('pops out the artifact with its own access url', async () => {
    // Named for what it always claimed and did not do: this asserted the URL
    // the preview had already spent, which is why Pop out landed on the
    // neutral page rather than the site.
    const { props } = setup();
    await waitFor(() => expect(props.surface.present).toHaveBeenCalled());
    const presented = vi.mocked(props.surface.present).mock.calls[0]?.[0]?.url;
    fireEvent.click(screen.getByRole('button', { name: /Pop out/u }));
    await waitFor(() => expect(props.surface.popOut).toHaveBeenCalled());
    expect(props.surface.popOut).toHaveBeenCalledWith({
      artifactId: ARTIFACT,
      url: expect.stringContaining('/__rally/open#'),
      title: 'Offsite RSVP',
    });
    expect(vi.mocked(props.surface.popOut).mock.calls[0]?.[0]?.url).not.toBe(presented);
  });

  it('keeps every action disabled until access exists', () => {
    setup({ openArtifact: vi.fn(() => new Promise<SiteArtifactAccess>(() => undefined)) });
    for (const name of [/Pop out/u, /Copy public link/u, /Open in browser/u]) {
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
