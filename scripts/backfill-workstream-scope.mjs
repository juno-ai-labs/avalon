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
 * **It preserves who can read what.** `personal` is enforced against the
 * participant list, so narrowing a work stream whose room is smaller than the
 * workspace takes it away from everyone outside that room. Every work stream
 * the pass touches therefore has all active members seated into it first, which
 * turns implicit workspace-wide access into an explicit room holding the same
 * people. What changes is that members who join *later* are not included —
 * which is what being private means.
 *
 * That is blunt on purpose. A work stream born from a private Slack channel is
 * workspace-scoped only because of the bug this release fixed, and its
 * participants are already the right room; seating the whole workspace into it
 * widens rather than corrects it, and undoing that means removing participants
 * rather than narrowing scope again. The two cannot be told apart from the
 * product API, so the trade is deliberate: nobody loses access, and the leaked
 * set is corrected by hand.
 *
 * Which is why `--record` is not optional. Every target is written to a file
 * with the scope it held, *before* the first change is attempted, and
 * `--revert` puts them back from that file. Nothing else in Avalon stores a
 * work stream's previous scope; lose the file and the only way back is by hand.
 *
 * **It does not reach archived work streams.** `GET /workstreams` is the only
 * enumeration a token has, and the directory query behind it filters
 * `archived_at IS NULL`, so an archived work stream keeps whatever scope it
 * holds. That is a real gap rather than a safe omission: `PATCH
 * /workstreams/:id` authorizes archived rows and can unarchive one, at which
 * point a work stream this pass never saw returns workspace-readable. Closing
 * it needs an enumeration that includes archived rows, which is a change to a
 * product API rather than something a script can work around. Until then, a
 * work stream unarchived after this pass has to be narrowed by hand.
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

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import { isEntryPoint } from "./entry-point.mjs";

/**
 * Stop rather than grind through a whole list that cannot succeed.
 *
 * An expired token fails every remaining row, one useless request each. A run
 * of failures this long is a broken precondition, not bad luck, and stopping
 * leaves the operator a short log and a record they can resume from.
 */
export const CONSECUTIVE_FAILURE_LIMIT = 5;

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
  // `--record` names the file a flip writes. A revert reads its own file and
  // writes none, so passing both is a misunderstanding worth naming rather than
  // an argument to ignore.
  if (options.revert && options.record) {
    throw new Error("--record belongs to a flip; a revert reads the file named by --revert.");
  }
  // A flip with nowhere to write what it changed is a flip nobody can undo.
  if (!options.revert && !options.record) {
    throw new Error("--record <path> is required; it is the only way back.");
  }
  return options;
}

/**
 * One request, with every failure turned into a status rather than a throw.
 *
 * A sweep is a long line of independent changes, and a DNS hiccup on the
 * four-hundredth is not a reason to abandon the other four hundred. A thrown
 * error would leave the operator with a stack trace and no count of what had
 * already succeeded; `status: 0` flows into the same per-row `failed` tally as
 * a refusal, and the run carries on and reports at the end.
 */
async function api(context, path, init = {}) {
  let response;
  try {
    response = await context.fetch(`${context.baseUrl.replace(/\/$/u, "")}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${context.token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
  } catch (error) {
    return { status: 0, body: { error: error instanceof Error ? error.message : "network_error" } };
  }
  let text;
  try {
    text = await response.text();
  } catch (error) {
    return { status: 0, body: { error: error instanceof Error ? error.message : "body_read_failed" } };
  }
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // A gateway's HTML error page is the usual cause, and the first line of it
    // is what tells an operator which gateway.
    body = { error: "unparseable_response", responseText: text.slice(0, 200) };
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
    if (status !== 200) {
      throw new Error(
        `Listing failed with ${status} at cursor ${cursor ?? "start"}`
        + `${body?.error ? ` (${body.error})` : ""}`,
      );
    }
    items.push(...body.items);
    if (!body.nextCursor) return items;
    cursor = body.nextCursor;
  }
}

/** The workspace's active members, as the token's owner can see them. */
export async function listActiveMembers(context) {
  const { status, body } = await api(context, "/workspace/members");
  if (status !== 200) throw new Error(`Member listing failed with ${status}`);
  return body.items
    .filter((member) => member.status === "active")
    .map((member) => member.user.id);
}

/** Who is in the room today. Empty is the case this script exists to handle. */
export async function activeParticipants(context, workstreamId) {
  const { status, body } = await api(context, `/workstreams/${workstreamId}`);
  if (status !== 200) throw new Error(`Detail read failed with ${status}`);
  return body.participants.map((participant) => participant.user.id);
}

export async function addParticipant(context, workstreamId, userId) {
  const { status } = await api(context, `/workstreams/${workstreamId}/participants`, {
    method: "POST",
    body: JSON.stringify({ userId }),
  });
  return status === 200 || status === 201;
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

/**
 * True for a work stream the object will refuse to re-scope.
 *
 * `update()` throws `scope_change_unsupported` when `system_kind` or
 * `automation_subscription_id` is set, and the listing already carries both —
 * so this is knowable up front rather than after a wasted round trip. Leaving
 * them in inflated the one number the runbook tells an operator to read as the
 * blast radius, and had `--revert` re-attempt rows it could never change.
 */
export function refusesScopeChange(workstream) {
  return (workstream.systemKind ?? null) !== null
    || (workstream.automationSubscriptionId ?? null) !== null;
}

/** The reversal file, built from a listing. Written before anything changes. */
export function buildRecord(context, workstreams) {
  return {
    baseUrl: context.baseUrl,
    recordedAt: context.now(),
    entries: workstreams
      .filter((workstream) => workstream.scope === "workspace" && !refusesScopeChange(workstream))
      .map((workstream) => ({
        workstreamId: workstream.id,
        title: workstream.title,
        priorScope: workstream.scope,
        systemKind: workstream.systemKind ?? null,
        // Recorded so the file can tell an automation's work stream apart after
        // the fact, which the scope alone cannot.
        automationSubscriptionId: workstream.automationSubscriptionId ?? null,
        originType: workstream.originType,
      })),
  };
}

/**
 * Narrow one work stream, seating the whole workspace into it first.
 *
 * This is what keeps the pass from taking access away, and it applies to every
 * work stream it touches rather than only the ones with an empty room. The
 * distinction that used to be here — seat an empty room, leave a populated one
 * alone — turned out to describe almost nothing: `initialize()` builds its
 * member list as `[creatorUserId, ...participantUserIds]`, so every work stream
 * created through the object path already has a participant. The real
 * population is a work stream whose room is one person, its creator, and
 * narrowing that to a room of one takes it away from everyone else who can read
 * it today. Seating every active member first turns implicit workspace-wide
 * access into an explicit room holding the same people; the only thing that
 * changes is that members who join *later* are not included, which is what
 * being private means.
 *
 * **This is blunt on purpose, and it has a cost.** A work stream born from a
 * private Slack channel is workspace-scoped only because of the bug this
 * release fixed, and its participants are already the right room — that
 * channel's members. Seating the whole workspace into it cements the wider
 * audience rather than correcting it, and undoing that afterwards means
 * removing participants rather than just narrowing scope again. The two cannot
 * be told apart from the product API (both are `ad_hoc` with a populated room),
 * so this is a deliberate trade rather than an oversight: no one loses access,
 * and the leaked set is handled by hand.
 *
 * Members already in the room are skipped rather than re-posted, so `seated`
 * counts people actually added. Seating happens before the narrowing, so the
 * work stream is never private with a smaller room than it started with, not
 * even between two requests.
 */
async function narrow(context, entry) {
  const seated = [];
  if (context.membersToSeat) {
    const already = new Set(await activeParticipants(context, entry.workstreamId));
    for (const userId of context.membersToSeat) {
      if (already.has(userId)) continue;
      if (await addParticipant(context, entry.workstreamId, userId)) seated.push(userId);
    }
  }
  const result = await setScope(context, entry.workstreamId, "personal");
  return { ...result, seated };
}

export async function flip(context) {
  // **The entry list is built once and never rebuilt.** Rebuilding it on a
  // second run is how the rollback file destroys itself: a retry after an
  // interrupted apply re-lists, and the work streams already flipped are now
  // `personal`, so `buildRecord` drops them and the file loses the only copy of
  // the scope they used to hold. Re-running after a *completed* apply would
  // empty it outright, and pointing two workspaces at one path would have the
  // second erase the first. So an existing record is read and used as the plan,
  // never regenerated over.
  const existing = context.recordExists(context.record)
    ? context.readRecord(context.record)
    : null;
  if (existing && existing.baseUrl !== context.baseUrl) {
    throw new Error(
      `${context.record} was recorded against ${existing.baseUrl}, not ${context.baseUrl}. `
      + "Use its own base URL, or a different record path.",
    );
  }
  let record = existing;
  if (record) {
    context.log(`Resuming from ${context.record}: ${record.entries.length} entries already recorded.`);
  } else {
    const all = await listWorkstreams(context);
    record = buildRecord(context, all);
    context.log(`${all.length} work streams visible, ${record.entries.length} workspace-scoped.`);
    // Written before the first change, so an interrupted run is still
    // reversible for everything it had already decided to touch.
    context.writeRecord(context.record, record);
    context.log(`Recorded ${record.entries.length} entries to ${context.record}.`);
  }
  if (!context.apply) {
    context.log("Dry run: nothing was changed. Re-run with --apply.");
    return { changed: 0, unsupported: 0, failed: 0, seated: 0 };
  }

  const members = await listActiveMembers(context);
  context.log(`${members.length} active members will be seated into every work stream below.`);
  const totals = { changed: 0, unsupported: 0, failed: 0, seated: 0 };
  let consecutiveFailures = 0;
  for (const entry of record.entries) {
    const result = await narrow({ ...context, membersToSeat: members }, entry);
    totals[result.outcome] += 1;
    consecutiveFailures = result.outcome === "failed" ? consecutiveFailures + 1 : 0;
    if (result.seated.length > 0) totals.seated += 1;
    // Rewritten as each row settles, so the file on disk always describes what
    // has actually happened rather than what was planned.
    entry.seatedUserIds = result.seated;
    context.writeRecord(context.record, record);
    if (result.outcome === "failed") {
      context.log(`  ${entry.workstreamId} failed (${result.status} ${result.error}): ${entry.title}`);
    }
    if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
      context.log(
        `Stopping after ${consecutiveFailures} failures in a row — that is a broken `
        + `precondition, not bad luck. ${context.record} is intact; fix it and re-run.`,
      );
      break;
    }
  }
  return totals;
}

export async function revert(context) {
  const record = context.readRecord(context.revert);
  // Global and EU share no work-stream ids. Pointing a Global record at EU
  // would patch ids that do not exist there and report every one as a failure,
  // which reads like a broken revert rather than a misaimed one.
  if (record.baseUrl && record.baseUrl !== context.baseUrl) {
    throw new Error(
      `${context.revert} was recorded against ${record.baseUrl}, not ${context.baseUrl}.`,
    );
  }
  context.log(`Reverting ${record.entries.length} entries from ${context.revert}.`);
  const totals = { changed: 0, unsupported: 0, failed: 0, seated: 0 };
  let consecutiveFailures = 0;
  for (const entry of record.entries) {
    const result = await setScope(context, entry.workstreamId, entry.priorScope);
    totals[result.outcome] += 1;
    consecutiveFailures = result.outcome === "failed" ? consecutiveFailures + 1 : 0;
    if (result.outcome === "failed") {
      context.log(`  ${entry.workstreamId} failed (${result.status} ${result.error}): ${entry.title}`);
    }
    if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
      context.log(
        `Stopping after ${consecutiveFailures} failures in a row. ${context.revert} is `
        + "unchanged; fix the cause and re-run the revert.",
      );
      break;
    }
  }
  // Participants the pass seated are left in place. Once the work stream is
  // workspace-readable again they grant nothing its scope does not already, and
  // removing them would also remove anyone legitimately added since. The record
  // names them under `seatedUserIds` for anyone who wants to tidy up by hand.
  return totals;
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
      recordExists: (path) => existsSync(path),
      readRecord: (path) => JSON.parse(readFileSync(path, "utf8")),
      // Written whole or not at all. This file is the only way back, and a
      // process killed mid-write would otherwise leave a truncated one, which
      // is worse than none: it parses far enough to look like a record.
      writeRecord: (path, record) => {
        writeFileSync(`${path}.tmp`, `${JSON.stringify(record, null, 2)}\n`);
        renameSync(`${path}.tmp`, path);
      },
    });
    if (totals.failed > 0) process.exit(1);
  } catch (error) {
    process.stderr.write(`${error.message}\n\nSee the comment at the top of this file for usage.\n`);
    process.exit(2);
  }
}
