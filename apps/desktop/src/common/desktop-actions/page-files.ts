import type { StoredRef } from '@rally/contracts/desktop-actions';

export interface PageDownload {
  url: string;
  name: string;
  mimeType?: string;
  expectedSize?: number;
  request?: RequestInit;
}

// LIMIT UNSET: maximum concurrent page downloads, response bodies and base64 conversions.
// Without it: a conversation's files all allocate decoded bytes beside the retained base64 results.
// On trip: later downloads wait; every file still returns a source-ordered outcome.
// Derive from: team-selected peak-memory budget, maximum file bytes and retained result bytes.
// Safe open: preserves the existing fan-out until the team selects the width.
export const MAX_PAGE_PARALLEL_DOWNLOADS = Number.POSITIVE_INFINITY;

/** Self-contained so pageScript can embed it beside the page's own store. */
export async function downloadPageFiles(
  files: PageDownload[],
  maxFileBytes: number,
  store: (value: Blob, options: { name: string; mimeType?: string }) => Promise<StoredRef>,
  concurrency: number,
): Promise<Array<StoredRef | { unavailable: { name: string; reason: string } }>> {
  const download = async (file: PageDownload) => {
    try {
      const response = await fetch(file.url, file.request);
      if (!response.ok) throw new Error(`File download returned HTTP ${response.status}.`);
      const declared = Number(response.headers.get('content-length'));
      if (declared > maxFileBytes) throw new Error(`${file.name} is larger than the ${maxFileBytes}-byte file limit.`);
      const bytes = await response.blob();
      if (bytes.size > maxFileBytes) throw new Error(`${file.name} is larger than the ${maxFileBytes}-byte file limit.`);
      if (file.expectedSize !== undefined && bytes.size !== file.expectedSize) {
        throw new Error(`File size mismatch: expected ${file.expectedSize} bytes, received ${bytes.size}. Retrieve the original file.`);
      }
      return await store(bytes, { name: file.name, ...(file.mimeType ? { mimeType: file.mimeType } : {}) });
    } catch (error) {
      return { unavailable: { name: file.name, reason: error instanceof Error ? error.message : String(error) } };
    }
  };
  const results: Array<StoredRef | { unavailable: { name: string; reason: string } }> = [];
  // Keep this queue self-contained: pageScript embeds the function's source.
  for (let offset = 0; offset < files.length; offset += concurrency) {
    results.push(...await Promise.all(files.slice(offset, offset + concurrency).map(download)));
  }
  return results;
}
