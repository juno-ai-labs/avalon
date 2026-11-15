import { expect, it } from 'vitest';
import { acceptFreshAccess } from './canonical-first';

const canonicalUrl = 'https://reader.rallyusercontent.com/';
const onCookie = { canvasId: 'c', resourceId: 'r', version: 2, openUrl: canonicalUrl, canonicalUrl };
const fresh = { ...onCookie, openUrl: `${canonicalUrl}__rally/open#code` };

it('keeps a site already open on its cookie when Home delivers the same site', () => {
  expect(acceptFreshAccess(onCookie, fresh, false)).toBe(onCookie);
  expect(acceptFreshAccess(onCookie, { ...fresh, version: 3 }, false)).toEqual({ ...onCookie, version: 3 });
});

it('takes fresh access for a renewal, another artifact, or a view not on its cookie', () => {
  expect(acceptFreshAccess(onCookie, fresh, true)).toBe(fresh);
  expect(acceptFreshAccess(onCookie, { ...fresh, resourceId: 'other', canonicalUrl: 'https://other.rallyusercontent.com/' }, false).resourceId).toBe('other');
  expect(acceptFreshAccess(undefined, fresh, false)).toBe(fresh);
  expect(acceptFreshAccess({ ...onCookie, openUrl: fresh.openUrl }, fresh, false)).toBe(fresh);
});
