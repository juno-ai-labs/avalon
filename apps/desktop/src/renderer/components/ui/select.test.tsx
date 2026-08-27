import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Select } from './select';

/**
 * This came over from `DropdownSelect`, which it replaced, and lost the
 * assertion that made it brittle: it used to check the trigger carried
 * `dropdown-select-trigger-secondary`. That named the stylesheet rather than
 * the behaviour, so it would have passed against a variant that rendered the
 * class and none of the styling, and failed against one that was correct but
 * spelled differently. What the settings row needs is a labelled combobox
 * whose options open.
 */
describe('Select', () => {
  it('exposes a labelled combobox whose options open', () => {
    render(
      <Select
        label="Personal default timezone"
        onValueChange={vi.fn()}
        options={[{ label: 'Pacific time', value: 'America/Los_Angeles' }]}
        value="America/Los_Angeles"
        variant="quiet"
      />,
    );

    const trigger = screen.getByRole('combobox', { name: 'Personal default timezone' });
    expect(trigger).toHaveTextContent('Pacific time');
    fireEvent.click(trigger);
    expect(screen.getByRole('option', { name: 'Pacific time' })).toBeVisible();
  });

  it('reports the chosen value', () => {
    const onValueChange = vi.fn();
    render(
      <Select
        label="Cadence"
        onValueChange={onValueChange}
        options={[
          { label: 'Every day', value: 'daily' },
          { label: 'Every week', value: 'weekly' },
        ]}
        value="daily"
      />,
    );

    fireEvent.click(screen.getByRole('combobox', { name: 'Cadence' }));
    fireEvent.click(screen.getByRole('option', { name: 'Every week' }));
    expect(onValueChange).toHaveBeenCalledWith('weekly');
  });

  it('does not open while disabled', () => {
    render(
      <Select
        disabled
        label="Cadence"
        onValueChange={vi.fn()}
        options={[{ label: 'Every day', value: 'daily' }]}
        value="daily"
      />,
    );

    fireEvent.click(screen.getByRole('combobox', { name: 'Cadence' }));
    expect(screen.queryByRole('option')).toBeNull();
  });
});
