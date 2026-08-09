import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const workflowPath = join(repositoryDirectory, '.github/workflows/release-desktop-macos.yml');

test('desktop releases share one non-canceling newest-pending queue', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const concurrency = workflow.match(/^concurrency:\n(?<body>(?:^(?: {2}|$).*\n)+)/mu)?.groups?.body;

  assert.ok(concurrency, 'Release workflow must define workflow-level concurrency');
  assert.match(concurrency, /^ {2}group: desktop-macos-release$/mu);
  assert.match(concurrency, /^ {2}cancel-in-progress: false$/mu);
  assert.match(concurrency, /^ {2}queue: single$/mu);
  assert.doesNotMatch(concurrency, /github\.|inputs\.|ref_name/u);
});

test('the macOS runner is only claimed once the plan job has approved a release', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  assert.match(workflow, /^ {2}release:\n {4}needs: plan\n {4}if: needs\.plan\.outputs\.should_release == 'true'$/mu);
});

test('the app is health-gated against the regional APIs before it is distributed', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const healthGate = workflow.indexOf('scripts/check-regional-health.mjs');
  const published = workflow.indexOf('- name: Publish immutable payloads and promote the release manifest');

  // Ordering between the API and desktop workflows is not coordinated between
  // runners. This gate, not a wait, is what keeps a release from shipping
  // against unhealthy regions.
  assert.notEqual(healthGate, -1, 'Release workflow must check regional health');
  assert.ok(healthGate < published, 'Regional health must be checked before anything is published');
});

test('tag pushes are never filtered by path', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const trigger = workflow.match(/^on:\n(?<body>(?:^(?: {2}|$).*\n)+)/mu)?.groups?.body;

  // GitHub leaves it undefined whether a paths filter also applies to tag
  // pushes, so a manual `v*` tag must not depend on that behavior.
  assert.ok(trigger, 'Release workflow must define triggers');
  assert.doesNotMatch(trigger, /^\s*paths:/mu);
});

test('the release tag is pushed only after the payloads and channel are published', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const stepIndex = (name) => workflow.indexOf(`- name: ${name}`);

  const createdLocally = stepIndex('Create the release tag locally');
  const published = stepIndex('Publish immutable payloads and promote the release manifest');
  const site = stepIndex('Deploy the landing site with the verified release');
  const pushedTag = stepIndex('Publish the release tag');

  for (const [name, index] of Object.entries({ createdLocally, published, site, pushedTag })) {
    assert.notEqual(index, -1, `Release workflow must keep the ${name} step`);
  }
  // Every tag released by hand is annotated; automation must not start mixing
  // in lightweight ones.
  assert.match(workflow, /tag -a "\$RELEASE_TAG"/u);
  // A failed release must leave no tag behind, so the version can be retried.
  assert.ok(createdLocally < published, 'The local tag must exist before the release guards run');
  assert.ok(published < pushedTag, 'The tag must not be pushed before the payloads are published');
  assert.ok(site < pushedTag, 'The tag must not be pushed before the channel is live');
});

test('the release job can write the tag it publishes', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const releaseJob = workflow.slice(workflow.indexOf('\n  release:'));

  assert.match(releaseJob, /^ {4}permissions:\n {6}contents: write$/mu);
});
