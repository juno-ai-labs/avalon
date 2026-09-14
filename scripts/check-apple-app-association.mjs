import { isEntryPoint } from './entry-point.mjs';
export async function assertAppleAssociation(response) {
  if (response.status !== 200 || response.redirected || !response.headers.get('content-type')?.includes('application/json')) throw new Error('Apple association must serve JSON without a redirect');
  const document = await response.json();
  const details = document.applinks?.details;
  if (details?.length !== 1 || JSON.stringify(details[0].appIDs) !== JSON.stringify(['7ZLT6A8W25.ai.rallywith.desktop'])
    || JSON.stringify(details[0].components) !== JSON.stringify([{ '/': '/app/workspaces/*' }, { '/': '/app/workstreams/*' }])) throw new Error('Apple association has incorrect app or paths');
}
export async function checkAppleAssociations() {
  for (const host of ['rallywith.ai', 'www.rallywith.ai']) {
    await assertAppleAssociation(await fetch(`https://${host}/.well-known/apple-app-site-association`, { redirect: 'manual' }));
  }
}
if (isEntryPoint(import.meta.url)) await checkAppleAssociations();
