#!/usr/bin/env node
// Renders the automation result email as it would actually be sent, so somebody
// can look at it.
//
// The point is the same as the digest preview beside it: a test proves the
// markup contains a string, and only opening the file tells you whether a long
// briefing holds its hierarchy, whether the ranks survive, whether a table is
// readable, and whether the button reads as the one thing to do. Every visible
// change to this email should be checked here before it is called done.
//
// It takes no database. Unlike a digest, an automation result needs nothing but
// its own body — the sample below has the shape a competitor briefing arrives
// in, including the constructs that used to break: a ranked list, nested source
// links, a table, a fenced block, and emphasis inside a URL. Its companies and
// links are deliberately invented: a fixture that named real accounts would rot
// when a post was deleted, and a preview has no business asserting who anyone's
// competitors are.
//
// Run it through tsx, because it imports the real template rather than a copy:
//   pnpm exec tsx scripts/preview-automation-email.mjs
//   pnpm exec tsx scripts/preview-automation-email.mjs --out /tmp/preview
//   pnpm exec tsx scripts/preview-automation-email.mjs --body /tmp/result.md
//   pnpm exec tsx scripts/preview-automation-email.mjs --outcome failed

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isEntryPoint } from "./entry-point.mjs";

const OUTCOMES = ["completed", "needs_input", "failed", "stopped"];

export function parseArguments(argv) {
  const options = { out: "/tmp/automation-email-preview", body: null, outcome: "completed" };
  const keys = { "--out": "out", "--body": "body", "--outcome": "outcome" };
  for (let index = 0; index < argv.length; index += 1) {
    const key = keys[argv[index]];
    if (!key) continue;
    const value = argv[index + 1];
    // A missing value is an error rather than a silent default, so
    // `--body --out x` cannot read a result from a file named `--out`.
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argv[index]} needs a value.`);
    }
    options[key] = value;
    index += 1;
  }
  if (!OUTCOMES.includes(options.outcome)) {
    throw new Error(`--outcome must be one of ${OUTCOMES.join(", ")}.`);
  }
  return options;
}

/** A briefing carrying every construct this email has ever rendered wrong. */
export const SAMPLE_BODY = [
  "# Daily Competitor Intelligence — 22 August 2026",
  "",
  "**Coverage:** X, Hacker News, product surfaces, press",
  "",
  "---",
  "",
  "## Executive summary",
  "",
  "1. **Northwind** — rebranded, staking out *\"single-player AI is over\"*.",
  "2. **Contoso** — repriced against the model cut within hours.",
  "3. **Fabrikam** — shipped inside a popular editor, which is the distribution story.",
  "",
  "## Deep dive",
  "",
  "### Contoso",
  "",
  "- **Latest tagline:** *\"Build agent teams that ship real work.\"*",
  "- **Sources:**",
  "  - [Pricing thread](https://example.com/contoso/pricing)",
  "  - [Product showcase](https://example.com/contoso/showcase)",
  "- **Sentiment:** growth leads are convinced; engineers are not — `tracking_id` collisions on duplicate contacts come up repeatedly.",
  "",
  "> Community pushback centred on CRM write fragility rather than on the agents themselves.",
  "",
  "| Rank | Company | Move |",
  "| --- | --- | --- |",
  "| 1 | Northwind | Rebrand complete |",
  "| 2 | Contoso | Price-led campaign |",
  "",
  "The webhook payload they publish:",
  "",
  "```json",
  "{\"event\": \"agent.completed\", \"ops\": 800}",
  "```",
  "",
  "Nothing else qualified today.",
].join("\n");

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const { automationResultEmailHtml } = await import("../apps/api/src/services/automation-email-content.ts");

  const body = options.body ? readFileSync(options.body, "utf8") : SAMPLE_BODY;
  const name = "Daily competitor briefing";
  const html = automationResultEmailHtml({
    name,
    heading: name,
    ran: "22 Aug 2026",
    outcomeStatus: options.outcome,
    body: options.outcome === "completed" ? body : "Avalon could not reach the news source.",
    workstreamUrl: "https://rallywith.ai/app/workspaces/global/00000000-0000-7000-8000-000000000001/workstreams/018f3f4e-7b5a-7cc1-9a6f-2aa0324b7902",
  });

  mkdirSync(options.out, { recursive: true });
  const file = join(options.out, `automation-${options.outcome}.html`);
  writeFileSync(file, html);
  process.stdout.write(`${file}\n`);
  return [file];
}

if (isEntryPoint(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
