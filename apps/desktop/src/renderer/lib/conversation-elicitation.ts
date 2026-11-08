import type { WorkstreamTranscriptSnapshot } from '@rally/contracts';
import type { QueryClient } from '@tanstack/react-query';

import {
  setTranscriptElicitationState,
  transcriptOverlaysQueryKey,
  upsertTranscriptOverlay,
  type TranscriptOverlay,
} from './transcript';
import { orderedTranscriptQueryKey, type WorkstreamSocketConnection } from './use-workstream-socket';

/**
 * Answers a conversation's open question through its socket, marking it
 * answered in both caches a feed composes (the canonical transcript and the
 * overlays the socket's `elicitation_created` writes) before the command goes,
 * and putting both back if it is refused. Every place that offers the answer
 * form uses this, so none can submit an answer twice while the room has not
 * yet said it was answered.
 */
export async function answerConversationElicitation({
  queryClient,
  parentId,
  substreamId,
  connection,
  elicitationId,
  answer,
  customResponse,
}: {
  queryClient: QueryClient;
  parentId: string;
  substreamId: string;
  connection: Pick<WorkstreamSocketConnection, 'answerElicitation'>;
  elicitationId: string;
  answer: string | string[] | null;
  customResponse?: string | undefined;
}): Promise<void> {
  const transcriptKey = orderedTranscriptQueryKey(parentId, substreamId);
  const overlaysKey = transcriptOverlaysQueryKey(parentId, substreamId);
  queryClient.setQueryData<WorkstreamTranscriptSnapshot>(transcriptKey, (current) =>
    current ? setTranscriptElicitationState(current, elicitationId, { status: 'answered', answer }) : current);
  const previous = queryClient.getQueryData<TranscriptOverlay[]>(overlaysKey)
    ?.find((overlay) => overlay.identity.type === 'elicitation' && overlay.identity.elicitationId === elicitationId);
  queryClient.setQueryData<TranscriptOverlay[]>(overlaysKey, (current) =>
    (current ?? []).map((overlay) => overlay.identity.type === 'elicitation'
      && overlay.identity.elicitationId === elicitationId
      && overlay.message.elicitation
      ? { ...overlay, message: { ...overlay.message, elicitation: { ...overlay.message.elicitation, status: 'answered', answer } } }
      : overlay));
  try {
    await connection.answerElicitation(elicitationId, answer, customResponse);
  } catch (error) {
    queryClient.setQueryData<WorkstreamTranscriptSnapshot>(transcriptKey, (current) =>
      current ? setTranscriptElicitationState(current, elicitationId, { status: 'open', answer: null }) : current);
    if (previous) queryClient.setQueryData<TranscriptOverlay[]>(overlaysKey, (current) => upsertTranscriptOverlay(current, previous));
    throw error;
  }
}
