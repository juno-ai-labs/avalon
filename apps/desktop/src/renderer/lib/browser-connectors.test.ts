import { expect, it } from 'vitest';
import { browserCanConnect } from './browser-connectors';

it('offers a connection in the browser only when every capability it asks for is listed', () => {
  const allowed = ['drive.read', 'docs.read'];
  expect(browserCanConnect(['drive.read', 'docs.read'], allowed)).toBe(true);
  expect(browserCanConnect(['drive.read', 'sheets.write'], allowed)).toBe(false);
  expect(browserCanConnect([], allowed)).toBe(false);
});
