import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PERSONAL_ACCENT_PROPERTY, usePersonalAccent } from './personal-accent';
import type { PersonalPresentation } from '@rally/contracts';

function Accented({ color }: { color?: PersonalPresentation['color'] }): React.JSX.Element {
  usePersonalAccent(color);
  return <span />;
}

const published = (): string => document.documentElement.style.getPropertyValue(PERSONAL_ACCENT_PROPERTY);

describe('the signed-in person’s accent', () => {
  it('publishes the palette fill their presentation names', () => {
    const view = render(<Accented color="blue" />);
    expect(published()).toBe('var(--av-sys-color-project-blue)');
    view.unmount();
  });

  it('follows a retired accent name to the fill that replaced it', () => {
    // A stored presentation is read back on every session, so `green` — retired
    // when the eight-accent set landed — still has to paint something.
    const view = render(<Accented color="green" />);
    expect(published()).toBe('var(--av-sys-color-project-emerald)');
    view.unmount();
  });

  it('republishes when the person changes their colour', () => {
    const view = render(<Accented color="blue" />);
    view.rerender(<Accented color="fuchsia" />);
    expect(published()).toBe('var(--av-sys-color-project-fuchsia)');
    view.unmount();
  });

  // The stylesheet's own default is what a surface gets when the property is
  // absent, so an unpublished accent has to leave nothing behind rather than
  // hold the last person's colour: a signed-out shell, or a second workspace
  // whose directory has not arrived yet, would otherwise keep painting in it.
  it('leaves nothing published for a person with no presentation', () => {
    const view = render(<Accented />);
    expect(published()).toBe('');
    view.unmount();
  });

  it('clears the property when the shell unmounts', () => {
    render(<Accented color="lime" />).unmount();
    expect(published()).toBe('');
  });
});
