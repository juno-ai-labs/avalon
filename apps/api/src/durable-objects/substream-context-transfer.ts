import { WORKSTREAM_REALTIME_MAX_FRAME_BYTES, type ServerSocketEvent } from "@rally/contracts";
import type { SubstreamInitialContext } from "@rally/contracts/substream-creation";

type ContextChunk = Extract<ServerSocketEvent, { type: "initial_context_snapshot_chunk" }>;
type TransferAddress = Pick<ContextChunk, "sequence" | "snapshotId" | "occurredAt">;

/** The transport ceiling bounds frames, never the amount of inherited history. */
export function initialContextFrames(context: SubstreamInitialContext | null, address: TransferAddress): ContextChunk[] {
  if (!context) return [];
  const envelope: ContextChunk = {
    ...address, type: "initial_context_snapshot_chunk", json: "",
    chunkIndex: Number.MAX_SAFE_INTEGER, chunkCount: Number.MAX_SAFE_INTEGER,
  };
  const overhead = new TextEncoder().encode(JSON.stringify(envelope)).byteLength;
  // A UTF-16 code unit needs at most six JSON-escaped bytes (including a
  // surrogate split at the frame boundary). Reassembly joins code units first.
  const codeUnitsPerFrame = Math.floor((WORKSTREAM_REALTIME_MAX_FRAME_BYTES - overhead) / 6);
  if (codeUnitsPerFrame <= 0) throw new Error("substream_context_frame_envelope_too_large");
  const json = JSON.stringify(context);
  const count = Math.ceil(json.length / codeUnitsPerFrame);
  return Array.from({ length: count }, (_, index) => ({
    ...address, type: "initial_context_snapshot_chunk", chunkIndex: index, chunkCount: count,
    json: json.slice(index * codeUnitsPerFrame, (index + 1) * codeUnitsPerFrame),
  }));
}
