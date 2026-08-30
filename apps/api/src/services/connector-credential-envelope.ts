import { asWorkspaceId } from "@rally/contracts";

import type { Env } from "../env";
import { decryptString, encryptString } from "../lib/crypto";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { workspaceDOName } from "../durable-objects/names";

function workspaceObjectFor(env: CredentialEnvelopeEnv, workspaceId: string) {
  return durableObjectStubForWorkspace(
    env as Env,
    env.WORKSPACE_DOS,
    asWorkspaceId(workspaceId),
    workspaceDOName(env.AVALON_REGION, asWorkspaceId(workspaceId)),
  );
}

export interface VersionedCredentialRow {
  id: string;
  /**
   * The workspace whose object holds this connection.
   *
   * Added when the re-encryption below stopped being a routed statement: a
   * typed method has to be addressed to an object, and the id alone does not
   * say which. Every caller already had it — they are all holding a connection
   * row — so this makes an argument out of something that was being supplied
   * implicitly by whichever workspace the facade happened to be scoped to.
   */
  workspace_id: string;
  encrypted_credentials: string;
  credential_iv: string;
  credential_key_version?: number | string | null;
}

type CredentialEnvelopeEnv = Pick<
  Env,
  "DB" | "WORKSPACE_DOS" | "AVALON_REGION"
  | "CONNECTOR_CREDENTIALS_KEY" | "CONNECTOR_CREDENTIALS_KEY_VERSION" | "CONNECTOR_CREDENTIALS_KEYS_JSON"
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
    // Conditional on the exact envelope this call decrypted. An OAuth
    // completion may have replaced it while the plaintext was in hand, and a
    // rotation that landed anyway would write ciphertext the new IV cannot
    // open. `raced` is the ordinary case, not an error: the newer envelope is
    // already under the active key, so there is nothing left to rotate.
    await (await workspaceObjectFor(env, row.workspace_id)).rotateConnectionEnvelope({
      workspaceId: row.workspace_id,
      connectionId: row.id,
      expected: {
        ciphertext: row.encrypted_credentials,
        iv: row.credential_iv,
        keyVersion: storedVersion,
      },
      next: { ciphertext: replacement.ciphertext, iv: replacement.iv, keyVersion: activeVersion },
      at: new Date().toISOString(),
    });
  }
  return plaintext;
}

export async function decryptVersionedCredentialValue(
  env: Omit<CredentialEnvelopeEnv, "DB" | "WORKSPACE_DOS" | "AVALON_REGION">,
  // No `workspace_id`: this reads an envelope and writes nothing, so it needs
  // no object to address. Its one caller outside a connection row is the Notion
  // challenge token, which is not a connection at all.
  row: Omit<VersionedCredentialRow, "id" | "workspace_id">,
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
