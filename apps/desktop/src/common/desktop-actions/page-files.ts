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
  maxFileBytes: number,
  store: (value: Blob, options: { name: string; mimeType?: string }) => Promise<StoredRef>,
): Promise<Array<StoredRef | { unavailable: { name: string; reason: string } }>> {
  return await Promise.all(files.map(async (file) => {
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
  }));
}
