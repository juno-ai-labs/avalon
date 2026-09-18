import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertAppleAssociation } from './check-apple-app-association.mjs';
const body = readFileSync(new URL('../apps/site/public/.well-known/apple-app-site-association', import.meta.url), 'utf8');
test('the association check accepts the shipped document and refuses a redirect or wrong app', async () => {
  await assertAppleAssociation(new Response(body, { headers: { 'content-type': 'application/json' } }));
  await assert.rejects(assertAppleAssociation(new Response(null, { status: 301 })), /without a redirect/);
  await assert.rejects(assertAppleAssociation(new Response(body.replace('ai.rallywith.desktop', 'wrong.app'), { headers: { 'content-type': 'application/json' } })), /incorrect app/);
  await assert.rejects(assertAppleAssociation(new Response(body.replace('ai.rallywith.ios', 'wrong.app'), { headers: { 'content-type': 'application/json' } })), /incorrect app/);
});
