if (process.platform === 'darwin' && process.arch === 'arm64') {
  await import('./build-core-audio-tap.mjs');
  await import('./build-unified-log.mjs');
}
