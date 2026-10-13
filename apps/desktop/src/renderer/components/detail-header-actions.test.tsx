import { render, screen } from '@testing-library/react';
import type { IconGroupAction } from '@rally/ui/components/icon-group';
import React from 'react';
import { describe, expect, it } from 'vitest';

import { DetailHeaderActionsHost, useDetailHeaderActions } from './detail-header-actions';

function Detail({ label }: { label: string }): React.JSX.Element {
  const actions = React.useMemo((): IconGroupAction[] => [{ key: 'pop', label, icon: null, onSelect: () => undefined }], [label]);
  useDetailHeaderActions(actions);
  return <p>body</p>;
}

function Host({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [actions, setActions] = React.useState<readonly IconGroupAction[]>([]);
  return (
    <>
      <output data-testid="header">{actions.map((action) => action.label).join(',')}</output>
      <DetailHeaderActionsHost onActions={setActions}>{children}</DetailHeaderActionsHost>
    </>
  );
}

describe('a detail contributing actions to its host header', () => {
  it('hands them to the host, and hands over new ones when they change', () => {
    const { rerender } = render(<Host><Detail label="Pop out" /></Host>);
    expect(screen.getByTestId('header')).toHaveTextContent('Pop out');

    rerender(<Host><Detail label="Copied" /></Host>);
    expect(screen.getByTestId('header')).toHaveTextContent('Copied');
  });

  it('takes them back when the detail goes', () => {
    // Otherwise the next resource opened in the panel shows the last one's buttons.
    const { rerender } = render(<Host><Detail label="Pop out" /></Host>);
    rerender(<Host>{null}</Host>);

    expect(screen.getByTestId('header')).toBeEmptyDOMElement();
  });

  it('declares to nobody where no host listens', () => {
    render(<Detail label="Pop out" />);

    expect(screen.getByText('body')).toBeInTheDocument();
  });
});
