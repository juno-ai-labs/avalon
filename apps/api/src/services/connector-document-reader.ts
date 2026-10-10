import type { ConnectorDocumentReader } from "@rally/connectors";
import type { Env } from "../env";
import {
  ATTACHMENT_MAX_SOURCE_BYTES,
  attachmentTextFormat,
  buildAttachmentDerivative,
  ocrPdfWithWorkersAi,
} from "./attachment-derivative-service";

/**
 * The attachment converter as the reader the connector registry hands
 * adapters (see `documents.ts` in `@rally/connectors`). OCR is metered to the
 * workspace of the connection the file was read through.
 */
export function connectorDocumentReader(env: Env): ConnectorDocumentReader {
  return {
    maxSourceBytes: ATTACHMENT_MAX_SOURCE_BYTES,
    reads: (file) => attachmentTextFormat(file.mimeType, file.fileName) !== null,
    async read(file) {
      const result = await buildAttachmentDerivative({
        bytes: file.bytes,
        fileName: file.fileName,
        mimeType: file.mimeType,
        signal: file.signal,
        // The derivative ceiling exists so a stored derivative can be read
        // back whole; a connector read keeps only its caller's text budget,
        // which `readConnectorDocument` applies.
        maxTextCharacters: null,
        ...(env.DOCUMENT_PROCESSOR
          ? { pdfExtractor: (bytes: Uint8Array) => env.DOCUMENT_PROCESSOR.extractText(bytes) }
          : {}),
        ...(env.AI
          ? {
              ocr: (bytes: Uint8Array, pageCount: number) => ocrPdfWithWorkersAi(env.AI, file.fileName, bytes, pageCount, file.signal, {
                env,
                workspaceId: file.connection.workspaceId,
                sourceId: `connection:${file.connection.id}`,
              }),
            }
          : {}),
      });
      return result.status === "ready" ? { ok: true, text: result.text } : { ok: false, code: result.errorCode };
    },
  };
}
