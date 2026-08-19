export interface ContextCompactionCheckpointIdentity {
  executionPrincipalKey: string;
  resourceVisibilityFingerprint: string;
  checkpointTemplateVersion: number;
  checkpointRunId: string;
  compactedThroughSequence: number;
  messagesJson: string;
  summary: string;
  model: string;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(",")}}`;
}

/** Content identity for an immutable reference to a mutable latest-checkpoint row. */
export function contextCompactionCheckpointHash(
  checkpoint: ContextCompactionCheckpointIdentity,
): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(canonicalJson(checkpoint))) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}
