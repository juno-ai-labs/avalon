import type { Plugin } from 'vite';
import { artifactFrameScript } from '../../packages/contracts/src/artifact-picker';

/** Same trusted asset in desktop builds, the web client and their dev servers. */
export function artifactPickerPlugin(): Plugin {
  return {
    name: 'rally-artifact-frame-picker',
    generateBundle() {
      this.emitFile({ type:'asset', fileName:'annotation-frame.js', source:artifactFrameScript() });
    },
    configureServer(server) {
      server.middlewares.use('/annotation-frame.js', (_request,response) => {
        response.setHeader('Content-Type','application/javascript; charset=utf-8');
        response.end(artifactFrameScript());
      });
    },
  };
}
