import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';

import { ComposerAgentActivity } from './composer-agent-activity';

afterEach(cleanup);

it('keeps a live region mounted and changes its accessible text as work starts, changes and ends', () => {
  const { rerender } = render(<ComposerAgentActivity activity={undefined} />);
  const status = screen.getByRole('status');
  expect(status).toBeEmptyDOMElement();
  rerender(<ComposerAgentActivity activity={{ backgroundAgents: 2, sidekicks: 1 }} />);
  expect(screen.getByRole('status')).toBe(status);
  expect(status.textContent).toBe('2 background agents running · 1 Sidekick running');
  expect(status.closest('[aria-hidden="true"]')).toBeNull();
  rerender(<ComposerAgentActivity activity={{ backgroundAgents: 1, sidekicks: 2 }} />);
  expect(status.textContent).toBe('1 background agent running · 2 Sidekicks running');
  rerender(<ComposerAgentActivity activity={{ backgroundAgents: 0, sidekicks: 0 }} />);
  expect(screen.getByRole('status')).toBe(status);
  expect(status).toBeEmptyDOMElement();
});
