import { readFile } from 'node:fs/promises';

// Authentication is read from a file, never a command-line argument or output.
// Use the existing regional Ace operator credential; no new permanent token.
const [command, apiBaseUrl, tokenFile, input] = process.argv.slice(2);
if (!['preview', 'apply', 'status', 'resume', 'cancel'].includes(command) || !apiBaseUrl || !tokenFile || !input) {
  throw new Error('Usage: node scripts/connector-maintenance.mjs preview|apply|status|resume|cancel <regional-api-url> <operator-token-file> <selection-json-file|operation-id>');
}
const origin = new URL(apiBaseUrl);
if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname))) {
  throw new Error('The operator endpoint must use HTTPS (except local development)');
}
if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('Supply the regional API origin without a path or credentials');
const token = (await readFile(tokenFile, 'utf8')).trim();
if (!token) throw new Error('Operator credential file is empty');
const selection = command === 'preview' ? JSON.parse(await readFile(input, 'utf8')) : undefined;
const path = command === 'preview' ? 'preview' : command === 'status' ? encodeURIComponent(input) : `${encodeURIComponent(input)}/${command}`;
const response = await fetch(new URL(`/internal/connector-maintenance/${path}`, origin), {
  method: command === 'status' ? 'GET' : 'POST',
  headers: { Authorization: `Bearer ${token}`, ...(selection ? { 'Content-Type': 'application/json' } : {}) },
  ...(selection ? { body: JSON.stringify(selection) } : {}),
  redirect: 'error',
});
if (!response.ok) throw new Error(`Connector maintenance request failed (${response.status})`);
process.stdout.write(`${JSON.stringify(await response.json(), null, 2)}\n`);
