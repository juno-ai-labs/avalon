/* Local-only acceptance against a caller-supplied, uncommitted organization snapshot.
 * PLAYWRIGHT_MODULE may point to an existing Playwright installation. */
import assert from 'node:assert/strict';
import { artifactInsetScript, FLOATING_HEADER_INSET } from '../src/layout.ts';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fixturePath = process.argv[2];
if (!fixturePath) throw new Error('Pass a private snapshot scenario JSON path. See docs/mobile-canvas-client.md.');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const directory = path.dirname(path.resolve(fixturePath));
const apiOrigin = process.env.MOBILE_TEST_API || 'http://localhost:8787';
const browserOrigin = process.env.MOBILE_TEST_BROWSER || 'http://localhost:5175';
const expoOrigin = process.env.MOBILE_TEST_EXPO || 'http://localhost:8081';
for (const origin of [apiOrigin, browserOrigin, expoOrigin]) {
  assert.ok(['localhost', '127.0.0.1'].includes(new URL(origin).hostname), 'Snapshot writes require loopback development servers');
}
const palette = ['rose', 'red', 'orange', 'amber', 'lime', 'green', 'emerald', 'cyan', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink'];
const artifactOrigin = 'https://mobile-snapshot.invalid';
const uuid = () => crypto.randomUUID();
const operationId = () => { const id = uuid(); return `${Date.now().toString(16).padStart(12, '0').slice(0, 8)}-${Date.now().toString(16).slice(-4)}-7${id.slice(15)}`; };

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  context.setDefaultTimeout(15000);
  const headers = { Origin: browserOrigin };
  const base = `${browserOrigin}/regional/global/browser`;
  const errors = [];
  const report = { source: fixture.source, checks: [], screenshots: [], productionWrites: 0 };
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  let workspaceId;
  try {
    const auth = await context.request.post(`${base}/dev/session`, { headers, data: {} });
    assert.ok(auth.ok(), `Development sign-in: ${auth.status()}`);
    const session = await auth.json();
    const created = await context.request.post(`${base}/workspace/create`, { headers, data: { name: `${fixture.source.organization} · mobile test`, operationId: operationId() } });
    assert.ok(created.ok(), `Local organization creation: ${created.status()}`);
    workspaceId = (await created.json()).workspaceId;
    const selected = await context.request.post(`${base}/workspace/select`, { headers, data: { workspaceId } });
    assert.ok(selected.ok());
    const rows = fixture.canvases.map((row) => ({ ...row, localId: uuid(), resourceId: row.site ? uuid() : null }));
    const resources = rows.filter((row) => row.site).map((row) => ({
      id: row.resourceId, workspace_id: workspaceId, resource_type: 'generated_site', provider: 'fixture', provider_resource_id: row.localId,
      title: row.title, mime_type: 'application/vnd.rally.site-manifest+json', content_ref: `global/${workspaceId}/seed/${row.localId}.json`,
      metadata_json: '{}', created_at: row.createdAt, updated_at: row.updatedAt, revision_author_kind: 'system', revision_cause: 'created',
    }));
    const seed = await context.request.post(`${apiOrigin}/dev/seed-product`, { data: {
      workspaceId, automations: [], workspaceTables: { resources },
      payloads: resources.map((row) => ({ key: row.content_ref, contentType: row.mime_type, text: '{}' })),
      canvases: rows.map((row) => ({ id: row.localId, title: row.title, createdByUserId: session.user.id, visibility: 'workspace', participantUserIds: [],
        artifactResourceIds: row.resourceId ? [row.resourceId] : [],
        messages: (row.messages || []).map((message, index) => ({ id: uuid(), client_message_id: uuid(), author_type: message.actor,
          author_user_id: message.actor === 'human' ? session.user.id : null, author_name_snapshot: message.author,
          message_type: 'text', text_content: message.text, sequence_number: index + 1, created_at: message.createdAt })),
      })),
    } });
    assert.ok(seed.ok(), `Seed failed: ${seed.status()} ${await seed.text()}`);
    const api = `${base}/api/${workspaceId}`;
    // Remapping ids must not change an unchosen canvas's source hue.
    for (const row of rows) {
      const appearance = await context.request.patch(`${api}/canvases/${row.localId}`, { headers, data: { appearance: { icon: row.appearance?.icon ?? null, color: row.appearance?.color ?? palette[[...row.sourceCanvasId].reduce((hash, char) => hash + char.charCodeAt(0), 0) % palette.length] } } });
      assert.ok(appearance.ok());
    }
    // A deny-by-default network boundary: real public HTML/data are replayed
    // locally; even a link or script in the snapshot cannot write to production.
    let items = structuredClone(fixture.groceryData.items);
    await context.route('**/*', async (route) => {
      const request = route.request(); const url = new URL(request.url());
      if ([apiOrigin, browserOrigin, expoOrigin].includes(url.origin)) return route.continue();
      if (url.origin !== artifactOrigin) return route.abort('blockedbyclient');
      const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS' };
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (url.pathname === '/grocery/') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.resolve(directory, fixture.groceryHtml), 'utf8') });
      if (url.pathname.startsWith('/grocery/api/items')) {
        if (request.method() === 'POST') {
          const input = request.postDataJSON();
          if (!items.some((item) => item.id === input.id)) items.push({ id: input.id, original_text: input.text, name: input.text, quantity: '', section: 'Produce', checked: 0, classification_status: 'done', created_at: new Date().toISOString() });
        } else if (request.method() === 'PATCH') {
          const id = url.pathname.split('/').at(-1); const update = request.postDataJSON();
          items = items.map((item) => item.id === id ? { ...item, ...update } : item);
        }
        return route.fulfill({ headers: cors, json: { items, sections: fixture.groceryData.sections } });
      }
      return route.fulfill({ status: 401, contentType: 'text/html', body: '<p>This snapshot does not include access to this artifact.</p>' });
    });
    await context.route('**/resources/*/artifact/open', async (route) => {
      const id = route.request().url().split('/resources/')[1].split('/')[0];
      const row = rows.find((item) => item.resourceId === id);
      if (!row) return route.abort('blockedbyclient');
      if (row.site !== 'grocery') return route.fulfill({ status: 403, json: { error: { code: 'fixture_artifact_not_captured', message: 'This artifact was not captured.' } } });
      return route.fulfill({ json: { artifactId: row.resourceId, canonicalUrl: `${artifactOrigin}/grocery/`, openUrl: `${artifactOrigin}/grocery/`, mode: 'active', stateful: true } });
    });
    // Browser frames cannot accept native WebView injection. Apply the actual
    // presentation script at document load to inspect the device layout here.
    await context.addInitScript({ content: `if (location.origin === ${JSON.stringify(artifactOrigin)}) addEventListener('DOMContentLoaded', () => { ${artifactInsetScript(FLOATING_HEADER_INSET)} });` });
    await context.addInitScript(({ origin, userId, workspaceId }) => {
      if (globalThis.location.origin === origin) globalThis.localStorage.setItem('rally-mobile:last-workspace', JSON.stringify({ userId, id: workspaceId, region: 'global' }));
    }, { origin: browserOrigin, userId: session.user.id, workspaceId });
    await page.goto(expoOrigin);
    const app = page.frameLocator('iframe').first();
    await app.getByRole('button', { name: new RegExp(fixture.groceryTitle) }).waitFor();
    const shot = async (name) => { const target = path.join(directory, `${name}.png`); await page.screenshot({ path: target }); report.screenshots.push(target); };
    assert.equal(await app.locator('body').evaluate(() => globalThis.location.hash), '#/canvases');
    await shot('dashboard'); report.checks.push('real canvas titles and directory on canonical dashboard route');
    await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
    await page.getByRole('button', { name: 'Edit tabs', exact: true }).click();
    for (const title of fixture.pinTitles) {
      await page.getByRole('button', { name: `Pin ${title}`, exact: true }).click();
      await page.getByLabel(`Reorder ${title}`, { exact: true }).waitFor();
    }
    const last = fixture.pinTitles.at(-1);
    const handle = await page.getByLabel(`Reorder ${last}`, { exact: true }).boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down(); await page.mouse.move(handle.x + handle.width / 2, handle.y - 3 * 52, { steps: 15 }); await page.mouse.up();
    await page.waitForFunction(() => !globalThis.document.querySelector('[aria-label^="Reorder"][aria-disabled="true"]'));
    await page.waitForTimeout(350); await shot('sidebar');
    await page.getByRole('button', { name: 'Close sidebar', exact: true }).last().click();
    assert.equal(await page.getByRole('tab').count(), 5);
    const bounds = await page.getByRole('tab', { name: 'Home', exact: true }).locator('..').boundingBox();
    assert.equal(bounds.height, 60); assert.equal(bounds.width, 338);
    await page.reload(); await page.getByRole('tab', { name: fixture.groceryTitle, exact: true }).waitFor();
    assert.equal(await page.getByRole('tab').count(), 5); report.checks.push('four persisted pins plus fixed Home; 338 × 60 dock');
    const saved = await (await context.request.get(`${api}/canvases`)).json();
    const pinned = saved.items.filter((row) => row.pinnedPosition !== null).sort((a, b) => a.pinnedPosition - b.pinnedPosition);
    assert.equal(pinned[0].title, last); report.checks.push('drag ordering persisted through actual Canvas API');
    await page.getByRole('tab', { name: fixture.groceryTitle, exact: true }).click();
    const grocery = app.frameLocator('iframe');
    await grocery.getByRole('heading', { name: 'Grocery list', exact: true }).waitFor();
    assert.equal(await app.locator('body').evaluate(() => globalThis.location.hash), `#/canvases/${rows.find(row => row.title === fixture.groceryTitle).localId}?tab=1`);
    assert.equal(await grocery.locator('body').evaluate(() => globalThis.location.href), `${artifactOrigin}/grocery/`);
    report.checks.push('canonical canvas route loads hosted artifact URL directly');
    await grocery.getByText(fixture.groceryData.items[0].name, { exact: true }).first().waitFor();
    await shot('grocery');
    await page.setViewportSize({ width: 390, height: 640 });
    await grocery.locator('body').evaluate(() => globalThis.scrollTo(0, 100));
    await page.waitForTimeout(150); await shot('grocery-scrolled');
    await page.setViewportSize({ width: 390, height: 844 });
    await grocery.locator('body').evaluate(() => globalThis.scrollTo(0, 0));
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(200); await shot('grocery-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await grocery.locator('#new-item').fill('2 avocados');
    await grocery.getByRole('button', { name: 'Add', exact: true }).click();
    await grocery.getByText('2 avocados', { exact: true }).waitFor(); report.checks.push('captured reactive artifact renders and accepts isolated edits');
    await page.getByRole('tab', { name: 'Home', exact: true }).click();
    await page.getByRole('tab', { name: fixture.groceryTitle, exact: true }).click();
    await grocery.getByText('2 avocados', { exact: true }).waitFor(); report.checks.push('artifact state retained across tab changes');
    const documentTime = await grocery.locator('body').evaluate(() => performance.timeOrigin);
    await grocery.locator('#new-item').fill('Keep this artifact draft');
    await page.setViewportSize({ width: 466, height: 678 });
    await page.setViewportSize({ width: 951, height: 669 });
    await page.waitForFunction(() => globalThis.document.querySelector('[role=tab]')?.parentElement.getBoundingClientRect().width === 60);
    assert.equal(await grocery.locator('#new-item').inputValue(), 'Keep this artifact draft');
    assert.equal(await grocery.locator('body').evaluate(() => performance.timeOrigin), documentTime);
    await shot('artifact-expanded');
    await page.setViewportSize({ width: 466, height: 678 });
    await page.waitForFunction(() => globalThis.document.querySelector('[role=tab]')?.parentElement.getBoundingClientRect().height === 60);
    assert.equal(await grocery.locator('#new-item').inputValue(), 'Keep this artifact draft');
    assert.equal(await grocery.locator('body').evaluate(() => performance.timeOrigin), documentTime);
    await shot('artifact-compact');
    await page.setViewportSize({ width: 390, height: 844 });
    report.checks.push('browser resize changes dock to rail and back without reloading hosted document or losing input; not a native fold test');
    await page.getByRole('button', { name: 'Open conversation', exact: true }).click();
    await page.frameLocator('iframe').last().getByText(fixture.chatAssertion, { exact: false }).waitFor();
    assert.equal(await page.frameLocator('iframe').last().locator('body').evaluate(() => globalThis.location.hash), `#/canvases/${rows.find(row => row.title === fixture.groceryTitle).localId}?view=chat`);
    await shot('conversation'); await page.getByRole('button', { name: 'Close conversation', exact: true }).click();
    await page.getByRole('tab', { name: fixture.emptyTitle, exact: true }).click();
    await app.getByRole('textbox').first().waitFor();
    assert.equal(await app.locator('body').evaluate(() => new URLSearchParams(globalThis.location.hash.split('?')[1]).get('view')), 'chat');
    report.checks.push('captured conversation and empty-canvas chat fallback');
    const unavailable = fixture.canvases.find((row) => row.site === 'unavailable');
    if (unavailable) {
      await page.getByRole('tab', { name: unavailable.title, exact: true }).click();
      await app.getByRole('alertdialog').getByRole('heading', { name: 'This canvas couldn’t open', exact: true }).waitFor();
      await shot('unavailable');
      await app.getByRole('alertdialog').getByRole('button', { name: 'OK', exact: true }).click();
      report.checks.push('uncaptured protected artifact reports an access failure');
    }
    await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
    await page.getByRole('button', { name: 'Edit tabs', exact: true }).click();
    await page.getByRole('button', { name: `Unpin ${fixture.emptyTitle}`, exact: true }).click();
    await page.getByRole('button', { name: `Pin ${fixture.emptyTitle}`, exact: true }).waitFor();
    report.checks.push('unpin through actual Canvas API');
    await page.getByRole('button', { name: 'Create a canvas', exact: true }).click();
    await page.getByRole('button', { name: 'Create a canvas', exact: true }).waitFor({ state: 'hidden' });
    await app.getByRole('textbox', { name: 'Describe your canvas', exact: true }).fill('Keep my canvas idea');
    assert.equal(await app.locator('body').evaluate(() => globalThis.location.hash), '#/canvases');
    await shot('create');
    await page.getByRole('tab', { name: 'Home', exact: true }).click();
    await app.getByRole('heading', { name: 'Your canvases', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
    await page.getByRole('button', { name: 'Create a canvas', exact: true }).click();
    await page.getByRole('button', { name: 'Create a canvas', exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await app.getByRole('textbox', { name: 'Describe your canvas', exact: true }).inputValue(), 'Keep my canvas idea');
    report.checks.push('creation stays on dashboard route and retains its draft across navigation');
    assert.deepEqual(errors, []);
    report.passed = true;
  } finally {
    report.localWorkspaceId = workspaceId;
    report.pageErrors = errors;
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
    await browser.close();
  }
  console.log(JSON.stringify(report, null, 2));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
