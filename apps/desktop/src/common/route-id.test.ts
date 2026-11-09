import { describe, expect, it } from 'vitest';
import { parseRouteId } from './route-id';

describe('parseRouteId', () => {
  it('takes an id and nothing else', () => {
    const threadId = '0191c0de-0000-7000-8000-00000000cafe';
    expect(parseRouteId(threadId)).toBe(threadId);
    for (const rejected of [
      '', 'new', 'not-a-uuid', 42, null, undefined, {},
      `${threadId}/../settings`, `${threadId}?invite=1`, `${threadId}\n`, `${threadId}#x`,
    ]) {
      expect(parseRouteId(rejected)).toBeNull();
    }
  });
});
