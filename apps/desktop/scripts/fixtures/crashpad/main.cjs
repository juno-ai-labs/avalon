/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, process, setTimeout */
const { app, BrowserWindow, crashReporter } = require('electron');
const { mkdir, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { prepareFixtureGeneration } = require('./production-controller.cjs');

function switchValue(name) {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

const fixtureRoot = switchValue('fixture-root');
if (!fixtureRoot) throw new Error('Missing --fixture-root');
const generationId = switchValue('fixture-generation-id');
if (!generationId) throw new Error('Missing --fixture-generation-id');
const route = switchValue('fixture-route');
if (route !== 'global' && route !== 'eu') throw new Error('Missing or invalid --fixture-route');
const now = switchValue('fixture-now');
if (!now) throw new Error('Missing --fixture-now');

app.setPath('userData', join(fixtureRoot, 'user-data'));

void app.whenReady().then(async () => {
  const prepared = await prepareFixtureGeneration({
    rootDirectory: fixtureRoot,
    route,
    generationId,
    now,
    runtime: {
      release: app.getVersion(),
      buildId: app.getVersion(),
      platform: process.platform,
      architecture: process.arch,
      launchId: generationId,
      channel: 'stable',
    },
  });
  const crashpadDirectory = prepared.generation.activeCrashpadDirectory;
  if (!crashpadDirectory) throw new Error('Production crash generation was not created');
  app.setPath('crashDumps', crashpadDirectory);
  crashReporter.start({
    productName: 'Rally Crashpad Fixture',
    uploadToServer: false,
    ignoreSystemCrashHandler: true,
    rateLimit: false,
    compress: false,
    globalExtra: {
      fixture_kind: 'renderer',
    },
  });
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await window.loadURL('data:text/html,<title>Rally Crashpad fixture</title>');
  window.webContents.once('render-process-gone', async (_event, details) => {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await mkdir(fixtureRoot, { recursive: true });
    await writeFile(join(fixtureRoot, 'fixture-result.json'), JSON.stringify({
      rendererCreated: true,
      reason: details.reason,
      route: prepared.route.route,
      generationId: prepared.generation.activeGenerationId,
      rotatedGenerationIds: prepared.generation.rotatedGenerationIds,
    }));
    app.quit();
  });
  window.webContents.forcefullyCrashRenderer();
  setTimeout(() => app.exit(2), 10_000).unref();
});
