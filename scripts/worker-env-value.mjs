/** JSON string escaping is not dotenv escaping: Wrangler preserves \" literally. */
export function workerEnvValue(key, value) {
  if (!key.endsWith("_JSON")) return JSON.stringify(value);
  // Single-quoted dotenv values preserve JSON quotes and backslashes. Escape
  // apostrophes inside the JSON itself so they cannot close the dotenv value.
  let parsed;
  try { parsed = JSON.parse(value); }
  catch { throw new Error(`${key} is not valid JSON`); }
  const json = JSON.stringify(parsed).replaceAll("'", "\\u0027");
  return `'${json}'`;
}

/** Decode older generated JSON strings before replacing their dotenv encoding. */
export function parseWorkerEnvValue(key, value) {
  if (value.startsWith('"') && value.endsWith('"')) {
    if (key.endsWith('_JSON')) {
      try { return JSON.parse(value); }
      catch { /* A raw quoted JSON object is validated during serialization. */ }
    }
    return value.slice(1, -1);
  }
  return value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1) : value;
}
