import {
  TRANSCRIPT_OPERATIONS,
  type TranscriptObjectPort,
  type TranscriptOperation,
} from "../durable-objects/workstream-transcript-protocol";
import type { WorkstreamTranscriptStorage } from "../durable-objects/workstream-transcript-storage";
import type { Env } from "../env";
import { createObjectPort, type ObjectPortContract } from "./object-port";

const CONTRACT: ObjectPortContract<WorkstreamTranscriptStorage, TranscriptOperation> = {
  authority: "transcript",
  operations: TRANSCRIPT_OPERATIONS,
  dispatch: (stub, request) => stub.executeTranscriptOperation(request),
  failureCode: "transcript_operation_failed",
  failureMessage: "Rally's ordered transcript authority rejected an internal request.",
};

export function createTranscriptObjectPort(
  env: Env,
  workspaceId: string,
  workstreamId: string,
  localStorage?: WorkstreamTranscriptStorage,
  /** Which of the parent's conversations; the main one by default. */
  substreamId?: string,
): TranscriptObjectPort {
  return createObjectPort(env, workspaceId, workstreamId, CONTRACT, localStorage, substreamId);
}
