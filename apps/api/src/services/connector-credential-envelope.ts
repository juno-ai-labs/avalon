import type { Env } from "../env";
import { decryptString, encryptString } from "../lib/crypto";

export interface VersionedCredentialRow {
  id: string;
  encrypted_credentials: string;
  credential_iv: string;
  credential_key_version?: number | string | null;
}

type CredentialEnvelopeEnv = Pick<
  Env,
  "DB" | "CONNECTOR_CREDENTIALS_KEY" | "CONNECTOR_CREDENTIALS_KEY_VERSION" | "CONNECTOR_CREDENTIALS_KEYS_JSON"
>;

/**
 * Decrypts with the row's key version and opportunistically re-encrypts with
 * the active key. Old keys are supplied as a secret JSON object keyed by
 * version, for example `{ "1": "...old key..." }` during rotation.
 */
export async function decryptVersionedConnectorCredentials(
  env: CredentialEnvelopeEnv,
  row: VersionedCredentialRow,
  additionalData = row.id,
): Promise<string> {
  const plaintext = await decryptVersionedCredentialValue(env, row, additionalData);
  const activeVersion = Number(env.CONNECTOR_CREDENTIALS_KEY_VERSION || 1);
  const storedVersion = Number(row.credential_key_version || activeVersion);
  if (storedVersion !== activeVersion && additionalData === row.id) {
    const replacement = await encryptString(plaintext, env.CONNECTOR_CREDENTIALS_KEY, row.id);
    await env.DB.prepare(
      `UPDATE connector_connections
       SET encrypted_credentials = ?, credential_iv = ?, credential_key_version = ?, updated_at = ?
       WHERE id = ? AND encrypted_credentials = ? AND credential_iv = ? AND credential_key_version = ?`,
    ).bind(
      replacement.ciphertext,
      replacement.iv,
      activeVersion,
      new Date().toISOString(),
      row.id,
      row.encrypted_credentials,
      row.credential_iv,
      storedVersion,
    ).run();
  }
  return plaintext;
}

export async function decryptVersionedCredentialValue(
  env: Omit<CredentialEnvelopeEnv, "DB">,
  row: Omit<VersionedCredentialRow, "id">,
  additionalData: string,
): Promise<string> {
  const activeVersion = Number(env.CONNECTOR_CREDENTIALS_KEY_VERSION || 1);
  const storedVersion = Number(row.credential_key_version || activeVersion);
  const secret = storedVersion === activeVersion
    ? env.CONNECTOR_CREDENTIALS_KEY
    : previousCredentialKeys(env.CONNECTOR_CREDENTIALS_KEYS_JSON)[String(storedVersion)];
  if (!secret) throw new Error(`Connector credential key version ${storedVersion} is unavailable`);
  return decryptString(
    row.encrypted_credentials,
    row.credential_iv,
    secret,
    additionalData,
  );
}

function previousCredentialKeys(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(
      (entry): entry is [string, string] => /^\d+$/u.test(entry[0]) && typeof entry[1] === "string" && entry[1].length > 0,
    ));
  } catch {
    return {};
  }
}
