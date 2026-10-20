import * as Tooltip from '@radix-ui/react-tooltip';
import { TitlePillHeader } from '@rally/ui/components/title-pill';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IconCircle } from '@tabler/icons-react';
import { HashRouter, useLocation, useNavigate } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { NavigationHistoryProvider } from './navigation-history';

function Surface(): React.JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  return <>
    <TitlePillHeader current={{ key: 'current', title: 'Thread', icon: <IconCircle />, label: 'Thread menu' }} />
    <output>{JSON.stringify({ path: location.pathname, search: location.search, state: location.state })}</output>
    <button onClick={() => void navigate('/artifact?version=2', { state: { expanded: true } })}>Open artifact</button>
    <button onClick={() => void navigate('/other')}>Open other</button>
    <button onClick={() => void navigate('/replacement', { replace: true })}>Replace</button>
  </>;
}

function start(enabled = true): void {
  window.history.replaceState({ idx: 0 }, '', '#/');
  render(<Tooltip.Provider><HashRouter><NavigationHistoryProvider enabled={enabled}><Surface /></NavigationHistoryProvider></HashRouter></Tooltip.Provider>);
}

const click = (name: string): void => { fireEvent.click(screen.getByRole('button', { name })); };
const path = async (pathname: string): Promise<void> => {
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(`"path":"${pathname}"`));
};

describe('navigation history', () => {
  it('traverses real router entries, restores query and expansion state, and drops a forward branch on a new visit', async () => {
    start();
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled();
    click('Open artifact');
    click('Back');
    await path('/');
    expect(screen.getByRole('button', { name: 'Forward' })).toBeEnabled();
    click('Forward');
    await path('/artifact');
    expect(screen.getByRole('status')).toHaveTextContent('"search":"?version=2","state":{"expanded":true}');
    click('Back');
    await path('/');
    click('Open other');
    expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled();
    click('Replace');
    click('Back');
    await path('/');
    click('Forward');
    await path('/replacement');
  });

  it('preserves forward visits when replacing an earlier entry', async () => {
    start();
    click('Open artifact');
    click('Open other');
    click('Back');
    await path('/artifact');
    click('Replace');
    expect(screen.getByRole('button', { name: 'Forward' })).toBeEnabled();
    click('Forward');
    await path('/other');
    click('Back');
    await path('/replacement');
  });

  it('leaves the browser header without history controls', () => {
    start(false);
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Forward' })).toBeNull();
  });
});
