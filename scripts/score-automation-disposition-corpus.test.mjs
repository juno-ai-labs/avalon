import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatReport, scoreCorpus } from './score-automation-disposition-corpus.mjs';

const corpus = [
  {
    id: 'mattered', expected: 'deliver', reach: { canDeliver: true, canExpose: true },
    why: 'A named person asked a question somebody has to answer.',
  },
  {
    id: 'repetitive', expected: 'done', reach: { canDeliver: true, canExpose: true },
    why: 'Identical in substance to the last three occurrences.',
  },
];

function scoreWith(answers) {
  return scoreCorpus({
    corpus,
    render: (entry) => [{ role: 'user', content: entry.id }],
    schemaFor: () => ({}),
    call: async ({ id }) => answers[id],
  });
}

describe('scoring the disposition corpus', () => {
  it('counts a swallowed result apart from a noisy one', async () => {
    // The two failures are not interchangeable. A missed delivery is invisible
    // — nobody looks for a result that never came — while a spurious exposure
    // is a row somebody ignores. One number would let a release trade the
    // first for the second without anybody seeing which way it went.
    const report = await scoreWith({ mattered: 'done', repetitive: 'expose_workstream' });

    assert.equal(report.passed, 0);
    assert.equal(report.swallowed, 1);
    assert.equal(report.sidebarNoise, 1);
  });

  it('reports what each failing case says, not just that it failed', async () => {
    const report = await scoreWith({ mattered: 'done', repetitive: 'done' });
    const text = formatReport(report);

    // When a case fails, the question is whether the model drifted or the case
    // was wrong. The reasoning has to be in front of whoever is deciding.
    assert.match(text, /mattered: expected deliver, got done/u);
    assert.match(text, /A named person asked a question/u);
    assert.match(text, /invisible failure/u);
  });

  it('says nothing about failures it did not have', async () => {
    const report = await scoreWith({ mattered: 'deliver', repetitive: 'done' });
    const text = formatReport(report);

    assert.equal(report.passed, 2);
    assert.match(text, /2\/2 cases matched/u);
    assert.doesNotMatch(text, /invisible failure/u);
    assert.doesNotMatch(text, /sidebar/u);
  });
});
