/**
 * Delete the automation drafts stranded by retiring the standalone draft screen.
 *
 * That screen was the only surface a draft had: `automation.tsx` sent every
 * automation whose status was `draft` there and nowhere else. With it gone, a
 * draft's definition survives inside its AutomationAgent with nothing to open,
 * continue, or accept it.
 *
 * Deleting is the honest resolution. A draft *is* a conversation in progress —
 * its value is that conversation — and a definition separated from the
 * discussion that produced it is a half-finished thing nobody will remember
 * asking for. Draining first would make the retirement wait on other people's
 * half-finished work for a surface being removed because it should not exist,
 * and building stranded drafts a read-only view with an Accept button is a
 * surface constructed solely to bury the dead.
 *
 * Counting is not optional and not a gate. Run with --count first so the
 * decision is taken with the number in view, and if it is not zero, tell the
 * people who have one: losing work you started is worth a sentence even when
 * the work was minutes old.
 *
 *   node scripts/retire-standalone-automation-drafts.mjs --count
 *   node scripts/retire-standalone-automation-drafts.mjs --delete
 */

import { isEntryPoint } from './entry-point.mjs';

/**
 * A draft authored inside a work stream is not stranded.
 *
 * Its conversation is a room somebody can still open, and its proposal card is
 * still in that feed with its accept. Only drafts belonging to the retired
 * screen lost their surface, and deleting the others would delete live work.
 */
export function strandedDrafts(rows) {
  return rows.filter((row) =>
    row.lifecycle === 'draft' && !row.authoredInWorkstreamId);
}

export function formatCount(rows) {
  const stranded = strandedDrafts(rows);
  if (stranded.length === 0) {
    return 'No stranded drafts. The retirement takes nobody\'s work with it.';
  }
  const byAuthor = new Map();
  for (const draft of stranded) {
    byAuthor.set(draft.authorUserId, (byAuthor.get(draft.authorUserId) ?? 0) + 1);
  }
  const lines = [
    `${stranded.length} draft${stranded.length === 1 ? '' : 's'} would be deleted,`
    + ` held by ${byAuthor.size} ${byAuthor.size === 1 ? 'person' : 'people'}.`,
    'Tell them before this runs.',
  ];
  for (const [author, count] of [...byAuthor].sort((left, right) => right[1] - left[1])) {
    lines.push(`  ${author}: ${count}`);
  }
  return lines.join('\n');
}

export async function deleteStranded(rows, deleteOne) {
  const stranded = strandedDrafts(rows);
  const failures = [];
  let deleted = 0;
  for (const draft of stranded) {
    try {
      await deleteOne(draft);
      deleted += 1;
    } catch (error) {
      // One object refusing must not strand the rest: every remaining draft is
      // still a surface nobody has.
      failures.push({ automationId: draft.automationId, reason: String(error) });
    }
  }
  return { considered: stranded.length, deleted, failures };
}

async function readRows(stream) {
  let raw = '';
  for await (const chunk of stream) raw += chunk;
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('Expected a JSON array of automation rows');
  return parsed;
}

async function main() {
  const deleting = process.argv.includes('--delete');
  if (!deleting && !process.argv.includes('--count')) {
    throw new Error('Pass --count to see what would be deleted, or --delete to delete it');
  }
  // The rows arrive on stdin rather than being fetched here. Automation state
  // is Durable Object state reachable only by typed RPC, so an operator pipes
  // the listing in from the console that can read it; this file holds the
  // decision, not the transport, and pretending otherwise would make a script
  // that cannot run.
  const rows = await readRows(process.stdin);
  process.stdout.write(`${formatCount(rows)}\n`);
  if (!deleting) return;
  const endpoint = process.env.RALLY_ADMIN_DELETE_URL?.trim();
  const token = process.env.RALLY_ADMIN_TOKEN?.trim();
  if (!endpoint || !token) {
    throw new Error('RALLY_ADMIN_DELETE_URL and RALLY_ADMIN_TOKEN are required to delete');
  }
  const report = await deleteStranded(rows, async (draft) => {
    const response = await fetch(`${endpoint}/${encodeURIComponent(draft.automationId)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 200)}`);
  });
  process.stdout.write(`Deleted ${report.deleted} of ${report.considered}.\n`);
  for (const failure of report.failures) {
    process.stdout.write(`  ${failure.automationId}: ${failure.reason}\n`);
  }
  // Every draft left behind is still a definition with no surface.
  if (report.failures.length > 0) process.exitCode = 1;
}

if (isEntryPoint(import.meta.url)) {
  await main();
}
