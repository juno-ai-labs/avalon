import type { StoredRef } from '@rally/contracts/desktop-actions';

export interface PageDownload {
  url: string;
  name: string;
  mimeType?: string;
  expectedSize?: number;
  request?: RequestInit;
}

/** Self-contained so pageScript can embed it beside the page's own store. */
export async function downloadPageFiles(
  files: PageDownload[],
  store: (value: Blob, options: { name: string; mimeType?: string }) => Promise<StoredRef>,
): Promise<Array<StoredRef | { unavailable: { name: string; reason: string } }>> {
  return await Promise.all(files.map(async (file) => {
    try {
      const response = await fetch(file.url, file.request);
      if (!response.ok) throw new Error(`File download returned HTTP ${response.status}.`);
      const bytes = await response.blob();
      if (file.expectedSize !== undefined && bytes.size !== file.expectedSize) {
        throw new Error(`File size mismatch: expected ${file.expectedSize} bytes, received ${bytes.size}. Retrieve the original file.`);
      }
      return await store(bytes, { name: file.name, ...(file.mimeType ? { mimeType: file.mimeType } : {}) });
    } catch (error) {
      return { unavailable: { name: file.name, reason: error instanceof Error ? error.message : String(error) } };
    }
  }));
}
