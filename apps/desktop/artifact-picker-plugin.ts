import type { Plugin } from 'vite';
import { artifactFrameScript } from '../../packages/contracts/src/artifact-picker';

/** Trusted picker asset for native renderer builds and their dev server. */
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
