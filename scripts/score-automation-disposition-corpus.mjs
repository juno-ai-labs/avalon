/**
 * Score the automation-result disposition classifier against its fixed corpus.
 *
 * This classifier is the only thing standing between every automation in the
 * fleet and every destination it has, so this is a release gate: a regression
 * here is silent in exactly the direction nobody checks. Nothing about a
 * disposition raises an error, retries, or shows up in a dead-letter queue — a
 * result judged `done` simply never arrives, and the person waiting for it has
 * no way to know it existed.
 *
 * Not a unit test, because scoring it means calling a real model. Run it
 * against the model a release is about to ship:
 *
 *   OPENROUTER_API_KEY=… OPENROUTER_STRUCTURED_MODEL=… \
 *     node scripts/score-automation-disposition-corpus.mjs
 *
 * The corpus itself, and the reasoning behind every case, is
 * `packages/agent-harness/src/prompts/automation-result-disposition-corpus.ts`.
 * When a case fails, read its `why` before changing anything: the question is
 * always whether the model drifted or the case was wrong.
 */

import { isEntryPoint } from './entry-point.mjs';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * The two failures worth naming separately in the report.
 *
 * A missed delivery is invisible: nobody looks for a result that never came.
 * A spurious exposure is loud but cheap — a row somebody ignores. Reporting
 * them as one number would let a release trade the first for the second
 * without anybody noticing which way it went.
 */
function classifyMiss(expected, actual) {
  if (expected !== 'done' && actual === 'done') return 'swallowed';
  if (expected === 'done' && actual === 'expose_workstream') return 'sidebar_noise';
  return 'other';
}

export async function scoreCorpus({ corpus, render, schemaFor, call }) {
  const results = [];
  for (const entry of corpus) {
    const messages = render(entry);
    const actual = await call({
      messages,
      schema: schemaFor(entry.reach),
      id: entry.id,
    });
    results.push({
      id: entry.id,
      expected: entry.expected,
      actual,
      passed: actual === entry.expected,
      ...(actual === entry.expected ? {} : { miss: classifyMiss(entry.expected, actual) }),
      why: entry.why,
    });
  }
  const failures = results.filter((result) => !result.passed);
  return {
    total: results.length,
    passed: results.length - failures.length,
    swallowed: failures.filter((failure) => failure.miss === 'swallowed').length,
    sidebarNoise: failures.filter((failure) => failure.miss === 'sidebar_noise').length,
    results,
  };
}

export function formatReport(report) {
  const lines = [`${report.passed}/${report.total} cases matched the expected disposition.`];
  if (report.swallowed > 0) {
    lines.push(
      `${report.swallowed} result${report.swallowed === 1 ? '' : 's'} that mattered were judged done.`
      + ' This is the invisible failure: nobody looks for a result that never arrived.',
    );
  }
  if (report.sidebarNoise > 0) {
    lines.push(
      `${report.sidebarNoise} repetitive result${report.sidebarNoise === 1 ? ' was' : 's were'} exposed.`
      + ' This fills a sidebar with rooms nobody opens.',
    );
  }
  for (const result of report.results) {
    if (result.passed) continue;
    lines.push(`  ${result.id}: expected ${result.expected}, got ${result.actual}`);
    lines.push(`    the case says: ${result.why}`);
  }
  return lines.join('\n');
}

async function callOpenRouter({ messages, schema }, { apiKey, model }) {
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'automation_result_disposition', strict: true, schema },
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter answered ${response.status}: ${(await response.text()).slice(0, 400)}`);
  }
  const body = await response.json();
  return JSON.parse(body.choices?.[0]?.message?.content ?? '{}').disposition;
}

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  const model = process.env.OPENROUTER_STRUCTURED_MODEL?.trim();
  if (!apiKey || !model) {
    throw new Error('OPENROUTER_API_KEY and OPENROUTER_STRUCTURED_MODEL are required to score the corpus');
  }
  const harness = await import('../packages/agent-harness/src/prompts/automation-result-disposition.ts');
  const { AUTOMATION_DISPOSITION_CORPUS } = await import(
    '../packages/agent-harness/src/prompts/automation-result-disposition-corpus.ts'
  );
  const report = await scoreCorpus({
    corpus: AUTOMATION_DISPOSITION_CORPUS,
    render: (entry) => harness.renderAutomationResultDispositionMessages(entry),
    schemaFor: (reach) => harness.automationResultDispositionJsonSchema(reach),
    call: (request) => callOpenRouter(request, { apiKey, model }),
  });
  process.stdout.write(`${formatReport(report)}\n`);
  // A release gate that exits zero on a regression is a report, not a gate.
  if (report.passed !== report.total) process.exitCode = 1;
}

if (isEntryPoint(import.meta.url)) {
  await main();
}
