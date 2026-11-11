import type { Plugin } from 'vite';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { describeZodIssues } from '../../packages/contracts/src/zod-diagnostics';
import { CANVAS_TEMPLATE_CATEGORIES } from './src/renderer/lib/canvas-template-categories';

const templateMetadata = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  tags: z.array(z.enum(CANVAS_TEMPLATE_CATEGORIES.map(({ tag }) => tag))).min(1),
});

/** Compile Markdown templates so the renderer can use them without a YAML parser. */
export function canvasTemplatePlugin(): Plugin {
  return {
    name: 'rally-canvas-template',
    enforce: 'pre',
    transform(source, id) {
      if (!/\.md\?canvas-template(?:&|$)/u.test(id)) return;
      const document = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n([\s\S]*)$/u.exec(source);
      if (!document) this.error('Expected YAML frontmatter followed by a Markdown prompt.');

      const metadata = templateMetadata.safeParse(parseYaml(document[1] ?? ''));
      if (!metadata.success) this.error(`Invalid template frontmatter (${describeZodIssues(metadata.error)}).`);

      const prompt = document[2]?.trim();
      if (!prompt) this.error('Expected a nonempty Markdown prompt.');

      return { code: `export default ${JSON.stringify({ ...metadata.data, prompt })};`, map: null };
    },
  };
}
