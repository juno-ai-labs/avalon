#!/usr/bin/env node
/**
 * Flip every workspace-scoped work stream a caller can see to `personal`, and
 * put it back.
 *
 * A one-off for the release that made new work streams private by default. That
 * change is forward-only by design — it decides what a create *writes* — so the
 * work streams that already existed keep the visibility they were created with.
 * This is the deliberate retroactive pass over them.
 *
 * **Read this before running it.** `personal` is enforced against the
 * participant list, and the rows this touches were never rooms: a work stream
 * created workspace-scoped often has no participant at all, because nothing
 * ever needed to seat one. `PATCH /workstreams/:id` seats *the caller* when it
 * narrows a work stream, which is what stops the operation locking its own
 * author out — so every participant-less work stream this flips ends up
 * readable by whoever ran this script and by nobody else, until somebody adds
 * the people back. That is the accepted cost of the pass, not a bug in it. Run
 * it as somebody who should plausibly hold that access — a workspace owner —
 * and expect to hear from people who lost sight of something.
 *
 * Which is why `--record` is not optional. Every target is written to a file
 * with the scope it held, *before* the first change is attempted, and
 * `--revert` puts them back from that file. Nothing else in Avalon stores a
 * work stream's previous scope; lose the file and the only way back is by hand.
 *
 * It talks to the ordinary product API with an ordinary access token, so it
 * grants itself nothing: it can only see and change what the person whose token
 * it holds could see and change from the app. Work streams whose scope is not
 * what decides who reads them — an automation's, a digest occurrence's — refuse
 * with `scope_change_unsupported` and are counted as left alone, not retried.
 *
 * Usage:
 *   AVALON_ACCESS_TOKEN=... node scripts/backfill-workstream-scope.mjs \
 *     --base-url https://api.with-avalon.com --record ./flip.json          # dry run
 *   AVALON_ACCESS_TOKEN=... node scripts/backfill-workstream-scope.mjs \
 *     --base-url https://api.with-avalon.com --record ./flip.json --apply
 *   AVALON_ACCESS_TOKEN=... node scripts/backfill-workstream-scope.mjs \
 *     --base-url https://api.with-avalon.com --revert ./flip.json
 *
 * Every workspace is its own run, because a token belongs to one member of one
 * workspace. Both regions are their own run too — Global and EU share no
 * identity and no list.
 */

import { readFileSync, writeFileSync } from "node:fs";

import { isEntryPoint } from "./entry-point.mjs";

/** The list endpoint's own maximum, so a sweep costs the fewest round trips. */
export const PAGE_SIZE = 250;

export function parseArguments(argv) {
  const options = { apply: false, baseUrl: null, record: null, revert: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") options.apply = true;
    else if (argument === "--base-url") options.baseUrl = argv[++index] ?? null;
    else if (argument === "--record") options.record = argv[++index] ?? null;
    else if (argument === "--revert") options.revert = argv[++index] ?? null;
    else throw new Error(`Unrecognized argument: ${argument}`);
  }
  if (!options.baseUrl) throw new Error("--base-url is required.");
  // A flip with nowhere to write what it changed is a flip nobody can undo.
  if (!options.revert && !options.record) {
    throw new Error("--record <path> is required; it is the only way back.");
  }
  return options;
}

async function api(context, path, init = {}) {
  const response = await context.fetch(`${context.baseUrl.replace(/\/$/u, "")}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${context.token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: "unparseable_response" };
  }
  return { status: response.status, body };
}

/** Every work stream the token's owner can list. */
export async function listWorkstreams(context) {
  const items = [];
  let cursor = null;
  for (;;) {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE), includeSystem: "true" });
    if (cursor) query.set("before", cursor);
    const { status, body } = await api(context, `/workstreams?${query.toString()}`);
    if (status !== 200) throw new Error(`Listing failed with ${status}`);
    items.push(...body.items);
    if (!body.nextCursor) return items;
    cursor = body.nextCursor;
  }
}

export async function setScope(context, workstreamId, scope) {
  const { status, body } = await api(context, `/workstreams/${workstreamId}`, {
    method: "PATCH",
    body: JSON.stringify({ scope }),
  });
  if (status === 200) return { outcome: "changed" };
  // The families whose scope is not what decides who reads them. Expected, and
  // not a failure of the pass.
  if (body?.error === "scope_change_unsupported") return { outcome: "unsupported" };
  return { outcome: "failed", status, error: body?.error ?? "unknown" };
}

/** The reversal file, built from a listing. Written before anything changes. */
export function buildRecord(context, workstreams) {
  return {
    baseUrl: context.baseUrl,
    recordedAt: context.now(),
    entries: workstreams
      .filter((workstream) => workstream.scope === "workspace")
      .map((workstream) => ({
        workstreamId: workstream.id,
        title: workstream.title,
        priorScope: workstream.scope,
        systemKind: workstream.systemKind ?? null,
        originType: workstream.originType,
      })),
  };
}

async function applyScopes(context, entries, scopeFor) {
  const totals = { changed: 0, unsupported: 0, failed: 0 };
  for (const entry of entries) {
    const result = await setScope(context, entry.workstreamId, scopeFor(entry));
    totals[result.outcome] += 1;
    if (result.outcome === "failed") {
      context.log(`  ${entry.workstreamId} failed (${result.status} ${result.error}): ${entry.title}`);
    }
  }
  return totals;
}

export async function flip(context) {
  const all = await listWorkstreams(context);
  const record = buildRecord(context, all);
  context.log(`${all.length} work streams visible, ${record.entries.length} workspace-scoped.`);
  context.writeRecord(context.record, record);
  context.log(`Recorded ${record.entries.length} entries to ${context.record}.`);
  if (!context.apply) {
    context.log("Dry run: nothing was changed. Re-run with --apply.");
    return { changed: 0, unsupported: 0, failed: 0 };
  }
  return applyScopes(context, record.entries, () => "personal");
}

export async function revert(context) {
  const record = context.readRecord(context.revert);
  context.log(`Reverting ${record.entries.length} entries from ${context.revert}.`);
  return applyScopes(context, record.entries, (entry) => entry.priorScope);
}

export async function run(context) {
  const totals = context.revert ? await revert(context) : await flip(context);
  context.log(
    `Done: ${totals.changed} changed, ${totals.unsupported} left alone `
    + "(their scope is not what decides who reads them), "
    + `${totals.failed} failed.`,
  );
  return totals;
}

if (isEntryPoint(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const token = process.env.AVALON_ACCESS_TOKEN;
    if (!token) throw new Error("AVALON_ACCESS_TOKEN is required.");
    const totals = await run({
      ...options,
      token,
      fetch: globalThis.fetch,
      now: () => new Date().toISOString(),
      log: (line) => process.stdout.write(`${line}\n`),
      readRecord: (path) => JSON.parse(readFileSync(path, "utf8")),
      writeRecord: (path, record) => writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`),
    });
    if (totals.failed > 0) process.exit(1);
  } catch (error) {
    process.stderr.write(`${error.message}\n\nSee the comment at the top of this file for usage.\n`);
    process.exit(2);
  }
}
