import { sourceConnectionCardId, type SidekickSourceRequestView, type SidekickSourcesResult } from '@rally/contracts';
import {
  SidekickSourceRequestCardView,
  SidekickSourcesList,
  SourceDecisionButtons,
  type SourceAsk,
  type SourceConnectStep,
  type SourceDecision,
} from '@rally/ui/components/sidekick-sources';
import { useMutation, useQuery, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { ConnectorConnectionCard, ConnectorConnectionsProvider } from './connector-mentions';
import { useCollaborationSession } from '../lib/collaboration-session';
import {
  applyDecidedSourceRequest,
  sidekickSourceRequestsQueryKey,
  sidekickSourcesQueryKey,
  sourceRefusal,
  sourceWords,
} from '../lib/sidekick-sources';
import type { SidekickSourceRequestCardInput } from '../lib/sidekick-source-request-card';
import { Button, ErrorNotice } from './primitives';

/**
 * The desktop and browser adapter for Sidekick sources
 * (`docs/sidekick-sources.md`): the reads, the asked person's own answer, and
 * a person's own withdrawal, behind the shared presentation. Three surfaces
 * mount it: the card in a conversation, the Activity row and the Sidekick
 * panel's Sources section.
 */

/** One request, as much of it as an answer and its refusal need. */
interface DecidableRequest extends SourceAsk {
  sidekickId: string;
  requestId: string;
}

type Decide = UseMutationResult<SidekickSourceRequestView, Error, { request: DecidableRequest; decision: SourceDecision }>;

/**
 * The asked person's Approve or Decline, the same call from every surface.
 * The acknowledged answer is written into every open read of the request, so
 * the card, the panel and the row agree without waiting on a push. A refusal
 * re-reads the request (it may have been answered or replaced elsewhere) and
 * names itself through the error popup.
 *
 * `networkMode: 'always'`: an answer is consent, sent by a press while online
 * or not at all. The default would hold an offline press and send it on
 * reconnect, after the person had stopped looking at what they agreed to.
 */
function useSourceDecision(): Decide {
  const { api } = useCollaborationSession();
  const queryClient = useQueryClient();
  return useMutation({
    networkMode: 'always',
    mutationFn: ({ request, decision }) => api!.decideSidekickSourceRequest(request.sidekickId, request.requestId, decision),
    onSuccess: (decided) => applyDecidedSourceRequest(queryClient, decided),
    onError: (_error, { request }) => queryClient.invalidateQueries({ queryKey: sidekickSourcesQueryKey(request.sidekickId) }),
  });
}

/**
 * The asked person's own connect or reconnect, above their Approve: the same
 * card a conversation draws when an agent asks for a connection, so a person
 * who never connected the account, or whose sign-in lapsed, settles the
 * request in one place. It reads the viewer's own connections under the key
 * the conversation already uses, and once the account works it re-reads the
 * Sidekick's sources, which unlocks Approve. A connector no card connects
 * (a webhook, a custom server) is pointed at Settings.
 */
function SourceConnectionStep({ request }: { request: SidekickSourceRequestView }): React.JSX.Element {
  const { api } = useCollaborationSession();
  const queryClient = useQueryClient();
  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: ({ signal }) => api!.getConnections(signal),
    enabled: Boolean(api),
    staleTime: 60_000,
  });
  const connected = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: sidekickSourcesQueryKey(request.sidekickId) });
  }, [queryClient, request.sidekickId]);
  const connectorId = sourceConnectionCardId(request.connectorType, request.eventTypes);
  if (!connectorId) {
    return <p className="source-request-connect-settings">
      {request.connection === 'reconnect_required' ? 'Reconnect' : 'Connect'} your {sourceWords(request).connector} account in Settings, then approve here.
    </p>;
  }
  return <ConnectorConnectionsProvider connections={connections.data}>
    <ConnectorConnectionCard onConnected={connected} request={{ connectorId, scope: 'personal' }} />
  </ConnectorConnectionsProvider>;
}

const connectStep: SourceConnectStep = (request) => <SourceConnectionStep request={request} />;

function decidingOf(decide: Decide): { requestId: string; decision: SourceDecision } | null {
  return decide.isPending ? { requestId: decide.variables.request.requestId, decision: decide.variables.decision } : null;
}

function DecisionRefusal({ decide }: { decide: Decide }): React.JSX.Element | null {
  if (!decide.error) return null;
  return <ErrorNotice occurrence={decide.error} title="The request could not be answered">
    {sourceRefusal(decide.error, decide.variables?.request)}
  </ErrorNotice>;
}

/**
 * The card a `sidekick_request_source` call draws in its conversation. Where
 * each request stands is read from `POST /sidekicks/source-requests/read` by
 * the ids the tool answered, never from the tool's own output: that is the
 * asker's view at the moment of asking. Until the read lands the card paints
 * that output so the feed does not jump, with nothing pressable.
 *
 * It re-reads when the Sidekick's list row or one of this viewer's source
 * Activity rows moves (both arrive on the workspace socket and invalidate the
 * Sidekick's sources), and when the window regains focus or reconnects.
 */
export function SidekickSourceRequestCard({ card }: { card: SidekickSourceRequestCardInput }): React.JSX.Element {
  const { api, session } = useCollaborationSession();
  const viewerId = session?.user.id;
  // `yours` in the tool's output is the asker's; the viewer's is by who they are.
  const asked = useMemo(
    () => card.asked?.map((request) => ({ ...request, yours: request.person.userId === viewerId })),
    [card.asked, viewerId],
  );
  const query = useQuery({
    queryKey: sidekickSourceRequestsQueryKey(card.sidekickId, card.requestIds),
    queryFn: ({ signal }) => api!.readSidekickSourceRequests(card.requestIds, signal),
    enabled: Boolean(api),
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
    ...(asked ? { placeholderData: asked } : {}),
  });
  const decide = useSourceDecision();
  return <>
    <SidekickSourceRequestCardView
      connectStep={connectStep}
      deciding={decidingOf(decide)}
      // A stored row's read failure waits to be asked for; it never interrupts a scroll.
      details={query.error && <ErrorNotice automatic={false} detailsLabel="Details" occurrence={query.error} title="The request could not be loaded">
        {query.error.message}
      </ErrorNotice>}
      live={query.data !== undefined && !query.isPlaceholderData}
      onDecide={(request, decision) => decide.mutate({ request, decision })}
      // A failed read leaves what the tool answered on screen, unpressable,
      // or says the request is unavailable; it never reads as still loading.
      requests={query.data ?? (query.isError ? asked ?? [] : undefined)}
      words={sourceWords}
    />
    <DecisionRefusal decide={decide} />
  </>;
}

/**
 * Approve and Decline under the asked person's `source_request` Activity
 * row. The row is replaced by the Activity push the answer produces; until it
 * arrives the acknowledged choice is drawn filled and nothing can be pressed
 * twice.
 */
export function SourceRequestActions({ request, sidekickName }: {
  request: DecidableRequest;
  /** For the buttons' names, so two Sidekicks' requests differ; absent while the row has no title. */
  sidekickName: string | undefined;
}): React.JSX.Element {
  const { api } = useCollaborationSession();
  const decide = useSourceDecision();
  const answered = decide.data?.state;
  // The row carries no account state, so it reads the request as its card does, under the
  // card's key: one read serves both, and connecting re-reads it.
  const live = useQuery({
    queryKey: sidekickSourceRequestsQueryKey(request.sidekickId, [request.requestId]),
    queryFn: ({ signal }) => api!.readSidekickSourceRequests([request.requestId], signal),
    enabled: Boolean(api),
    refetchOnWindowFocus: true,
  }).data?.[0];
  const toMake = live?.state === 'pending' && live.connection !== undefined && live.connection !== 'connected' ? live.connection : null;
  return <>
    {toMake && live && <SourceConnectionStep request={live} />}
    <SourceDecisionButtons
      approveBlocked={toMake ? `${toMake === 'reconnect_required' ? 'Reconnect' : 'Connect'} ${sourceWords(request).connector} first` : undefined}
      deciding={decide.isPending ? decide.variables.decision : null}
      onDecide={(decision) => decide.mutate({ request, decision })}
      state={answered === 'approved' || answered === 'declined' ? answered : 'pending'}
      subject={`your ${sourceWords(request).connector}${sidekickName ? ` for ${sidekickName}` : ''}`}
    />
    <DecisionRefusal decide={decide} />
  </>;
}

/**
 * The Sidekick panel's Sources section, from `GET /sidekicks/:id/sources`. It
 * shares the Sidekick's cache key, so the invalidations a Sidekick already
 * gets reach it, and it re-reads on focus and reconnect as delegation does.
 */
export function SidekickSources({ id }: { id: string }): React.JSX.Element {
  const { api } = useCollaborationSession();
  const queryClient = useQueryClient();
  const queryKey = sidekickSourcesQueryKey(id);
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => api!.getSidekickSources(id, signal),
    enabled: Boolean(api),
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
  });
  const decide = useSourceDecision();
  // Consent again, in reverse: sent now or not at all (see `useSourceDecision`).
  const withdraw = useMutation({
    networkMode: 'always',
    mutationFn: (connectionId: string) => api!.withdrawSidekickSource(id, connectionId),
    onSuccess: (_result, connectionId) => {
      // Acknowledged either way: withdrawn now, or already gone.
      queryClient.setQueryData<SidekickSourcesResult>(queryKey, (current) => current && {
        ...current, sources: current.sources.filter((source) => !(source.yours && source.connectionId === connectionId)),
      });
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: () => queryClient.invalidateQueries({ queryKey }),
  });
  return <>
    <SidekickSourcesList
      connectStep={connectStep}
      data={query.data}
      deciding={decidingOf(decide)}
      loading={query.isPending}
      onDecide={(request, decision) => decide.mutate({ request, decision })}
      onWithdraw={(connectionId) => withdraw.mutate(connectionId)}
      withdrawing={withdraw.isPending ? withdraw.variables : null}
      words={sourceWords}
    />
    {query.error && <Button onClick={() => void query.refetch()}>Refresh sources</Button>}
    {query.error && <ErrorNotice occurrence={query.error} title="Sources could not be loaded">{query.error.message}</ErrorNotice>}
    <DecisionRefusal decide={decide} />
    {withdraw.error && <ErrorNotice occurrence={withdraw.error} title="The source could not be withdrawn">
      {sourceRefusal(withdraw.error)}
    </ErrorNotice>}
  </>;
}
