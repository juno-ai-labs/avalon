import { sourceConnectionCardId, type ConnectorConnectionCardId, type SidekickSourceRequestView, type SidekickSourcesResult } from '@rally/contracts';
import {
  SidekickSourceRequestCardView,
  SidekickWakesOnList,
  SourceDecisionButtons,
  type SourceAsk,
  type SourceDecision,
  type WakeTrigger,
} from '@rally/ui/components/sidekick-sources';
import { useMutation, useQuery, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { OAuthConnectorProviderCatalogEntry } from '../lib/connector-catalog';
import { connectorConnectionCardProvider, useConnectorConnectionAction } from './connector-mentions';
import { useCollaborationSession, type CollaborationSessionValue } from '../lib/collaboration-session';
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
 * details' Wakes on section.
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

/** What the reader's own waiting request offers in Approve's place. */
type ConnectPlan =
  | { kind: 'button'; connectorId: ConnectorConnectionCardId; provider: OAuthConnectorProviderCatalogEntry; verb: string; connector: string }
  | { kind: 'note'; text: string };

/**
 * Whether this client can connect the request's account here, decided before
 * anything mounts: the connection hook only runs for a provider it can start.
 */
function connectPlan(request: SidekickSourceRequestView, collaboration: CollaborationSessionValue): ConnectPlan {
  // The server says which connection carries these events; an older view falls back to working it out here.
  const connect = request.connect ?? { scope: 'personal' as const, card: sourceConnectionCardId(request.connectorType, request.eventTypes) };
  const verb = request.connection === 'reconnect_required' ? 'Reconnect' : 'Connect';
  const { connector } = sourceWords(request);
  // Events that arrive only on the Organization's connection wait on an administrator, not on this press.
  if (connect.scope === 'workspace') return { kind: 'note', text: `Needs an admin to ${verb.toLowerCase()} ${connector} for the Organization in Settings` };
  const inSettings = { kind: 'note', text: `${verb} ${connector} in Settings, then approve here` } as const;
  if (!connect.card || !collaboration.connectorSetup) return inSettings;
  const provider = connectorConnectionCardProvider({ connectorId: connect.card, scope: 'personal' });
  if (!provider) return inSettings;
  return { kind: 'button', connectorId: connect.card, provider, verb, connector };
}

/**
 * "Connect Gmail and approve" in Approve's place. The press starts a sign-in
 * and hands the card that attempt's id; the card approves only once that
 * attempt succeeds and the request reads connected. A connection made any
 * other way is not consent, so it only brings back the ordinary Approve.
 */
function ConnectAndApproveButton({ plan, request, deciding, cancelled, onStarted, onStartFailed, onAttemptEnded }: {
  plan: Extract<ConnectPlan, { kind: 'button' }>;
  request: SidekickSourceRequestView;
  /** An answer to this request is in flight. */
  deciding: boolean;
  /** The last sign-in this card started ended without a connection. */
  cancelled: boolean;
  onStarted: (attemptId: string) => void;
  onStartFailed: () => void;
  /** The sign-in this button waited on is no longer the one waited on: the card reads how it ended. */
  onAttemptEnded: () => void;
}): React.JSX.Element {
  const { connector, verb } = plan;
  const action = useConnectorConnectionAction({ connectorId: plan.connectorId, scope: 'personal' }, plan.provider, { onNewlyConnected: onAttemptEnded });
  const waitedOn = useRef<string | null>(null);
  const attemptId = action.attemptId;
  useEffect(() => {
    if (attemptId) { waitedOn.current = attemptId; return; }
    if (!waitedOn.current) return;
    waitedOn.current = null;
    onAttemptEnded();
  }, [attemptId, onAttemptEnded]);
  const label = deciding ? 'Approving…' : action.pending ? `Waiting for ${connector}…` : `${verb} ${connector} and approve`;
  const blocked = action.pending || deciding || action.unavailable || action.accountRequired;
  return <span className="source-connect-and-approve">
    {action.accountOptions && <select
      aria-label={`${connector} account to reconnect`}
      disabled={action.pending || deciding}
      onChange={(event) => action.selectAccount(event.currentTarget.value)}
      value={action.selectedAccountId}
    >
      <option value="">Choose an account</option>
      {action.accountOptions.map((connection) => <option key={connection.id} value={connection.id}>{connection.displayName}</option>)}
    </select>}
    {/* aria-disabled, not disabled: a press must not drop keyboard focus, and the label is the state. */}
    <Button
      aria-busy={action.pending || deciding || undefined}
      aria-disabled={blocked || undefined}
      className="source-decision-button source-connect-and-approve-button button-primary"
      onClick={() => {
        if (blocked) return;
        action.start().then(onStarted, onStartFailed);
      }}
    >{label}{' '}<span className="sr-only">your {connector} for {request.sidekickName}</span></Button>
    {action.unavailable && !action.checkingAvailability && <small className="source-request-connect-settings">{connector} can’t be connected right now.</small>}
    {cancelled && !action.pending && <small className="source-request-connect-settings" role="status">{connector} wasn’t connected, so nothing was approved. Try again when you’re ready.</small>}
    {action.error && <ErrorNotice title={`${connector} could not be connected`}>{action.error}</ErrorNotice>}
  </span>;
}

/**
 * A press's consent: the sign-in it started, and once that sign-in has been
 * read as succeeded, when. Held by the card, which stays mounted, because the
 * button leaves the moment the request reads connected.
 */
interface Consent {
  attemptId: string;
  succeededAt: number | null;
  reading: boolean;
}

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
  const collaboration = useCollaborationSession();
  const { api, session } = collaboration;
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
  const decideMutate = decide.mutate;
  const queryClient = useQueryClient();
  const consents = useRef(new Map<string, Consent>());
  const [cancelled, setCancelled] = useState<ReadonlySet<string>>(() => new Set());
  const forget = useCallback((requestId: string, sawCancel = false) => {
    consents.current.delete(requestId);
    setCancelled((current) => {
      if (current.has(requestId) === sawCancel) return current;
      const next = new Set(current);
      if (sawCancel) next.add(requestId); else next.delete(requestId);
      return next;
    });
  }, []);
  const reread = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: sidekickSourcesQueryKey(card.sidekickId) });
  }, [queryClient, card.sidekickId]);
  const live = query.data !== undefined && !query.isPlaceholderData ? query.data : undefined;
  const readAt = query.dataUpdatedAt;
  // Each consent is spent once: approved when its own sign-in succeeded and the request reads
  // connected; dropped when that sign-in failed, or succeeded and a later read still is not connected.
  useEffect(() => {
    if (!live || !api) return;
    for (const request of live) {
      const consent = consents.current.get(request.requestId);
      if (!consent || consent.reading) continue;
      if (request.state !== 'pending') { forget(request.requestId); continue; }
      if (consent.succeededAt !== null) {
        if (request.connection === 'connected') { forget(request.requestId); decideMutate({ request, decision: 'approve' }); }
        else if (readAt >= consent.succeededAt) forget(request.requestId);
        continue;
      }
      consent.reading = true;
      api.getConnectorOAuthAttempt(consent.attemptId).then((attempt) => {
        consent.reading = false;
        if (consents.current.get(request.requestId) !== consent || attempt.status === 'pending') return;
        if (attempt.status !== 'succeeded') { forget(request.requestId, true); return; }
        consent.succeededAt = Date.now();
        if (request.connection === 'connected') { forget(request.requestId); decideMutate({ request, decision: 'approve' }); }
        else reread();
      }, () => {
        // Kept: the next read of the request (focus, reconnect, a push) asks again.
        consent.reading = false;
      });
    }
  }, [live, readAt, api, decideMutate, forget, reread]);
  const deciding = decidingOf(decide);
  return <>
    <SidekickSourceRequestCardView
      connectStep={(request) => {
        const plan = connectPlan(request, collaboration);
        if (plan.kind === 'note') return { connectsHere: false, control: <span className="source-request-connect-settings">{plan.text}</span> };
        return { connectsHere: true, control: <ConnectAndApproveButton
          cancelled={cancelled.has(request.requestId)}
          deciding={deciding?.requestId === request.requestId}
          onAttemptEnded={reread}
          onStartFailed={() => forget(request.requestId)}
          onStarted={(attemptId) => {
            forget(request.requestId);
            consents.current.set(request.requestId, { attemptId, succeededAt: null, reading: false });
          }}
          plan={plan}
          request={request}
        /> };
      }}
      deciding={deciding}
      // A stored row's read failure waits to be asked for; it never interrupts a scroll.
      details={query.error && <ErrorNotice automatic={false} detailsLabel="Details" occurrence={query.error} title="The request could not be loaded">
        {query.error.message}
      </ErrorNotice>}
      live={query.data !== undefined && !query.isPlaceholderData}
      onDecide={(request, decision) => {
        if (decision === 'decline') forget(request.requestId);
        decideMutate({ request, decision });
      }}
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
  const decide = useSourceDecision();
  const answered = decide.data?.state;
  return <>
    <SourceDecisionButtons
      deciding={decide.isPending ? decide.variables.decision : null}
      onDecide={(decision) => decide.mutate({ request, decision })}
      state={answered === 'approved' || answered === 'declined' ? answered : 'pending'}
      subject={`your ${sourceWords(request).connector}${sidekickName ? ` for ${sidekickName}` : ''}`}
    />
    <DecisionRefusal decide={decide} />
  </>;
}

/**
 * The Sidekick details' Wakes on section with each trigger's accounts, from
 * `GET /sidekicks/:id/sources`. It shares the Sidekick's cache key, so the
 * invalidations a Sidekick already gets reach it, and it re-reads on focus
 * and reconnect as delegation does.
 */
export function SidekickWakesOn({ id, triggers, next }: {
  id: string;
  /** The Sidekick's triggers, as its details build them. */
  triggers: readonly WakeTrigger[];
  /** The next scheduled run. */
  next?: ReactNode;
}): React.JSX.Element {
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
    <SidekickWakesOnList
      data={query.data}
      deciding={decidingOf(decide)}
      loading={query.isPending}
      next={next}
      onDecide={(request, decision) => decide.mutate({ request, decision })}
      onWithdraw={(connectionId) => withdraw.mutate(connectionId)}
      triggers={triggers}
      withdrawing={withdraw.isPending ? withdraw.variables : null}
      words={sourceWords}
    />
    {query.error && <Button onClick={() => void query.refetch()}>Refresh accounts</Button>}
    {query.error && <ErrorNotice occurrence={query.error} title="Accounts could not be loaded">{query.error.message}</ErrorNotice>}
    <DecisionRefusal decide={decide} />
    {withdraw.error && <ErrorNotice occurrence={withdraw.error} title="The source could not be withdrawn">
      {sourceRefusal(withdraw.error)}
    </ErrorNotice>}
  </>;
}
