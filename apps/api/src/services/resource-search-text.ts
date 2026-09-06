import { z } from 'zod';
import { classifyAttachmentKind } from '@rally/contracts';
import type { Env } from '../env';

function isSearchableText(fileName: unknown, mimeType: unknown): boolean {
  const kind = classifyAttachmentKind({
    fileName: typeof fileName === 'string' ? fileName : '',
    mimeType: typeof mimeType === 'string' ? mimeType : null,
  });
  return kind === 'text' || kind === 'markdown';
}

export function resourceSearchCategory(provider: unknown, canonicalUrl: unknown): 'files' | 'artifacts' | 'links' | null {
  if (provider === 'avalon_upload') return 'files';
  if (provider === 'avalon_generated') return 'artifacts';
  return typeof canonicalUrl === 'string' && /^https?:\/\//iu.test(canonicalUrl) ? 'links' : null;
}

/** The same canonical text and field order are used for indexing and match offsets. */
export async function resourceSearchText(env: Env, row: Record<string, unknown>): Promise<string> {
  let description = '';
  if (typeof row.metadata_json === 'string') {
    const metadata = z.object({ description: z.string().optional() }).safeParse(JSON.parse(row.metadata_json));
    if (metadata.success) description = metadata.data.description ?? '';
  }
  const derivative = isSearchableText('', row.model_mime_type) && typeof row.model_content_ref === 'string';
  const original = isSearchableText(row.title, row.mime_type);
  const ref = derivative ? row.model_content_ref : original ? row.content_ref : null;
  const body = typeof ref === 'string' ? await env.PAYLOADS.get(ref) : null;
  return [row.title, description, row.canonical_url, body ? await body.text() : '']
    .filter((part): part is string => typeof part === 'string' && part.length > 0).join('\n');
}
