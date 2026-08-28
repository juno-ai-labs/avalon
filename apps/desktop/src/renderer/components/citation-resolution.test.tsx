import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { useContext, useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import { CitationResolutionProvider } from './citation-resolution';
import { CitationResolutionContext } from './citations';

const getResource = vi.hoisted(() => vi.fn());
const session = vi.hoisted(() => ({ api: null as unknown }));

vi.mock('../lib/app-session', () => ({ useAppSession: () => session }));

/**
 * Asks for one resource the way a chip does, and shows what came back.
 *
 * The `request` call is unconditional and in an effect, because that is what
 * `useCitationResource` does — a probe that asked only while pending would
 * never exercise the remount path this file is here to pin.
 */
function Probe({ resourceId }: { resourceId: string }): React.JSX.Element {
  const { request, resolve } = useContext(CitationResolutionContext);
  useEffect(() => request(resourceId), [request, resourceId]);
  return <span data-testid={resourceId}>{resolve(resourceId).status}</span>;
}

/** Mounts the provider once, so a probe can come and go beneath it. */
function mount(ids: string[]): (next: string[]) => void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (probes: string[]): React.JSX.Element => (
    <QueryClientProvider client={client}>
      <CitationResolutionProvider>
        {probes.map((id) => <Probe key={id} resourceId={id} />)}
      </CitationResolutionProvider>
    </QueryClientProvider>
  );
  const { rerender } = render(tree(ids));
  return (next) => rerender(tree(next));
}

beforeEach(() => {
  getResource.mockReset();
  session.api = { getResource };
});

describe('citation resolution', () => {
  it('reads a cited resource once and reports its kind', async () => {
    getResource.mockResolvedValue({ id: 'a', title: 'Deck', resourceType: 'document' });

    mount(['a']);

    await waitFor(() => expect(screen.getByTestId('a')).toHaveTextContent('resolved'));
    expect(getResource).toHaveBeenCalledWith('a', expect.anything());
  });

  it('does not re-read a resource whose chip scrolls away and back', async () => {
    // The transcript is virtualised, so a chip remounts as it comes into view.
    // A resolved read is covered by the query cache; a *failed* one is not —
    // react-query never treats an errored query as fresh — so an unavailable
    // resource cited in a long thread would issue a 403 on every remount. That
    // is what the guard has to sit ahead of the fetch to prevent; inside the
    // state updater it gates the state write and nothing else.
    getResource.mockRejectedValue(new ApiError('Forbidden', 403));

    const remount = mount(['gone']);
    await waitFor(() => expect(screen.getByTestId('gone')).toHaveTextContent('unavailable'));

    remount([]);
    remount(['gone']);
    await waitFor(() => expect(screen.getByTestId('gone')).toHaveTextContent('unavailable'));

    expect(getResource).toHaveBeenCalledTimes(1);
  });

  it('degrades a resource the viewer may not see, so its chip becomes text', async () => {
    getResource.mockRejectedValue(new ApiError('Forbidden', 403));

    mount(['secret']);

    await waitFor(() => expect(screen.getByTestId('secret')).toHaveTextContent('unavailable'));
  });

  it('leaves a chip drawn when the read fails for any other reason', async () => {
    // A 500 or a dropped connection is not "you cannot see this". Collapsing an
    // affordance the reader is looking at, and never restoring it, is worse
    // than a chip drawn from the label the message already carried.
    getResource.mockRejectedValue(new ApiError('Server error', 500));

    mount(['flaky']);

    await waitFor(() => expect(getResource).toHaveBeenCalled());
    expect(screen.getByTestId('flaky')).toHaveTextContent('pending');
  });

  it('asks for nothing before a session exists', async () => {
    session.api = null;

    mount(['a']);

    await waitFor(() => expect(screen.getByTestId('a')).toHaveTextContent('pending'));
    expect(getResource).not.toHaveBeenCalled();
  });
});
