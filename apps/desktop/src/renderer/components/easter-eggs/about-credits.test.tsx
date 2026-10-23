import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AboutRally } from './about-credits';

describe('AboutRally', () => {
  it('shows the version and keeps the credits hidden', () => {
    render(<AboutRally version="1.2.3" versionLabel="Version" />);
    expect(screen.getByText('1.2.3')).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Credits' })).not.toBeInTheDocument();
  });

  it('reveals the credits on the seventh quick click on the version', () => {
    render(<AboutRally version="1.2.3" versionLabel="Version" />);
    const version = screen.getByRole('button', { name: '1.2.3' });
    for (let click = 0; click < 6; click += 1) fireEvent.click(version);
    expect(screen.queryByRole('region', { name: 'Credits' })).not.toBeInTheDocument();
    fireEvent.click(version);
    const credits = within(screen.getByRole('region', { name: 'Credits' }));
    expect(credits.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Adam J', 'Alex T', 'Katherine B', 'Zzyzx']);
  });
});
