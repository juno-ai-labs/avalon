/** JSON string escaping is not dotenv escaping: Wrangler preserves \" literally. */
export function workerEnvValue(key, value) {
  if (!key.endsWith("_JSON")) return JSON.stringify(value);
  // Single-quoted dotenv values preserve JSON quotes and backslashes. Escape
  // apostrophes inside the JSON itself so they cannot close the dotenv value.
  const json = JSON.stringify(JSON.parse(value)).replaceAll("'", "\\u0027");
  return `'${json}'`;
}
