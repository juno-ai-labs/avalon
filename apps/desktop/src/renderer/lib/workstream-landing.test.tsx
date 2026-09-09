import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigationType } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { WORKSTREAM_LANDING_ROUTE, skippedWorkstreamIds, useOpenFirstWorkstream } from './workstream-landing';

function Leaver(): React.JSX.Element {
  const openFirstWorkstream = useOpenFirstWorkstream();
  return <button onClick={() => openFirstWorkstream(['gone'])} type="button">leave</button>;
}

function Landing(): React.JSX.Element {
  const location = useLocation();
  return <div data-testid="landing">{`${useNavigationType()} ${location.pathname} ${[...skippedWorkstreamIds(location.state)].join(',')}`}</div>;
}

describe('useOpenFirstWorkstream', () => {
  it('replaces the current entry with the landing and names the rows to pass over', () => {
    render(<MemoryRouter initialEntries={['/workstreams/gone']}><Routes>
      <Route element={<Leaver />} path="/workstreams/:id" />
      <Route element={<Landing />} path={WORKSTREAM_LANDING_ROUTE} />
    </Routes></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'leave' }));
    // REPLACE, so Back cannot return to the screen that was left.
    expect(screen.getByTestId('landing')).toHaveTextContent('REPLACE / gone');
  });
});

describe('skippedWorkstreamIds', () => {
  it('reads only string ids, and nothing from a bare visit', () => {
    expect([...skippedWorkstreamIds(null)]).toEqual([]);
    expect([...skippedWorkstreamIds({ returnTo: '/x' })]).toEqual([]);
    expect([...skippedWorkstreamIds({ skipWorkstreamIds: ['a', 1, 'b'] })]).toEqual(['a', 'b']);
  });
});
