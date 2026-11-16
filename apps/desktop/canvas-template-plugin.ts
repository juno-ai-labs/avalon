import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

import { CANVAS_TEMPLATE_FILES, CANVAS_TEMPLATE_ROOT, loadCanvasTemplates } from '../../packages/skills/marketplace-skills/catalog';

const MODULE_ID = 'virtual:rally-canvas-templates';
const RESOLVED_ID = `\0${MODULE_ID}`;

/** Compile the Marketplace's Markdown templates so the renderer can use them without a YAML parser. */
export function canvasTemplatePlugin(): Plugin {
  return {
    name: 'rally-canvas-template',
    enforce: 'pre',
    resolveId: (id) => (id === MODULE_ID ? RESOLVED_ID : null),
    load(id) {
      if (id !== RESOLVED_ID) return null;
      for (const file of CANVAS_TEMPLATE_FILES) this.addWatchFile(fileURLToPath(new URL(file, CANVAS_TEMPLATE_ROOT)));
      try {
        return { code: `export default ${JSON.stringify(loadCanvasTemplates((file) => readFileSync(file, 'utf8')))};`, map: null };
      } catch (error) {
        this.error(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
