import type { ConnectorDocumentReader } from "@rally/connectors";
import type { Env } from "../env";
import {
  ATTACHMENT_MAX_SOURCE_BYTES,
  attachmentTextFormat,
  buildAttachmentDerivative,
} from "./attachment-derivative-service";

/**
 * The attachment converter, as the document reader the connector registry
 * hands every adapter that can reach a provider file.
 *
 * It is the same conversion an uploaded attachment gets — plain text, Word,
 * Excel, PowerPoint and a PDF's text layer — so a file reads identically
 * whether someone uploaded it or the agent found it in Drive, a Slack thread or
 * any other connector. The one difference is OCR: a scanned PDF needs a metered
 * provider call that is billed against a stored resource, and a connector read
 * has no resource, so it fails as `pdf_ocr_required` instead.
 */
export function connectorDocumentReader(env: Pick<Env, "DOCUMENT_PROCESSOR">): ConnectorDocumentReader {
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
      });
      return result.status === "ready" ? { ok: true, text: result.text } : { ok: false, code: result.errorCode };
    },
  };
}
