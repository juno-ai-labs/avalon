import { extname } from 'node:path';
import type { Plugin, Rollup } from 'vite';
import { buildHelp, type HelpOutputs } from './site';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

/**
 * Publishes the Markdown in `contentRoot` as the help center under `/help/`.
 * `entryName` is the Rollup input whose script and stylesheet every page loads.
 * In `vite dev` each request re-reads the folder, drafts included, so a writer
 * sees a saved file on reload; a build that finds a broken page fails.
 */
export function helpCenter({ contentRoot, entryName, entrySource }: { contentRoot: string; entryName: string; entrySource: string }): Plugin {
  return {
    name: 'rally-help-center',
    configureServer(server) {
      server.watcher.add(contentRoot);
      server.watcher.on('all', (_event, file) => {
        if (file.startsWith(contentRoot)) server.ws.send({ type: 'full-reload' });
      });
      server.middlewares.use((request, response, next) => {
        const path = decodeURIComponent((request.url ?? '').split('?')[0] ?? '');
        if (!/^\/help(?:\/|$)/u.test(path)) return next();
        if (path === '/help') {
          response.statusCode = 301;
          response.setHeader('Location', '/help/');
          response.end();
          return;
        }
        let outputs: HelpOutputs;
        try {
          outputs = buildHelp(contentRoot, { includeDrafts: true, assets: { styles: [], scripts: ['/@vite/client', entrySource] } });
        } catch (error) {
          response.statusCode = 500;
          response.setHeader('Content-Type', 'text/plain; charset=utf-8');
          response.end((error as Error).message);
          return;
        }
        const key = path.slice(1);
        const body = outputs.get(path.endsWith('/') ? `${key}index.html` : key) ?? outputs.get(`${key}/index.html`);
        if (body === undefined) return next();
        response.setHeader('Content-Type', CONTENT_TYPES[extname(path) || '.html'] ?? 'application/octet-stream');
        response.end(body);
      });
    },
    generateBundle(_options, bundle) {
      const entry = Object.values(bundle).find(
        (output): output is Rollup.OutputChunk => output.type === 'chunk' && output.isEntry && output.name === entryName,
      );
      if (!entry) this.error(`rally-help-center: the ${entryName} entry is missing from the build`);
      const styles = [...(entry.viteMetadata?.importedCss ?? [])].map((file) => `/${file}`);
      const outputs = buildHelp(contentRoot, { assets: { styles, scripts: [`/${entry.fileName}`] } });
      for (const [fileName, source] of outputs) this.emitFile({ type: 'asset', fileName, source });
    },
  };
}
