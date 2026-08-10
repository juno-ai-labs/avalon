// Seeds .env.local from .env.example for a remote agent sandbox, filling every
// blank assignment with the value the sandbox supplies through the environment.
//
// sync-dev-env.mjs reads .env.local and never process.env, and its regional
// merge lets a blank value in .env.local override a real one already written to
// apps/api/.dev.vars.*. Copying the example verbatim therefore both strands a
// configured provider key and deletes a previously synced one.
//
// A value is only written when it survives a round trip through the reader on
// the other side. Anything that does not — a multi-line PEM, a value carrying a
// quote or a backslash — is skipped with a warning rather than written in a
// mangled form that parses cleanly and is no longer the value.

import { readFile, writeFile } from "node:fs/promises";
import { argv, env, exit, stderr, stdout } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const BLANK_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=[ \t]*$/u;

// The reader in sync-dev-env.mjs, kept deliberately identical: it trims the
// value and strips one layer of matching surrounding quotes, and performs no
// unescaping. Change this only alongside `parseEnv` there.
export function readValueFromLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const equals = trimmed.indexOf("=");
  if (equals < 1) return null;
  let value = trimmed.slice(equals + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return { key: trimmed.slice(0, equals).trim(), value };
}

// True when `KEY=value` written plainly is read back as exactly `value`. Values
// with a newline cannot round trip at all: the reader is line-based.
export function survivesRoundTrip(key, value) {
  if (value.includes("\n") || value.includes("\r")) return false;
  const parsed = readValueFromLine(`${key}=${value}`);
  return parsed !== null && parsed.key === key && parsed.value === value;
}

export function buildEnvLocal(exampleText, environment) {
  const filled = [];
  const skipped = [];
  const lines = exampleText.split(/\r?\n/u).map((line) => {
    const match = BLANK_ASSIGNMENT.exec(line);
    if (!match) return line;
    const key = match[1];
    const supplied = environment[key];
    if (typeof supplied !== "string" || supplied.length === 0) return line;
    if (!survivesRoundTrip(key, supplied)) {
      skipped.push(key);
      return line;
    }
    filled.push(key);
    return `${key}=${supplied}`;
  });
  return { text: lines.join("\n"), filled, skipped };
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const example = await readFile(resolve(root, ".env.example"), "utf8");
  const { text, filled, skipped } = buildEnvLocal(example, env);
  await writeFile(resolve(root, ".env.local"), text, { mode: 0o600 });

  stdout.write(`filled ${filled.length} value(s) from the environment: ${filled.join(", ") || "none"}\n`);
  if (skipped.length > 0) {
    stderr.write(
      `skipped ${skipped.length} value(s) that cannot be represented in .env.local: ${skipped.join(", ")}.\n` +
        "A multi-line or quote-bearing value (a PEM, for example) has to be added to .env.local by hand.\n"
    );
  }
}

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  await main().catch((error) => {
    stderr.write(`${error?.stack ?? error}\n`);
    exit(1);
  });
}
