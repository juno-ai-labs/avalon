import { render, screen, within } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';

import { DetailHeaderActions, DetailHeaderActionsHost } from './detail-header-actions';

function Host({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [target, setTarget] = React.useState<HTMLDivElement | null>(null);
  return (
    <>
      <div data-testid="header" ref={setTarget} />
      <div data-testid="body">
        <DetailHeaderActionsHost target={target}>{children}</DetailHeaderActionsHost>
      </div>
    </>
  );
}

describe('a detail contributing actions to its host header', () => {
  it('draws them in the header rather than where they were written', () => {
    render(<Host><DetailHeaderActions><button type="button">Pop out</button></DetailHeaderActions></Host>);

    expect(within(screen.getByTestId('header')).getByRole('button', { name: 'Pop out' })).toBeInTheDocument();
    expect(within(screen.getByTestId('body')).queryByRole('button', { name: 'Pop out' })).not.toBeInTheDocument();
  });

  it('arrives once the slot does, rather than only if it was there first', () => {
    // The host's element is state for this reason: it does not exist on the
    // render that declares it, and a detail that gave up at that point would
    // contribute nothing for the life of the surface.
    render(<Host><DetailHeaderActions><button type="button">Pop out</button></DetailHeaderActions></Host>);

    expect(screen.getByRole('button', { name: 'Pop out' })).toBeInTheDocument();
  });

  it('draws nothing at all where no host offers a slot', () => {
    render(<DetailHeaderActions><button type="button">Pop out</button></DetailHeaderActions>);

    expect(screen.queryByRole('button', { name: 'Pop out' })).not.toBeInTheDocument();
  });
});
