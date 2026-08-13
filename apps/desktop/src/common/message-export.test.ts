import { describe, expect, it } from 'vitest';
import { MESSAGE_EXPORT_FILE_NAME_PATTERN, messageExportFileName } from './message-export';

describe('the file name a saved message is offered under', () => {
  it.each([
    ['## Quarterly pipeline review\n\nTwo things moved.', 'quarterly-pipeline-review-2026-08-13'],
    ['Here is what I found', 'here-is-what-i-found-2026-08-13'],
    // A message that opens on a fence, a table, or a bare bullet has no title
    // line to take; the date still distinguishes one save from the next.
    ['```sql\nselect 1\n```', 'select-1-2026-08-13'],
    ['   \n\n**Northwind** renewal at risk', 'northwind-renewal-at-risk-2026-08-13'],
    ['', 'avalon-message-2026-08-13'],
    ['#### ***', 'avalon-message-2026-08-13'],
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
