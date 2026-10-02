#!/usr/bin/env node
/**
 * Catches Markdown headings that a merge or rebase truncated into body text.
 *
 * This exists because it already happened. Rebasing the theme branch onto a
 * `main` that had moved 124 commits ahead ate the `### 2026-0` from the front of
 * eight changelog headings across two documents, leaving lines like
 *
 *     8-13 — A saved message is rendered outside the application's origin
 *
 * One of them was not even the branch's own entry. Nothing failed: the file is
 * still valid Markdown, the text is still there, and the only symptom is that
 * the entry stops being a heading — it disappears from the outline and its body
 * is swallowed into the entry above. `docs/module-documents.md` makes the
 * changelog the one non-negotiable section of a module document, so a heading
 * that quietly stops being one is worth a build failure.
 *
 * The check is deliberately narrow. It looks for the *shape* a truncated
 * heading leaves behind rather than trying to validate headings in general,
 * because a general rule would fight every document that has a good reason to
 * be unusual.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isEntryPoint } from './entry-point.mjs';

/**
 * A line that begins with something date-like and then an em dash, but is not a
 * heading. Every changelog entry in `docs/` is `### <ISO date> — <title>`, so a
 * line carrying the second half of that shape without the first is the residue
 * of a truncated one.
 *
 * The year is optional in the pattern: the observed damage ate into it (`2026-0`
 * went missing, leaving `8-13`), and a different conflict could plausibly stop
 * anywhere in the prefix.
 */
const TRUNCATED_HEADING = /^(?:\d{4}-)?\d{1,2}-\d{1,2}\s+—\s+\S/u;

/** A fenced code block may legitimately contain anything, including this. */
const FENCE = /^\s*(?:```|~~~)/u;

export function truncatedHeadings(text) {
  const found = [];
  let fenced = false;
  text.split('\n').forEach((line, index) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      return;
    }
    if (!fenced && TRUNCATED_HEADING.test(line)) {
      found.push({ line: index + 1, text: line });
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

async function check(directory) {
  const problems = [];
  for (const file of await markdownFiles(directory)) {
    for (const found of truncatedHeadings(await readFile(file, 'utf8'))) {
      problems.push({ file, ...found });
    }
  }
  return problems;
}

if (isEntryPoint(import.meta.url)) {
  const problems = await check('docs');
  for (const problem of problems) {
    process.stderr.write(
      `${problem.file}:${problem.line} looks like a heading that lost its "### <date>" prefix:\n`
      + `  ${problem.text}\n`,
    );
  }
  if (problems.length > 0) {
    process.stderr.write(
      `\n${problems.length} heading(s) demoted to body text. A rebase usually did this; `
      + 'restore the "### YYYY-MM-DD — " prefix.\n',
    );
    process.exit(1);
  }
  process.stdout.write('No truncated headings in docs/.\n');
}
