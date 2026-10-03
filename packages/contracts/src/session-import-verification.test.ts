import { describe, expect, it } from 'vitest';
import { DesktopActionSchema, SessionImportVerificationSchema, verifySessionImport } from './desktop-actions';

const messages = [
  { role: 'user', sourceMessageId: 'edit-selected', files: [{ unavailable: { name: 'upload.pdf', reason: 'Expired' } }] },
  { role: 'assistant', sourceMessageId: 'reply-text' },
  { role: 'assistant', sourceMessageId: 'reply-document', files: [{ handle: 'document' }] },
];
const evidence = {
  checks: [{ name: "page content", passed: true, basis: "Compared every displayed turn." }],
  branch: { complete: true as const, basis: 'Selected edited branch reaches its explicit root; older sibling excluded.' },
  page: { messageCount: 3, firstSourceMessageId: 'edit-selected', lastSourceMessageId: 'reply-document',
    sampledSourceMessageIds: ['reply-text', 'reply-document'], basis: 'Two rendered turns account for three source messages; expanded document compared.' },
  fileCount: 2,
};

describe('layout-independent import verification', () => {
  it('accepts grouped replies and explicitly unavailable files', () => {
    expect(() => verifySessionImport(messages, SessionImportVerificationSchema.parse(evidence))).not.toThrow();
  });
  it('requires completed branch and actual comparison evidence in finish actions', () => {
    const action = { kind: 'session_import.finish', title: 'Chat', messages: 'handle' };
    expect(DesktopActionSchema.safeParse(action).success).toBe(false);
    expect(DesktopActionSchema.safeParse({ ...action, verification: { ...evidence, branch: { ...evidence.branch, complete: false } } }).success).toBe(false);
    expect(SessionImportVerificationSchema.safeParse({ ...evidence, page: { ...evidence.page, sampledSourceMessageIds: [] } }).success).toBe(false);
  });
  it.each([
    ['messageCount', { ...evidence.page, messageCount: 2 }],
    ['firstSourceMessageId', { ...evidence.page, firstSourceMessageId: 'old-edit' }],
    ['lastSourceMessageId', { ...evidence.page, lastSourceMessageId: 'old-regeneration' }],
    ['sampledSourceMessageIds', { ...evidence.page, sampledSourceMessageIds: ['edit-selected'] }],
    ['sampledSourceMessageIds', { ...evidence.page, sampledSourceMessageIds: ['reply-text', 'reply-text'] }],
  ])('names the rejected %s when report and stored history disagree', (field, page) => {
    expect(() => verifySessionImport(messages, { ...evidence, page })).toThrow(`verification.page.${field}`);
  });
  it('refuses a failed text comparison even when the narrative claims completeness', () => {
    expect(() => verifySessionImport(messages, { ...evidence, checks: [{ name: 'user text', passed: false, basis: 'Full text did not match the page.' }] }))
      .toThrow('verification.checks[0].passed');
    expect(SessionImportVerificationSchema.safeParse({ ...evidence, checks: [] }).success).toBe(false);
  });
  it('refuses missing file accounting', () => {
    expect(() => verifySessionImport(messages, { ...evidence, fileCount: 1 })).toThrow('verification.fileCount');
  });
});
