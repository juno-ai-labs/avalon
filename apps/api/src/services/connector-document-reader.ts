import type { ConnectorDocumentReader } from "@rally/connectors";
import type { Env } from "../env";
import {
  ATTACHMENT_MAX_SOURCE_BYTES,
  attachmentTextFormat,
  buildAttachmentDerivative,
  ocrPdfWithWorkersAi,
} from "./attachment-derivative-service";

/**
 * The attachment converter, as the document reader the connector registry
 * hands every adapter that can reach a provider file.
 *
 * It is the same conversion an uploaded attachment gets — plain text, Word,
 * Excel, PowerPoint and a PDF's text layer — so a file reads identically
 * whether someone uploaded it or the agent found it in Drive, a Slack thread or
 * any other connector. That includes OCR of a scanned PDF, metered to the
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
