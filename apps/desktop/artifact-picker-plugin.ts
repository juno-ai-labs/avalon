import type { Plugin } from 'vite';
import { artifactAnnotationScript } from '../../packages/contracts/src/artifact-annotation-script';

/**
 * The annotation script the opaque HTML-file frame loads from the app origin,
 * for the desktop and browser builds and their dev servers. No parent origin:
 * the frame's parent is the app that wrote it.
 */
export function artifactPickerPlugin(): Plugin {
  return {
    name: 'rally-artifact-frame-picker',
    generateBundle() {
      this.emitFile({ type:'asset', fileName:'annotation-frame.js', source:artifactAnnotationScript(null) });
    },
    configureServer(server) {
      server.middlewares.use('/annotation-frame.js', (_request,response) => {
        response.setHeader('Content-Type','application/javascript; charset=utf-8');
        response.end(artifactAnnotationScript(null));
      });
    },
  };
}
