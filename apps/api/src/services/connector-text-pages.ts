import type { ConnectorTextPages } from "@rally/connectors";
import { ConnectorError } from "@rally/connectors";
import { ATTACHMENT_MAX_SOURCE_BYTES } from "./attachment-derivative-service";

/** Text snapshots have the same regional payload storage and source budget as attachments. */
export function connectorTextPages(
  bucket: Pick<R2Bucket, "put" | "get">,
  scope: { region: string; workspaceId: string; workstreamId: string; substreamId: string; connectionId: string },
  assertOwned: () => Promise<void>,
  signal?: AbortSignal,
): ConnectorTextPages {
  const prefix = `${scope.region}/${scope.workspaceId}/workstreams/${scope.workstreamId}/substreams/${scope.substreamId}/connector-text/${scope.connectionId}/`;
  function key(id: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id)) {
      throw new ConnectorError("invalid_payload", "textPage: the text snapshot is unavailable", { field: "textPage", reason: "text_snapshot_unavailable" });
    }
    return `${prefix}${id}.txt`;
  }
  return {
    maxSourceBytes: ATTACHMENT_MAX_SOURCE_BYTES,
    async write(bytes) {
      if (bytes.byteLength > ATTACHMENT_MAX_SOURCE_BYTES) throw new ConnectorError("payload_too_large", "The text exceeds the attachment source-file allowance", { reason: "source_too_large" });
      await assertOwned();
      const id = crypto.randomUUID();
      await bucket.put(key(id), bytes, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
      signal?.throwIfAborted();
      return id;
    },
    async read(id, offset, length) {
      signal?.throwIfAborted();
      const object = await bucket.get(key(id), { range: { offset, length } });
      if (!object) throw new ConnectorError("invalid_payload", "textPage: the text snapshot is unavailable; start a new read", { field: "textPage", reason: "text_snapshot_unavailable" });
      const bytes = new Uint8Array(await object.arrayBuffer());
      // The executing host fences result publication; do not repeat its RPCs for an R2 read.
      signal?.throwIfAborted();
      return { bytes, totalBytes: object.size };
    },
  };
}
