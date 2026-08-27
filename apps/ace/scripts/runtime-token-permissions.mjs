async function queueRequest({ accountId, token, path, init = {}, fetchImpl }) {
  const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}/queues${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.success !== true || body.result === undefined) {
    const detail = (body?.errors ?? []).map((error) => error.message).filter(Boolean).join('; ');
    throw new Error(`Ace runtime Queue permission check failed (${response.status})${detail ? `: ${detail}` : ''}`);
  }
  return body.result;
}

/**
 * Prove the existing Ace runtime credential can use the strongest Queue call
 * the UI needs before a deployment installs it. The Queue provisioner runs
 * first, so one dynamically selected Queue is sufficient for this permission
 * probe and avoids coupling deployment to any Queue name.
 */
export async function verifyRuntimeQueuePermissions({ accountId, token, fetchImpl = fetch }) {
  const queues = await queueRequest({ accountId, token, path: '?per_page=1', fetchImpl });
  const queueId = Array.isArray(queues)
    ? queues.find((queue) => typeof queue?.queue_id === 'string' && queue.queue_id.length > 0)?.queue_id
    : undefined;
  if (!queueId) throw new Error('Ace runtime Queue permission check found no provisioned Queue');
  await queueRequest({
    accountId,
    token,
    path: `/${encodeURIComponent(queueId)}/messages/peek`,
    init: { method: 'POST' },
    fetchImpl,
  });
}
