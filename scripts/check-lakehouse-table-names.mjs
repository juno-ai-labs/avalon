#!/usr/bin/env node
/**
 * Keeps the lakehouse table names in `docs/` equal to the ones in `config/`.
 *
 * This exists because it already happened. `docs/runbook.md` carried the
 * recipe for reading a run's raw inference out of R2 SQL, and its three
 * queries all said `FROM rally.llm_inference`. The Data Catalog namespace is
 * `avalon` — the product was renamed, a sweep took the namespace with it, and
 * the analytics recipe a few hundred lines further down was left correct,
 * which is what made the difference invisible on a read.
 *
 * The cost of the mistake is entirely in when it surfaces. The runbook is
 * followed during an incident, by someone who has just been handed a
 * work-stream URL and a question; the query fails on a name, at the one moment
 * nobody has spare attention for a doc bug. Nothing else in the tree can catch
 * it: the manifests are the deployment's source of truth and the documents are
 * prose, and until now the only thing joining them was whoever wrote both.
 *
 * The check is narrow on purpose. It knows the table names the manifests
 * declare and asserts only that every mention of one in `docs/` is qualified,
 * and qualified correctly. It has no opinion about SQL in general.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isEntryPoint } from './entry-point.mjs';

/** A lakehouse manifest is any `config/*.json` declaring a namespace/table pair. */
export async function lakehouseTables(directory = 'config') {
  const tables = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const manifest = JSON.parse(await readFile(join(directory, entry.name), 'utf8'));
    if (typeof manifest.namespace !== 'string' || typeof manifest.table !== 'string') continue;
    tables.push({
      manifest: join(directory, entry.name),
      namespace: manifest.namespace,
      table: manifest.table,
    });
  }
  return tables.sort((left, right) => left.table.localeCompare(right.table));
}

/**
 * Every mention of `table` in `text` that is not `namespace.table`.
 *
 * A mention is either qualified by some other namespace or left bare after a
 * `FROM`/`JOIN`. A bare name outside a query — the manifest's own `"table":
 * "llm_inference"`, or prose naming the table — is not a query anyone will run
 * and is left alone.
 */
export function misqualifiedReferences(text, { namespace, table }) {
  const pattern = new RegExp(
    `(?:\\b(?<qualifier>[A-Za-z_][A-Za-z0-9_]*)\\.${table}\\b)`
    + `|(?:\\b(?:FROM|JOIN)\\s+(?<bare>${table})\\b)`,
    'giu',
  );
  const found = [];
  text.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(pattern)) {
      const qualifier = match.groups?.qualifier;
      if (qualifier === namespace) continue;
      found.push({
        line: index + 1,
        text: line.trim(),
        found: qualifier ? `${qualifier}.${table}` : table,
        expected: `${namespace}.${table}`,
      });
    }
  });
  return found;
}

export async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(path));
    else if (entry.name.endsWith('.md')) files.push(path);
  }
  return files.sort();
}

export async function check(directory = 'docs', configDirectory = 'config') {
  const tables = await lakehouseTables(configDirectory);
  const problems = [];
  for (const file of await markdownFiles(directory)) {
    const text = await readFile(file, 'utf8');
    for (const table of tables) {
      for (const found of misqualifiedReferences(text, table)) {
        problems.push({ file, ...found, manifest: table.manifest });
      }
    }
  }
  return problems;
}

if (isEntryPoint(import.meta.url)) {
  const problems = await check();
  for (const problem of problems) {
    process.stderr.write(
      `${problem.file}:${problem.line} queries ${problem.found}, `
      + `but ${problem.manifest} declares ${problem.expected}:\n  ${problem.text}\n`,
    );
  }
  if (problems.length > 0) {
    process.stderr.write(
      `\n${problems.length} lakehouse table reference(s) name a table that does not exist. `
      + 'The manifests in config/ own these names.\n',
    );
    process.exit(1);
  }
  process.stdout.write('Every lakehouse table reference in docs/ matches its manifest.\n');
}
