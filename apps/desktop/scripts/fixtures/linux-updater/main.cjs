/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, process, Buffer, console, URL */
const { app } = require('electron');
const { AppImageUpdater } = require('electron-updater');
const { createServer } = require('node:http');
const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const directory = process.env.RALLY_UPDATE_FIXTURE_DIRECTORY;
app.setPath('userData', join(directory, 'profile'));
process.env.APPIMAGE = join(directory, 'Rally.AppImage');
process.env.RALLY_UPDATE_FIXTURE_MARKER = join(directory, 'restarted');
writeFileSync(process.env.APPIMAGE, 'old app image', { mode: 0o755 });
// A tiny executable stands in for an AppImage payload. The real updater must
// verify, replace and execute it; no package manager or production feed is used.
const payload = Buffer.from('#!/bin/sh\nprintf updated > "$RALLY_UPDATE_FIXTURE_MARKER"\n');
const digest = createHash('sha512').update(payload).digest('base64');
let corrupt = true;
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  if (path === '/stable-linux.yml') {
    response.end(`version: 1.1.0\nfiles:\n  - url: Rally-1.1.0.AppImage\n    sha512: ${digest}\n    size: ${payload.length}\npath: Rally-1.1.0.AppImage\nsha512: ${digest}\n`);
  } else if (path === '/Rally-1.1.0.AppImage') {
    response.end(corrupt ? Buffer.from('wrong bytes') : payload);
  } else { response.writeHead(404); response.end(); }
});

void app.whenReady().then(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const updater = new AppImageUpdater();
  const configuration = join(directory, 'app-update.yml');
  writeFileSync(configuration, 'updaterCacheDirName: rally-linux-fixture-updater\n');
  updater.updateConfigPath = configuration;
  updater.forceDevUpdateConfig = true;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.disableDifferentialDownload = true;
  updater.setFeedURL({ provider: 'generic', url: `http://127.0.0.1:${server.address().port}` });
  updater.channel = 'stable';
  updater.allowDowngrade = false;
  updater.on('error', () => {});
  const update = await updater.checkForUpdates();
  if (update.updateInfo.version !== '1.1.0') throw new Error('Linux updater did not select the newer version');
  let rejected = false;
  try { await updater.downloadUpdate(); } catch (error) {
    if (!/sha512 checksum mismatch|size mismatch/u.test(error.message)) throw error;
    rejected = true;
  }
  if (!rejected || readFileSync(process.env.APPIMAGE, 'utf8') !== 'old app image') {
    throw new Error('Corrupt update was not rejected without replacing the current app');
  }
  corrupt = false;
  await updater.checkForUpdates();
  const [download] = await updater.downloadUpdate();
  if (!readFileSync(download).equals(payload)) throw new Error('Downloaded Linux payload differs');
  server.close();
  updater.quitAndInstall(false, true);
}).catch((error) => { console.error(error); server.close(); app.exit(1); });
