import { describe, expect, it, vi } from 'vitest';
import { MESSAGE_EXPORT_FILE_NAME_PATTERN, messageExportDate, messageExportFileName } from './message-export';

describe('the date a save is filed under', () => {
  it("uses the person's own calendar rather than UTC", () => {
    // 21:30 on the 13th in Los Angeles is already the 14th in UTC. Filing an
    // evening's saves under tomorrow is the bug this exists to prevent.
    vi.stubEnv('TZ', 'America/Los_Angeles');

    expect(messageExportDate(new Date('2026-08-14T04:30:00Z'))).toBe('2026-08-13');
  });

  it('pads a single-digit month and day', () => {
    vi.stubEnv('TZ', 'UTC');

    expect(messageExportDate(new Date('2026-01-05T12:00:00Z'))).toBe('2026-01-05');
  });
});

describe('the file name a saved message is offered under', () => {
  it.each([
    ['## Quarterly pipeline review\n\nTwo things moved.', 'quarterly-pipeline-review-2026-08-13'],
    ['Here is what I found', 'here-is-what-i-found-2026-08-13'],
    // A fence's opening line is a language, not a title, so the name comes from
    // the first line inside the block rather than from `sql`.
    ['```sql\nselect 1\n```', 'select-1-2026-08-13'],
    ['   \n\n**Northwind** renewal at risk', 'northwind-renewal-at-risk-2026-08-13'],
    ['', 'rally-message-2026-08-13'],
    ['#### ***', 'rally-message-2026-08-13'],
  ])('turns %j into %s', (text, expected) => {
    expect(messageExportFileName(text, '2026-08-13')).toBe(expected);
  });

  it('never proposes a name the main process would reject', () => {
    const awkward = [
      'C:\\Windows\\system32 — or ../../etc/passwd?',
      '🚀 shipped!',
      'a'.repeat(400),
      'Ünicode heading',
      '/etc/passwd',
    ];

    for (const text of awkward) {
      expect(messageExportFileName(text, '2026-08-13')).toMatch(MESSAGE_EXPORT_FILE_NAME_PATTERN);
    }
  });
});
