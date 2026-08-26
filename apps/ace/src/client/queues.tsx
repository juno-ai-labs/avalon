import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, EmptyState } from './components/ui';

interface QueueMetrics {
  backlogBytes: number;
  backlogCount: number;
  oldestMessageTimestampMs: number | null;
}

interface DeadLetterQueue {
  id: string;
  name: string;
  sourceQueues: string[];
  metrics: QueueMetrics | null;
  metricsError?: string;
}

interface QueueMessage {
  id: string;
  attempts: number | null;
  body: string;
  metadata: unknown;
  timestampMs: number | null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

function formatTimestamp(timestampMs: number | null): string {
  return timestampMs === null ? 'Unknown' : new Date(timestampMs).toLocaleString();
}

function prettyBody(body: string): string {
  try { return JSON.stringify(JSON.parse(body), null, 2); } catch { return body; }
}

async function responseBody<Result>(response: Response): Promise<Result> {
  const body = await response.json().catch(() => null) as (Result & { error?: string }) | null;
  if (!response.ok || body === null) throw new Error(body?.error ?? `Request failed (${response.status})`);
  return body;
}

export function QueuesView(): React.JSX.Element {
  const [queues, setQueues] = useState<DeadLetterQueue[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<QueueMessage[]>([]);
  const [loadingQueues, setLoadingQueues] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [queueError, setQueueError] = useState('');
  const [messageError, setMessageError] = useState('');

  const loadQueues = useCallback(async (): Promise<void> => {
    setLoadingQueues(true); setQueueError('');
    try {
      const body = await responseBody<{ queues?: DeadLetterQueue[] }>(await fetch('/api/queues/dead-letters'));
      const next = body.queues ?? [];
      setQueues(next);
      setSelectedId((current) => current && next.some((queue) => queue.id === current)
        ? current
        : next[0]?.id ?? null);
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : 'Dead-letter queues are unavailable.');
    } finally { setLoadingQueues(false); }
  }, []);

  const loadMessages = useCallback(async (queueId: string): Promise<void> => {
    setLoadingMessages(true); setMessageError('');
    try {
      const response = await fetch(`/api/queues/dead-letters/${encodeURIComponent(queueId)}/peek`, {
        method: 'POST',
      });
      const body = await responseBody<{ messages?: QueueMessage[] }>(response);
      setMessages(body.messages ?? []);
    } catch (error) {
      setMessages([]);
      setMessageError(error instanceof Error ? error.message : 'Queue messages are unavailable.');
    } finally { setLoadingMessages(false); }
  }, []);

  useEffect(() => { void loadQueues(); }, [loadQueues]);
  useEffect(() => {
    if (selectedId) void loadMessages(selectedId);
    else setMessages([]);
  }, [loadMessages, selectedId]);

  const selected = useMemo(
    () => queues.find((queue) => queue.id === selectedId) ?? null,
    [queues, selectedId],
  );
  const totalBacklog = queues.reduce((total, queue) => total + (queue.metrics?.backlogCount ?? 0), 0);

  return <>
    <aside className="queue-list"><header><p>Cloudflare Queues</p><h1>Dead letters</h1><small>{loadingQueues ? 'Reading live backlog…' : `${totalBacklog.toLocaleString()} messages across ${queues.length} queues`}</small></header>
      <div className="queue-list-actions"><Button disabled={loadingQueues} onClick={() => void loadQueues()} type="button">{loadingQueues ? 'Refreshing…' : 'Refresh queues'}</Button></div>
      <div className="queues">
        {queues.map((queue) => <button className={selectedId === queue.id ? 'selected' : ''} key={queue.id} onClick={() => setSelectedId(queue.id)} type="button">
          <span className={`queue-count${(queue.metrics?.backlogCount ?? 0) > 0 ? ' has-messages' : ''}`}>{queue.metrics?.backlogCount.toLocaleString() ?? '—'}</span>
          <div><strong>{queue.name}</strong><small>{queue.metrics ? `${formatBytes(queue.metrics.backlogBytes)} queued` : 'Metrics unavailable'}</small></div><b>›</b>
        </button>)}
        {!loadingQueues && queues.length === 0 && !queueError && <EmptyState title="No dead-letter queues" description="No active Queue consumer currently points to a dead-letter queue." />}
      </div>
      {queueError && <p className="queue-error" role="alert">{queueError}</p>}
      <footer><span className={queueError ? 'status-dot' : 'healthy-dot'} />{queueError ? 'Cloudflare Queues unavailable' : 'Cloudflare API connected'}</footer>
    </aside>
    <main className="queue-detail">
      {selected ? <><header className="queue-detail-header"><div><p>Dead-letter queue</p><h2>{selected.name}</h2><code>{selected.id}</code></div><Button disabled={loadingMessages} onClick={() => void loadMessages(selected.id)} type="button">{loadingMessages ? 'Peeking…' : 'Refresh messages'}</Button></header>
        <section className="queue-metrics" aria-label="Queue backlog">
          <div><span>Messages</span><strong>{selected.metrics?.backlogCount.toLocaleString() ?? '—'}</strong></div>
          <div><span>Backlog size</span><strong>{selected.metrics ? formatBytes(selected.metrics.backlogBytes) : '—'}</strong></div>
          <div><span>Oldest message</span><strong>{selected.metrics?.oldestMessageTimestampMs ? formatTimestamp(selected.metrics.oldestMessageTimestampMs) : 'None'}</strong></div>
        </section>
        <section className="queue-source"><span>Receives failed messages from</span><div>{selected.sourceQueues.map((source) => <code key={source}>{source}</code>)}</div>{selected.metricsError && <p role="alert">{selected.metricsError}</p>}</section>
        <section className="queue-messages"><div className="section-title"><div><h3>Message contents</h3><p>One Cloudflare peek batch. Peek does not lease, acknowledge, retry, or remove messages.</p></div><span>{loadingMessages ? 'Loading…' : `${messages.length} shown`}</span></div>
          <div className="message-stack">
            {messages.map((message) => <article className="queue-message" key={message.id}><header><div><strong>{message.id}</strong><small>{formatTimestamp(message.timestampMs)} · {message.attempts ?? 'Unknown'} attempts</small></div></header><pre>{prettyBody(message.body)}</pre>{message.metadata !== null && <details><summary>Cloudflare metadata</summary><pre>{JSON.stringify(message.metadata, null, 2)}</pre></details>}</article>)}
            {!loadingMessages && messages.length === 0 && !messageError && <EmptyState title="No messages to inspect" description="This dead-letter queue is currently empty." />}
          </div>
          {messageError && <p className="queue-error" role="alert">{messageError}</p>}
        </section></> : <div className="queue-detail-empty"><EmptyState title="Choose a dead-letter queue" description="Select a queue to inspect its backlog and message bodies." /></div>}
    </main>
  </>;
}
