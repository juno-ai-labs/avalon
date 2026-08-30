import { extractText, getDocumentProxy } from "unpdf";
import UPNG from "upng-js";
import * as UTIF from "utif2";

import type { PdfTextExtraction } from "./document-processing-contract";
import { buildGifStoryboard } from "./gif-storyboard";

const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_PDF_PAGES = 200;

export async function extractPdfText(bytes: Uint8Array): Promise<PdfTextExtraction> {
  try {
    const pdf = await getDocumentProxy(bytes);
    try {
      if (pdf.numPages > MAX_PDF_PAGES) return { pageCount: pdf.numPages, pages: [] };
      const result = await extractText(pdf, { mergePages: false });
      return { pageCount: result.totalPages, pages: result.text };
    } finally {
      await pdf.cleanup();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    throw new Error(message.includes("password") ? "pdf_encrypted" : "invalid_pdf", { cause: error });
  }
}

export { buildGifStoryboard };

export function decodeTiffToPng(bytes: Uint8Array): Uint8Array | null {
  const buffer = exactArrayBuffer(bytes);
  const ifd = UTIF.decode(buffer)[0];
  if (!ifd) return null;
  const width = tiffTagNumber(ifd.width, ifd.t256);
  const height = tiffTagNumber(ifd.height, ifd.t257);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width <= 0 || height <= 0 || width * height > MAX_IMAGE_PIXELS) {
    throw new Error("Image dimensions exceed the safe model limit");
  }
  UTIF.decodeImage(buffer, ifd);
  const rgba = UTIF.toRGBA8(ifd);
  return new Uint8Array(UPNG.encode([exactArrayBuffer(rgba)], width, height, 0));
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function tiffTagNumber(decoded: number, tag: unknown): number {
  if (Number.isSafeInteger(decoded) && decoded > 0) return decoded;
  if (Array.isArray(tag) && typeof tag[0] === "number") return tag[0];
  return Number.NaN;
}
