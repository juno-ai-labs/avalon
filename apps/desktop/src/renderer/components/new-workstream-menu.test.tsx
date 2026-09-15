import { fireEvent, render, screen } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { NewWorkstreamMenu } from './new-workstream-menu';

function Location() {
  const location = useLocation();
  return <output>{location.pathname}{location.search}</output>;
}

describe('work stream creation menu', () => {
  it.each([
    ['start new work stream', '/workstreams/new'],
    ['import from ChatGPT or Claude', '/workstreams/new?import=session'],
  ])('routes %s from the plus popup', (label, destination) => {
    render(<MemoryRouter initialEntries={['/workstreams/current']}><Tooltip.Provider>
      <NewWorkstreamMenu returnTo="/workstreams/current" onStart={vi.fn()}><button type="button">Plus</button></NewWorkstreamMenu>
      <Location />
    </Tooltip.Provider></MemoryRouter>);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Plus' }), { key: 'ArrowDown' });
    expect(screen.getAllByRole('menuitem')).toHaveLength(2);
    fireEvent.click(screen.getByRole('menuitem', { name: label }));
    expect(screen.getByRole('status')).toHaveTextContent(destination);
  });
});
