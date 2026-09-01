import { WorkerEntrypoint } from "cloudflare:workers";

import type {
  DocumentProcessingRpcBinding,
  PdfTextExtraction,
} from "./services/document-processing-contract";
import {
  buildGifStoryboard,
  decodeTiffToPng,
  extractPdfText,
} from "./services/document-processing-codecs";

/**
 * A separate static module graph for PDF.js. Service Bindings execute in the
 * caller's Cloudflare location without exposing an HTTP origin.
 */
export default class DocumentProcessingWorker
  extends WorkerEntrypoint
  implements DocumentProcessingRpcBinding {
  /** Cloudflare requires a named handler even when only RPC is reachable. */
  override fetch(): Response {
    return new Response(null, { status: 404 });
  }

  async extractText(bytes: Uint8Array): Promise<PdfTextExtraction> {
    return extractPdfText(bytes);
  }

  async buildGifStoryboard(bytes: Uint8Array) {
    return buildGifStoryboard(bytes);
  }

  async decodeTiffToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
    return decodeTiffToPng(bytes);
  }
}
