import type { GifModelMetadata } from "./gif-metadata";

export interface PdfTextExtraction {
  pageCount: number;
  pages: string[];
}

/** Regional, non-HTTP Service Binding contract for the PDF codec Worker. */
export interface DocumentProcessingRpcBinding {
  extractText(bytes: Uint8Array): Promise<PdfTextExtraction>;
  buildGifStoryboard(bytes: Uint8Array): Promise<{
    bytes: Uint8Array;
    metadata: GifModelMetadata;
  } | null>;
  decodeTiffToPng(bytes: Uint8Array): Promise<Uint8Array | null>;
}
