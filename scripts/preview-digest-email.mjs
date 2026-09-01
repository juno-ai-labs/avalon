#!/usr/bin/env node
// Renders the digest email as it would actually be sent, for a real workspace's
// real people, and writes one HTML file per recipient.
//
// The point is to look at it. A snapshot test proves the markup contains a
// string; only opening the file tells you whether the hierarchy reads, whether
// the accents earn their place, and whether a long section falls apart. Every
// visible change to the template should be checked here before it is called
// done.
//
// The digest body itself is written by a model at send time, so this renders a
// representative sample through the real template for each real recipient.
// Product bodies and work-stream titles live in WorkspaceDO, not D1; this tool
// deliberately reads only regional identity data.
//
// Run it through tsx, because it imports the real template rather than a copy
// of it, and that template is TypeScript:
//   pnpm exec tsx scripts/preview-digest-email.mjs                      # local D1
//   pnpm exec tsx scripts/preview-digest-email.mjs --db path/to.sqlite  # any D1
//   pnpm exec tsx scripts/preview-digest-email.mjs --out /tmp/preview
//
// Reading a remote workspace means exporting its D1 first, because Wrangler holds
// those credentials and this script does not. Pass the dump straight in — it is
// loaded into memory, so no sqlite3 CLI is needed and nothing is written back:
//   pnpm --filter @rally/api exec wrangler d1 export DB --remote \
//     --config wrangler.global.jsonc --output /tmp/global.sql
//   pnpm exec tsx scripts/preview-digest-email.mjs --sql /tmp/global.sql

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isEntryPoint } from "./entry-point.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DB = join(
  repositoryRoot,
  "apps/api/.wrangler/state/global/v3/d1/miniflare-D1DatabaseObject",
);

export function parseArguments(argv) {
  const options = { db: null, sql: null, out: "/tmp/digest-preview" };
  const keys = { "--db": "db", "--sql": "sql", "--out": "out" };
  for (let index = 0; index < argv.length; index += 1) {
    const key = keys[argv[index]];
    if (!key) continue;
    const value = argv[index + 1];
    // A missing value is an error rather than a silent default: `--sql --out x`
    // would otherwise read a dump from a file named `--out`, and `--db` alone
    // would fall back to the local database the flag was passed to replace.
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argv[index]} needs a value.`);
    }
    options[key] = value;
    index += 1;
  }
  return options;
}

/**
 * A Wrangler D1 export is a stream of statements, including pragmas and
 * transaction control that a fresh in-memory database rejects or does not need.
 * Dropping those is what lets a dump be read without a sqlite3 binary.
 */
export function importableStatements(dump) {
  return dump
    .split(/;\s*$/mu)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .filter((statement) => !/^(PRAGMA|BEGIN|COMMIT|END)\b/iu.test(statement));
}

/** Miniflare names its D1 file by hash, so the newest non-metadata one wins. */
export function resolveLocalDatabase(directory, entries) {
  const candidates = entries
    .filter((entry) => entry.endsWith(".sqlite") && !entry.startsWith("metadata"))
    .sort();
  if (candidates.length === 0) return null;
  return join(directory, candidates[candidates.length - 1]);
}

/**
 * A representative body per recipient, so the preview shows the template under
 * the shapes that actually stress it: a section that needs them, several that
 * do not, links, a quote, bold, and one long bullet.
 */
export function sampleBody(input) {
  const link = (title, id) => id
    ? `[${title}](https://rallywith.ai/app/workspaces/global/${input.workspaceId}/workstreams/${id})`
    : `**${title}**`;
  const sections = input.workstreams.slice(0, 3).map((workstream, index) => index === 0
    ? [
        `## ${workstream.title}`,
        "",
        `- 🔴 ${input.otherName} is blocked on the retry window and asked for a decision today. The current proposal caps retries at three over ten minutes, which drops the long-tail invoices the finance team cares about — ${link(workstream.title, workstream.id)} has the full thread.`,
        `- **Owner still unassigned.** Nobody has picked this up since Tuesday.`,
        "",
        "> We can ship the cap now and revisit the long tail next sprint, but somebody has to own that follow-up.",
      ].join("\n")
    : [
        `## ${workstream.title}`,
        "",
        `- ✅ Shipped the first pass and moved it to review — ${link(workstream.title, workstream.id)}.`,
        `- ${input.otherName} left two comments on the approach; neither blocks merging.`,
      ].join("\n"));

  return [
    `${input.otherName} needs a decision on the retry window today; everything else is moving without you.`,
    "",
    ...(input.highlightCount > 0
      ? [
          "## Needs you",
          "",
          `- 🟡 You were tagged in **${input.workstreams[0]?.title ?? "a work stream"}** — ${input.otherName} is waiting on the retry-window call before the release branch cuts.`,
          "",
        ]
      : []),
    ...sections,
  ].join("\n");
}

const SAMPLE_WORKSTREAMS = [
  { id: null, title: "Prepare the Acme client follow-up" },
  { id: null, title: "Investigate the invoice retry failures" },
  { id: null, title: "Review the onboarding handoff" },
];

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const { readFileSync, readdirSync } = await import("node:fs");

  let database;
  if (options.sql) {
    // In memory and never written back: a production dump is read here, not kept.
    database = new DatabaseSync(":memory:");
    for (const statement of importableStatements(readFileSync(options.sql, "utf8"))) {
      try {
        database.exec(statement);
      } catch {
        // A dump carries objects this preview does not read. One that will not
        // replay is skipped rather than stopping the whole import.
      }
    }
  } else {
    const databasePath = options.db ?? resolveLocalDatabase(DEFAULT_DB, readdirSync(DEFAULT_DB));
    if (!databasePath) throw new Error("No D1 database found. Run pnpm db:migrate && pnpm db:seed, or pass --db.");
    database = new DatabaseSync(databasePath, { readOnly: true });
  }
  const { digestEmailHtml } = await import("../apps/api/src/services/digest-email-content.ts");
  const { digestSettingsUrl, occurrenceLabel } = await import("../apps/api/src/services/digest-delivery-service.ts");

  const members = database.prepare(
    `SELECT u.id, u.name, u.email, u.timezone, w.id AS workspace_id, w.name AS workspace_name
       FROM workspace_members m
       JOIN users u ON u.id = m.user_id
       JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.status = 'active'
      ORDER BY w.name, u.name`,
  ).all();
  if (members.length === 0) throw new Error("That database has no active workspace members.");

  mkdirSync(options.out, { recursive: true });
  const written = [];
  for (const member of members) {
    const others = members.filter((candidate) => candidate.id !== member.id);
    const highlightCount = 1;
    const bodyMarkdown = sampleBody({
      workstreams: SAMPLE_WORKSTREAMS,
      workspaceId: member.workspace_id,
      otherName: others[0]?.name ?? "A teammate",
      highlightCount,
    });
    const plannedFor = new Date().toISOString();

    const html = digestEmailHtml({
      recipientName: member.name,
      workspaceName: member.workspace_name,
      occurrenceLabel: occurrenceLabel(plannedFor, member.timezone),
      bodyMarkdown,
      itemCount: SAMPLE_WORKSTREAMS.length * 2,
      highlightCount,
      appUrl: "https://rallywith.ai",
      settingsUrl: digestSettingsUrl({
        AVALON_REGION: "global",
        PUBLIC_WEB_BASE_URL: "https://rallywith.ai",
      }, member.workspace_id),
    });
    const file = join(options.out, `${member.email.replace(/[^a-z0-9]+/giu, "-")}.html`);
    writeFileSync(file, html);
    written.push({ file, name: member.name, source: "sample body" });
  }

  database.close();
  for (const entry of written) console.log(`${entry.name.padEnd(18)} ${entry.source.padEnd(18)} ${entry.file}`);
}

if (isEntryPoint(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
