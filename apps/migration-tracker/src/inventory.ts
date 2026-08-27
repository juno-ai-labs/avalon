/**
 * The polling half: enumerate every Durable Object in the account.
 *
 * Reports only ever describe objects that woke up. An object that has not been
 * touched since before the tracker existed — or since its last migration —
 * never says anything, and those are precisely the objects a schema change is
 * most likely to strand. Cloudflare's account API can list them: a paged call
 * for the namespaces, then a paged call per namespace for the object IDs it
 * holds. The object listing also says whether each identity currently has
 * stored data, which distinguishes an object awaiting its first report from a
 * cleared identity Cloudflare still enumerates.
 *
 * What the sweep deliberately does *not* do is ask each object for its version.
 * A Durable Object binding can address another script's class, so it would be
 * possible — and it would wake every hibernating object in the account on every
 * sweep, turning a monitor into the largest single source of Durable Object
 * duration in the bill. Enumerate cheaply, let stored objects report on their
 * own wakes, and retain enumerated identities without treating cleared storage
 * as a live migration target.
 */
import type { InventoryNamespace, InventoryObject, InventorySweep } from "./protocol";

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

/** Cloudflare's maximum page size for the object listing. */
const OBJECT_PAGE_SIZE = 1_000;

/**
 * The namespace listing is paged too, defensively.
 *
 * Cloudflare does not document this endpoint as paginated and today's account
 * returns every namespace in one response — but the whole retirement pass in
 * the registry treats a `complete` sweep as the account's full inventory, and
 * a first page mistaken for the whole list would retire every namespace behind
 * it. The termination rule works whether or not the endpoint honours `page`:
 * stop on a short page, and stop on a page that returned nothing new, which is
 * what an endpoint that ignores the parameter answers on the second request.
 */
const NAMESPACE_PAGE_SIZE = 100;
const MAX_NAMESPACE_PAGES = 20;

/**
 * Pages per namespace. Twenty full pages is 20,000 objects — far above the
 * fleet — and the cap exists so one runaway namespace cannot spend the whole
 * cron invocation. Hitting it is recorded on the sweep and named in the log,
 * never silently absorbed: a truncated namespace also suppresses absence
 * marking for that namespace, so a cut-short listing cannot delete objects.
 */
const MAX_OBJECT_PAGES = 20;

export interface InventoryCredentials {
  accountId: string;
  apiToken: string;
}

export interface SweepOptions {
  fetcher?: typeof fetch;
  now?: () => number;
}

interface CloudflareEnvelope<T> {
  success: boolean;
  errors?: { code?: number; message?: string }[];
  result?: T;
  result_info?: { cursor?: string | null };
}

interface NamespacePayload {
  id?: string;
  name?: string;
  script?: string;
  class?: string;
  use_sqlite?: boolean;
}

interface ObjectPayload {
  id?: string;
  hasStoredData?: boolean;
}

/**
 * Run one sweep. Never throws: a sweep that fails is a recorded `failed` sweep
 * with the reason on it, because a monitor that disappears when the API is
 * unhappy is worse than one that says it could not look.
 */
export async function sweepInventory(
  credentials: InventoryCredentials,
  options: SweepOptions = {},
): Promise<InventorySweep> {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const namespaces: InventoryNamespace[] = [];
  const truncatedNamespaces: string[] = [];
  let errorMessage: string | null = null;

  let discovered: NamespaceListing;
  try {
    discovered = await listNamespaces(credentials, fetcher);
  } catch (error) {
    return {
      startedAt,
      finishedAt: now(),
      status: "failed",
      namespaces: [],
      truncatedNamespaces: [],
      errorMessage: messageOf(error),
    };
  }

  // A namespace payload the API returned and this code could not read is not
  // "one fewer namespace" — it is a namespace whose existence is known and
  // whose identity is not. Left silent it would make the sweep `complete` while
  // omitting a live namespace, and the registry would retire it.
  if (discovered.rejected > 0) {
    errorMessage = `${discovered.rejected} namespace payload(s) had no usable id`;
  }

  for (const payload of discovered.namespaces) {
    const namespaceId = payload.id;
    const namespace: InventoryNamespace = {
      namespaceId,
      scriptName: payload.script ?? payload.name ?? "unknown",
      className: payload.class ?? "unknown",
      usesSqlite: payload.use_sqlite === true,
      objects: null,
    };
    try {
      const listing = await listObjects(credentials, namespaceId, fetcher);
      namespace.objects = listing.objects;
      if (listing.truncated) truncatedNamespaces.push(namespaceId);
    } catch (error) {
      // One namespace failing does not invalidate the rest. Its objects stay
      // `null`, which is what stops the registry from marking them absent.
      errorMessage = errorMessage ?? `${namespaceId}: ${messageOf(error)}`;
    }
    namespaces.push(namespace);
  }

  const incomplete = truncatedNamespaces.length > 0
    || discovered.truncated
    || discovered.rejected > 0
    || namespaces.some((namespace) => namespace.objects === null);
  return {
    startedAt,
    finishedAt: now(),
    status: incomplete ? "partial" : "complete",
    namespaces,
    truncatedNamespaces,
    errorMessage,
  };
}

interface NamespaceListing {
  namespaces: (NamespacePayload & { id: string })[];
  /** The page cap was reached, so this listing is not the whole account. */
  truncated: boolean;
  /** Payloads returned by the API that carried no usable id. */
  rejected: number;
}

async function listNamespaces(
  credentials: InventoryCredentials,
  fetcher: typeof fetch,
): Promise<NamespaceListing> {
  const namespaces: (NamespacePayload & { id: string })[] = [];
  const seen = new Set<string>();
  let rejected = 0;

  for (let page = 1; page <= MAX_NAMESPACE_PAGES; page += 1) {
    const url = new URL(
      `${CLOUDFLARE_API_BASE}/accounts/${encodeURIComponent(credentials.accountId)}`
      + `/workers/durable_objects/namespaces`,
    );
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", String(NAMESPACE_PAGE_SIZE));

    const envelope = await request<NamespacePayload[]>(url.toString(), credentials, fetcher);
    const results = envelope.result ?? [];
    let fresh = 0;
    for (const payload of results) {
      const id = payload.id;
      if (typeof id !== "string" || id.length === 0) {
        rejected += 1;
        continue;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      namespaces.push({ ...payload, id });
      fresh += 1;
    }

    if (results.length < NAMESPACE_PAGE_SIZE || fresh === 0) {
      return { namespaces, truncated: false, rejected };
    }
  }

  return { namespaces, truncated: true, rejected };
}

async function listObjects(
  credentials: InventoryCredentials,
  namespaceId: string,
  fetcher: typeof fetch,
): Promise<{ objects: InventoryObject[]; truncated: boolean }> {
  const objects: InventoryObject[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;

  for (let page = 0; page < MAX_OBJECT_PAGES; page += 1) {
    const url = new URL(
      `${CLOUDFLARE_API_BASE}/accounts/${encodeURIComponent(credentials.accountId)}`
      + `/workers/durable_objects/namespaces/${encodeURIComponent(namespaceId)}/objects`,
    );
    url.searchParams.set("limit", String(OBJECT_PAGE_SIZE));
    if (cursor) url.searchParams.set("cursor", cursor);

    const envelope = await request<ObjectPayload[]>(url.toString(), credentials, fetcher);
    for (const payload of envelope.result ?? []) {
      if (typeof payload.id !== "string" || seen.has(payload.id)) continue;
      seen.add(payload.id);
      objects.push({ objectId: payload.id, hasStoredData: payload.hasStoredData === true });
    }

    cursor = envelope.result_info?.cursor ?? null;
    // Cloudflare returns the cursor it would accept next; an empty one and a
    // short page both mean the listing is done.
    if (!cursor || (envelope.result?.length ?? 0) === 0) {
      return { objects, truncated: false };
    }
  }

  return { objects, truncated: true };
}

async function request<T>(
  url: string,
  credentials: InventoryCredentials,
  fetcher: typeof fetch,
): Promise<CloudflareEnvelope<T>> {
  const response = await fetcher(url, {
    headers: {
      authorization: `Bearer ${credentials.apiToken}`,
      accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`cloudflare_api_status_${response.status}`);
  }
  const envelope = await response.json() as CloudflareEnvelope<T>;
  if (!envelope.success) {
    const first = envelope.errors?.[0];
    throw new Error(`cloudflare_api_error_${first?.code ?? "unknown"}`);
  }
  return envelope;
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}
