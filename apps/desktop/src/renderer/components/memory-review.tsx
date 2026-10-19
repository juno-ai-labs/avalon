import type { MemoryReview, MemoryReviewFact, MemoryReviewSource } from '@rally/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { ApiError, type RallyApi } from '../lib/api';
import { useNow } from '../lib/clock';
import { formatDayLabel } from '../lib/format';
import { channelRoute, threadRoute } from '../lib/navigation-routes';
import { Badge, Button, InlineError, LoadingState } from './primitives';

/** The two calls the panel makes, so a test hands it only those. */
export type MemoryReviewApi = Pick<RallyApi, 'getMyMemoryReview' | 'forgetMyMemory'>;

/** One heading's facts: the person's own, the Organization's, or one Channel's. */
interface FactGroup {
  key: string;
  heading: string;
  facts: MemoryReviewFact[];
}

/**
 * "What Rally remembers", at the top of a person's Personal Channel: their own
 * facts first, then the Organization's and those of the Channels they may open.
 * The server decides what is listed and what may be removed
 * (`docs/agent-memory.md`); this only draws it and sends a removal.
 */
export function MemoryReviewPanel({ api, workspaceId }: { api: MemoryReviewApi; workspaceId: string }): React.JSX.Element {
  const queryClient = useQueryClient();
  // Per Organization: another Organization's facts must never show while this one's read is in flight.
  const queryKey = ['memory-review', workspaceId];
  const review = useQuery({ queryKey, queryFn: ({ signal }) => api.getMyMemoryReview(signal) });
  const dropFact = (factId: string): void => {
    queryClient.setQueryData<MemoryReview>(queryKey, (current) => current && {
      own: current.own.filter((fact) => fact.factId !== factId),
      shared: current.shared.filter((fact) => fact.factId !== factId),
    });
  };
  const forget = useMutation({
    mutationFn: (factId: string) => api.forgetMyMemory(factId),
    onSuccess: (_result, factId) => dropFact(factId),
    // Already retracted, from another window or by the agent: it is gone, which is what was asked.
    onError: (error, factId) => {
      if (error instanceof ApiError && error.code === 'memory_fact_not_found') dropFact(factId);
    },
  });
  const failedFactId = forget.isError && !(forget.error instanceof ApiError && forget.error.code === 'memory_fact_not_found')
    ? forget.variables
    : null;
  const now = new Date(useNow());

  let body: React.ReactNode;
  if (review.data === undefined) {
    body = review.error
      ? <InlineError>What Rally remembers couldn’t be loaded.</InlineError>
      : <LoadingState label="Loading what Rally remembers…" />;
  } else {
    const groups = factGroups(review.data);
    body = groups.length === 0
      ? <p className="memory-review-empty">Rally has not remembered anything for you yet.</p>
      : groups.map((group) => <section aria-label={group.heading} className="memory-review-group" key={group.key}>
        <h3>{group.heading}</h3>
        <ul>
          {group.facts.map((fact) => <li className="memory-review-fact" key={fact.factId}>
            <div className="memory-review-fact-body">
              <p>
                {fact.text}
                {fact.conflict && <Badge className="memory-review-conflict">Disagreement</Badge>}
              </p>
              <p className="memory-review-fact-meta">
                <Horizon fact={fact} now={now} />
                <SourceLink source={fact.source} />
              </p>
              {failedFactId === fact.factId && <InlineError>{forgetFailure(forget.error)}</InlineError>}
            </div>
            {fact.removable && <Button
              aria-label={`Remove “${fact.text}”`}
              className="button-quiet"
              disabled={forget.isPending && forget.variables === fact.factId}
              onClick={() => forget.mutate(fact.factId)}
            >Remove</Button>}
          </li>)}
        </ul>
      </section>);
  }
  return <section aria-label="What Rally remembers" className="memory-review">
    <h2>What Rally remembers</h2>
    {body}
  </section>;
}

/** The person's own facts, then the Organization's, then one group per Channel in the order the server listed them. */
function factGroups(review: MemoryReview): FactGroup[] {
  const groups: FactGroup[] = [];
  if (review.own.length > 0) groups.push({ key: 'own', heading: 'About you', facts: review.own });
  const organization = review.shared.filter((fact) => fact.subjectKind !== 'channel');
  if (organization.length > 0) groups.push({ key: 'organization', heading: 'About the Organization', facts: organization });
  const channels = new Map<string, FactGroup>();
  for (const fact of review.shared) {
    if (fact.subjectKind !== 'channel') continue;
    // The contract names a Channel fact's subject by its title only.
    const title = fact.subjectTitle ?? '';
    let group = channels.get(title);
    if (!group) {
      group = { key: `channel:${title}`, heading: title ? `About ${title}` : 'About a channel', facts: [] };
      channels.set(title, group);
      groups.push(group);
    }
    group.facts.push(fact);
  }
  return groups;
}

/** A day as it reads mid-sentence: "until today", "until Oct 24". */
function dayPhrase(value: string, now: Date): string {
  const label = formatDayLabel(value, now);
  return label === 'Today' || label === 'Yesterday' ? label.toLowerCase() : label;
}

function Horizon({ fact, now }: { fact: MemoryReviewFact; now: Date }): React.JSX.Element | null {
  if (fact.expired) {
    return <span className="memory-review-expired">{fact.validUntil ? `Expired ${dayPhrase(fact.validUntil, now)}` : 'Expired'}</span>;
  }
  if (fact.upcoming && fact.validFrom) {
    return <span>{`From ${dayPhrase(fact.validFrom, now)}`}{fact.validUntil && ` until ${dayPhrase(fact.validUntil, now)}`}</span>;
  }
  if (fact.kind === 'situational' && fact.validUntil) return <span>{`Until ${dayPhrase(fact.validUntil, now)}`}</span>;
  return null;
}

const UNTITLED_SOURCE: Record<MemoryReviewSource['kind'], string> = {
  thread: 'a thread',
  breakout: 'a breakout',
  channel: 'a channel',
  sidekick: 'a Sidekick',
};

/** Where the fact was first learned. A Breakout opens inside its Thread. */
function SourceLink({ source }: { source: MemoryReviewSource }): React.JSX.Element {
  const title = source.title ?? UNTITLED_SOURCE[source.kind];
  const to = source.kind === 'thread' ? threadRoute(source.workstreamId, null)
    : source.kind === 'breakout' ? threadRoute(source.workstreamId, null, source.substreamId)
      : source.kind === 'channel' ? channelRoute(source.spaceId)
        : `/sidekicks/${encodeURIComponent(source.automationId)}`;
  return <span>from <Link className="memory-review-source" to={to}>{title}</Link></span>;
}

function forgetFailure(error: Error | null): string {
  if (error instanceof ApiError && error.code === 'memory_fact_not_removable') return 'Only an administrator can remove this.';
  return error instanceof ApiError ? error.message : 'Rally could not remove this. Try again.';
}
