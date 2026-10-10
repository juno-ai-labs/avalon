import { readResponseBytes } from "./provider-utils";
import { ConnectorError } from "./types";

/**
 * Reading a file a connector found — a Drive file, a Slack upload, a Linear
 * comment attachment — as model text.
 *
 * Every connector that can reach a file has the same problem: the provider
 * hands back bytes, and only some of them are text. The host owns one
 * converter (the attachment pipeline's, so a file reads the same uploaded or
 * found through a connector) and passes it to the registry as a
 * `ConnectorDocumentReader`. An adapter never parses a format itself: it
 * describes the file, says how to download it, and calls
 * `readConnectorDocument`, which owns the size ceiling, the bounded download,
 * the conversion and the text budget.
 */

/** What a connector knows about a file before reading any of its bytes. */
export interface ConnectorFile {
  fileName: string;
  /** The provider's declared type. Null or `application/octet-stream` falls back to the extension. */
  mimeType: string | null;
  /** The provider's declared size in bytes, when it gives one. */
  size?: number | null;
}

/** The host's converter, as the registry hands it to adapters. */
export interface ConnectorDocumentReader {
  /** The largest source file `read` accepts. Larger files are never downloaded. */
  maxSourceBytes: number;
  /** Whether `read` understands this file, decided before downloading it. */
  reads(file: ConnectorFile): boolean;
  /**
   * The file's text, or the code naming why it could not be read. `connection`
   * says whose read this is, so a conversion that costs something (OCR of a
   * scanned PDF) is billed to that workspace.
   */
  read(file: ConnectorFile & {
    bytes: Uint8Array;
    signal: AbortSignal;
    connection: ConnectorDocumentConnection;
  }): Promise<
    { ok: true; text: string } | { ok: false; code: string }
  >;
}

/** The connection a file was read through. */
export interface ConnectorDocumentConnection {
  id: string;
  workspaceId: string;
}

/** A read file's content fields, in the shape connector tool outputs carry. */
export type ConnectorDocumentContent = {
  textContent: string | null;
  contentIncluded: boolean;
  /** Source bytes downloaded. */
  contentBytes?: number;
  contentTruncated?: boolean;
  contentNotice?: string;
  contentOmittedReason?: string;
};

/**
 * Download a provider file and return its text, bounded for model context.
 *
 * The source is bounded by what the converter accepts, not by the text budget:
 * a deck is mostly images, so its file size says little about its text. The
 * text is then cut to `textBudgetBytes` rather than refused, because the start
 * of a long workbook still answers most questions about it, and
 * `contentTruncated` says that more exists. `download` is called at most once,
 * and only when the file is one the reader understands and is small enough.
 */
export async function readConnectorDocument(input: {
  reader: ConnectorDocumentReader;
  file: ConnectorFile;
  connection: ConnectorDocumentConnection;
  textBudgetBytes: number;
  signal: AbortSignal;
  download: () => Promise<Response>;
}): Promise<ConnectorDocumentContent> {
  const { reader, file } = input;
  const tooLarge: ConnectorDocumentContent = {
    textContent: null,
    contentIncluded: false,
    contentOmittedReason: `File exceeds the ${reader.maxSourceBytes}-byte document conversion limit`,
  };
  if (!reader.reads(file)) {
    return { textContent: null, contentIncluded: false, contentOmittedReason: "resource_format_unsupported" };
  }
  if (file.size != null && Number.isFinite(file.size) && file.size > reader.maxSourceBytes) return tooLarge;
  let bytes: Uint8Array;
  try {
    bytes = await readResponseBytes(await input.download(), reader.maxSourceBytes);
  } catch (error) {
    if (error instanceof ConnectorError && error.code === "payload_too_large") return tooLarge;
    throw error;
  }
  const converted = await reader.read({
    ...file,
    bytes,
    signal: input.signal,
    connection: { id: input.connection.id, workspaceId: input.connection.workspaceId },
  });
  if (!converted.ok) {
    return {
      textContent: null,
      contentIncluded: false,
      contentOmittedReason: `The file could not be read as a document: ${converted.code}`,
    };
  }
  // Every character is at least one UTF-8 byte, so a prefix of the budget's
  // length in characters holds everything the budget can take, and a very
  // long text is never encoded whole.
  const prefix = new TextEncoder().encode(converted.text.slice(0, input.textBudgetBytes));
  if (converted.text.length <= input.textBudgetBytes && prefix.byteLength <= input.textBudgetBytes) {
    return { textContent: converted.text, contentIncluded: true, contentBytes: bytes.byteLength, contentTruncated: false };
  }
  return {
    textContent: new TextDecoder().decode(prefix.subarray(0, input.textBudgetBytes)).replace(/\uFFFD$/u, ""),
    contentIncluded: true,
    contentBytes: bytes.byteLength,
    contentTruncated: true,
    contentNotice: `Only the first ${input.textBudgetBytes} bytes of the document's ${converted.text.length}-character text are included`,
  };
}
