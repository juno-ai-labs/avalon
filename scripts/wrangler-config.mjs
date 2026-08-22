/**
 * Read a Wrangler JSONC file as data.
 *
 * Shared by the scripts that reason about the Wrangler files — the queue
 * provisioner and the tracker health check — and deliberately free of side
 * effects, so a read-only script can import it without pulling in one that
 * mutates the Cloudflare account.
 */

/**
 * Strip JSONC comments without touching string contents.
 *
 * A regex cannot do this: these files contain `https://` inside `vars`, and a
 * naive `//` strip would truncate every one of them. Tracking the string state
 * is the whole difference between a parser and a corruption.
 */
export function stripJsonComments(source) {
  let output = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (inLineComment) {
      if (character === '\n') {
        inLineComment = false;
        output += character;
      }
      continue;
    }
    if (inBlockComment) {
      if (character === '*' && next === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      output += character;
      if (character === '\\') {
        output += next ?? '';
        index += 1;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === '/' && next === '/') {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }
    output += character;
  }

  // Wrangler files are hand-edited, so a trailing comma before a closer is
  // ordinary there and fatal to JSON.parse.
  return output.replace(/,(\s*[}\]])/gu, '$1');
}

export function parseWranglerConfig(source) {
  return JSON.parse(stripJsonComments(source));
}
