import { act, renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { OPEN_EXPANDED, usePaneExpansion } from './navigation-routes';

describe('pane expansion', () => {
  function paneUnder(state: unknown, initialPane: string | null) {
    return renderHook(({ pane }: { pane: string | null }) => usePaneExpansion(pane), {
      initialProps: { pane: initialPane },
      wrapper: ({ children }) => <MemoryRouter initialEntries={[{ pathname: '/', state, key: 'nav-1' }]}>{children}</MemoryRouter>,
    });
  }

  it('expands the pane a navigation asked for once it opens', () => {
    const hook = paneUnder(OPEN_EXPANDED, null);
    hook.rerender({ pane: 'resource:a' });
    expect(hook.result.current.expanded).toBe(true);
  });

  it('opens the same pane beside when it closes and opens again under one navigation', () => {
    const hook = paneUnder(OPEN_EXPANDED, 'resource:a');
    expect(hook.result.current.expanded).toBe(true);
    hook.rerender({ pane: null });
    hook.rerender({ pane: 'resource:a' });
    expect(hook.result.current.expanded).toBe(false);
    act(() => hook.result.current.setExpanded(true));
    expect(hook.result.current.expanded).toBe(true);
  });
});
