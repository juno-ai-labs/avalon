import { z } from "zod";
import { ConnectorError, type ConnectorTextPages } from "./types";

/** Private arguments: the first/next wrapper keeps them out of model input. */
export const ConnectorTextCursorSchema = z.strictObject({
  snapshotId: z.string().uuid(),
  offset: z.number().int().positive(),
  sourceTruncated: z.boolean().optional(),
}).describe("Private immutable text snapshot position supplied by receipt-owned continuation; never author it in a first-page call.");
export type ConnectorTextCursor = z.infer<typeof ConnectorTextCursorSchema>;

/** A UTF-8 page always ends on a character boundary, including at an emoji. */
export async function readConnectorTextPage(input: {
  text?: string | undefined;
  cursor?: ConnectorTextCursor | undefined;
  store?: ConnectorTextPages | undefined;
  pageBytes: number;
}) {
  let bytes: Uint8Array;
  let totalBytes: number;
  let snapshotId = input.cursor?.snapshotId;
  const startByte = input.cursor?.offset ?? 0;
  if (input.cursor) {
    if (!input.store) throw new ConnectorError("invalid_configuration", "Text continuation storage is unavailable");
    ({ bytes, totalBytes } = await input.store.read(input.cursor.snapshotId, startByte, input.pageBytes));
    if (startByte >= totalBytes) throw new ConnectorError("invalid_payload", "textPage: the snapshot position is unavailable", { field: "textPage", reason: "text_snapshot_unavailable" });
  } else {
    const source = new TextEncoder().encode(input.text ?? "");
    totalBytes = source.byteLength;
    bytes = source.subarray(0, input.pageBytes);
    if (totalBytes > input.pageBytes) {
      if (!input.store) throw new ConnectorError("invalid_configuration", "Text continuation storage is required to read this file completely");
      snapshotId = await input.store.write(source);
    }
  }
  const text = new TextDecoder().decode(bytes, { stream: startByte + bytes.byteLength < totalBytes });
  const endByte = startByte + new TextEncoder().encode(text).byteLength;
  const hasMore = endByte < totalBytes;
  return {
    text, bytes: endByte - startByte, startByte, totalBytes, hasMore,
    cursor: hasMore ? { snapshotId: snapshotId!, offset: endByte } : null,
  };
}
