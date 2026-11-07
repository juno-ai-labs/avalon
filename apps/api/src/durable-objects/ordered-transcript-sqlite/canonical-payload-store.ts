export interface CanonicalTranscriptFactMaterial {
  factId: string;
  factKind: string;
  audience: "shared" | "participant" | "model";
  payload: unknown;
  origin: {
    originKind: "canonical" | "protocol" | "derived" | "system_projection";
    sourceKind: string | null;
    sourceId: string | null;
    sourceRevision: number | null;
  };
  runId: string | null;
  turnId: string | null;
  toolCallId: string | null;
}

export interface PreparedCanonicalTranscriptFact<T extends CanonicalTranscriptFactMaterial = CanonicalTranscriptFactMaterial> {
  canonical: string;
  hash: string;
  payloadId: string;
  material: T;
}

/** One canonical JSON and SHA-256 implementation for every transcript host. */
export async function prepareCanonicalTranscriptFact<T extends CanonicalTranscriptFactMaterial>(
  material: T,
): Promise<PreparedCanonicalTranscriptFact<T>> {
  const canonical = canonicalTranscriptJson(material.payload);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return {
    canonical,
    hash,
    payloadId: `payload:${material.audience}:${hash}`,
    material,
  };
}

/** The payload half of `insertPreparedCanonicalTranscriptFact`: store it once, by its hash. */
export function insertCanonicalTranscriptPayload(
  sql: SqlStorage,
  prepared: PreparedCanonicalTranscriptFact,
  now: number,
): void {
  sql.exec(
    `INSERT INTO transcript_payloads
       (payload_id, audience, media_type, payload_json, payload_sha256, byte_length, created_at)
     VALUES (?, ?, 'application/json', ?, ?, ?, ?)
     ON CONFLICT(audience, payload_sha256, byte_length) DO NOTHING`,
    prepared.payloadId,
    prepared.material.audience,
    prepared.canonical,
    prepared.hash,
    new TextEncoder().encode(prepared.canonical).byteLength,
    now,
  );
}

export function insertPreparedCanonicalTranscriptFact(
  sql: SqlStorage,
  prepared: PreparedCanonicalTranscriptFact,
  now: number,
): void {
  const { material } = prepared;
  insertCanonicalTranscriptPayload(sql, prepared, now);
  sql.exec(
    `INSERT INTO transcript_facts
       (fact_id, fact_kind, payload_id, origin_kind, source_kind, source_id,
        source_revision, run_id, turn_id, tool_call_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(fact_id) DO UPDATE SET
       payload_id = excluded.payload_id,
       run_id = excluded.run_id,
       turn_id = excluded.turn_id,
       tool_call_id = excluded.tool_call_id`,
    material.factId,
    material.factKind,
    prepared.payloadId,
    material.origin.originKind,
    material.origin.sourceKind,
    material.origin.sourceId,
    material.origin.sourceRevision,
    material.runId,
    material.turnId,
    material.toolCallId,
    now,
  );
}

export function canonicalTranscriptJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (value === undefined) throw new Error("transcript_non_json_value");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("transcript_non_finite_number");
    return value;
  }
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      // UTF-16 code-unit order, never localeCompare: the hash is content
      // addressing, so key order must be identical on every runtime and locale.
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, nested]) => [key, sortJson(nested)]));
  }
  throw new Error("transcript_non_json_value");
}
