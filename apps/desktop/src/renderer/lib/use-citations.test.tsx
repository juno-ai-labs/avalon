import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkstreamResource } from './types';
import { useUiStore } from './ui-store';
import { useCitations } from './use-citations';

const openExternal = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('./platform', () => ({ desktopBridge: () => ({ openExternal }) }));

const DECK: WorkstreamResource = {
  id: 'board-deck',
  title: 'Q3 board deck',
  resourceType: 'document',
  watchEnabled: false,
  watchStatus: 'unsupported',
  currentVersion: 1,
  relationshipType: 'context',
  direction: 'source',
};

beforeEach(() => {
  openExternal.mockClear();
  useUiStore.setState({ inspector: null, railOpen: false, railVariant: 'context' });
});

type ResourceLookup = NonNullable<Parameters<typeof useCitations>[0]['api']>;

function api(overrides: { getResource?: ResourceLookup['getResource'] } = {}): ResourceLookup {
  return { getResource: overrides.getResource ?? vi.fn(async () => DECK) } satisfies ResourceLookup;
}

/**
 * Resolution the way the renderer does it: from inside a render, once per
 * citation on screen. Calling `resolve` outside one would leave the collected
 * miss sitting in its ref with no commit behind it to flush — which is not a
 * state the app can reach, and not one worth asserting about.
 */
function Transcript({ cites, getResource, resources = [] }: {
  cites: string[];
  getResource?: ResourceLookup['getResource'];
  resources?: WorkstreamResource[];
}): React.JSX.Element {
  const citations = useCitations({ api: api(getResource ? { getResource } : {}), resources });
  return <>{cites.map((id) => <span data-testid={id} key={id}>{citations.resolve(id)?.title ?? 'label text'}</span>)}</>;
}

describe('useCitations', () => {
  it('resolves a resource the loaded work stream already carries without asking the API', () => {
    const getResource = vi.fn();
    const { result } = renderHook(() => useCitations({ api: api({ getResource }), resources: [DECK] }));

    expect(result.current.resolve('board-deck')).toEqual({
      id: 'board-deck',
      title: 'Q3 board deck',
      resourceType: 'document',
    });
    expect(getResource).not.toHaveBeenCalled();
  });

  it('looks a cited resource up across the workspace when the work stream has not loaded it', async () => {
    const getResource = vi.fn(async () => ({ ...DECK, id: 'elsewhere', title: 'Another workstream doc' }));
    render(<Transcript cites={['elsewhere']} getResource={getResource} resources={[DECK]} />);

    // Nothing to show on the first pass, which is the label-text degradation.
    expect(screen.getByTestId('elsewhere')).toHaveTextContent('label text');
    await waitFor(() => expect(screen.getByTestId('elsewhere')).toHaveTextContent('Another workstream doc'));
    expect(getResource).toHaveBeenCalledExactlyOnceWith('elsewhere');
  });

  it('asks once per identifier, however many citations name it', async () => {
    const getResource = vi.fn(async () => DECK);
    render(<Transcript cites={['board-deck', 'board-deck', 'board-deck']} getResource={getResource} />);

    await waitFor(() => expect(screen.getAllByText('Q3 board deck')).toHaveLength(3));
    expect(getResource).toHaveBeenCalledTimes(1);
  });

  it('remembers a denial, so an unauthorized citation does not retry on every commit', async () => {
    const getResource = vi.fn(async () => { throw new Error('resource_not_found'); });
    const { rerender } = render(<Transcript cites={['secret']} getResource={getResource} />);

    await waitFor(() => expect(getResource).toHaveBeenCalledTimes(1));
    for (let pass = 0; pass < 3; pass += 1) rerender(<Transcript cites={['secret']} getResource={getResource} />);
    // The denial is remembered, not retried: the label text is all a viewer who
    // may not see the resource ever gets, and they get it once.
    expect(screen.getByTestId('secret')).toHaveTextContent('label text');
    expect(getResource).toHaveBeenCalledTimes(1);
  });

  it('opens the context rail first and selects the resource second', () => {
    const { result } = renderHook(() => useCitations({ api: api(), resources: [DECK] }));

    act(() => { result.current.open({ scheme: 'resource', resourceId: 'board-deck' }); });

    // The order is the contract: `openRail` deliberately clears the inspector,
    // so selecting first would leave the rail on its list instead of the detail.
    expect(useUiStore.getState().railOpen).toBe(true);
    expect(useUiStore.getState().railVariant).toBe('context');
    expect(useUiStore.getState().inspector).toEqual({ type: 'resource', id: 'board-deck' });
  });

  it('sends an external source to the system browser and never to the rail', () => {
    const { result } = renderHook(() => useCitations({ api: api(), resources: [DECK] }));

    act(() => { result.current.open({ scheme: 'external', url: 'https://example.com/memo' }); });

    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://example.com/memo');
    expect(useUiStore.getState().railOpen).toBe(false);
  });

  it('opens nothing for a target that names an identity or nothing at all', () => {
    const { result } = renderHook(() => useCitations({ api: api(), resources: [DECK] }));

    act(() => {
      result.current.open({ scheme: 'person', personId: 'x' });
      result.current.open({ scheme: 'connector' });
      result.current.open({ scheme: 'unknown' });
    });

    expect(openExternal).not.toHaveBeenCalled();
    expect(useUiStore.getState().railOpen).toBe(false);
    expect(useUiStore.getState().inspector).toBeNull();
  });

  it('resolves nothing at all when the app has no API session yet', () => {
    const { result } = renderHook(() => useCitations({ api: null, resources: [] }));

    expect(result.current.resolve('board-deck')).toBeUndefined();
  });
});
