import { z } from 'zod';
import { MAX_STORED_FILE_BYTES } from './store';

const PageStoredSchema = z.object({
  handle: z.string().min(1),
  kind: z.enum(['file', 'json']),
  name: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  data: z.string(),
});

/**
 * What page script answers. Electron replaces an error thrown in page script
 * with a generic message, so every outcome comes back as a value: the script's
 * own error text included, which is what lets the agent fix its script.
 *
 * Parsed, not cast: the script runs in the page's world, so the page's own
 * code can shape what comes back.
 */
export const PageScriptOutcomeSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown(), stored: z.array(PageStoredSchema), url: z.string(), title: z.string() }),
  z.object({ ok: z.literal(false), code: z.enum(['script_error', 'value_not_serializable', 'file_too_large']), message: z.string() }),
]);

export type PageScriptOutcome = z.infer<typeof PageScriptOutcomeSchema>;
export type PageStored = z.infer<typeof PageStoredSchema>;

/**
 * Wrap an agent's script as one page-script expression.
 *
 * The script is the body of an async function given `rally`, whose `store`
 * keeps a value with the desktop and returns only its description. Files are
 * read to base64 in the page, held to the file cap before they are read, and
 * drained with the call's answer, so nothing is left in the page between
 * calls. The body is spliced in as source rather than compiled with
 * `new Function`, which the providers' content security policies refuse; a
 * syntax error therefore fails the whole expression, and the caller reports
 * that as a script error.
 */
export function pageScript(body: string): string {
  return `(async () => {
    const maxFileBytes = ${MAX_STORED_FILE_BYTES};
    const pending = [];
    let sequence = 0;
    class RallyStoreError extends Error {}
    const base64 = (blob) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/u, ''));
      reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'));
      reader.readAsDataURL(blob);
    });
    const rally = Object.freeze({
      async store(value, options = {}) {
        const name = typeof options.name === 'string' && options.name ? options.name : 'file';
        const handle = 'h' + Date.now().toString(36) + '-' + (sequence += 1).toString(36) + '-' + Math.random().toString(36).slice(2, 8);
        if (value instanceof Response) {
          const declared = Number(value.headers.get('content-length'));
          if (declared > maxFileBytes) throw new RallyStoreError(name + ' is larger than the ' + maxFileBytes + '-byte file limit.');
          value = await value.blob();
        }
        if (typeof value === 'string' && typeof options.mimeType === 'string' && options.mimeType !== 'application/json') {
          value = new Blob([value], { type: options.mimeType });
        }
        if (value instanceof Blob) {
          if (value.size > maxFileBytes) throw new RallyStoreError(name + ' is larger than the ' + maxFileBytes + '-byte file limit.');
          const mimeType = typeof options.mimeType === 'string' && options.mimeType ? options.mimeType : value.type || 'application/octet-stream';
          pending.push({ handle, kind: 'file', name, mimeType, size: value.size, data: await base64(value) });
          return { handle, kind: 'file', name, mimeType, size: value.size };
        }
        const data = JSON.stringify(value === undefined ? null : value);
        pending.push({ handle, kind: 'json', name, mimeType: 'application/json', size: data.length, data });
        return { handle, kind: 'json', name, mimeType: 'application/json', size: data.length };
      },
    });
    try {
      const value = await (async (rally) => {
${body}
      })(rally);
      let serialized;
      try {
        serialized = JSON.stringify(value === undefined ? null : value);
      } catch (error) {
        return { ok: false, code: 'value_not_serializable', message: String(error && error.message || error) };
      }
      return { ok: true, value: JSON.parse(serialized ?? 'null'), stored: pending, url: location.href, title: document.title };
    } catch (error) {
      return {
        ok: false,
        code: error instanceof RallyStoreError ? 'file_too_large' : 'script_error',
        message: String(error && (error.stack || error.message) || error),
      };
    }
  })()`;
}
