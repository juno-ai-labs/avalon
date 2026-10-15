import { describe, expect, it } from 'vitest';
import { parseThreadId } from './open-thread';

describe('parseThreadId', () => {
  it('takes a Thread id and nothing else', () => {
    const threadId = '0191c0de-0000-7000-8000-00000000cafe';
    expect(parseThreadId(threadId)).toBe(threadId);
    for (const rejected of [
      '', 'new', 'not-a-uuid', 42, null, undefined, {},
      `${threadId}/../settings`, `${threadId}?invite=1`, `${threadId}\n`, `${threadId}#x`,
    ]) {
      expect(parseThreadId(rejected)).toBeNull();
    }
  });
});
