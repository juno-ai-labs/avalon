import type { ConnectorConnectionContext } from "@rally/connectors";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { decryptString, encryptString } from "../src/lib/crypto";
import {
  ensureFreshConnectorCredentials,
  type CredentialRefreshAdapter,
} from "../src/services/connector-credential-refresh";
import {
  connectionObjectFixture,
  storedConnectionEnvelope,
  storedConnectionLease,
} from "./helpers/connection-object";

/**
 * The refresh lease, against the object that owns it.
 *
 * This suite used to carry a ninety-line fake `D1Database` that dispatched on
 * `sql.startsWith(...)` and reimplemented the lease: which claims win, when an
 * expiry lets a rival through, whether a settle still holds its lease. That is
 * the behaviour under test, so the fake was grading its own answer — and it had
 * already drifted, admitting a settle from a caller whose lease had been taken.
 * The real object decides all of it here; only the transport is doubled.
 */
const WORKSPACE = "00000000-0000-7000-8000-0000000f0001";
const CONNECTION = "00000000-0000-7000-8000-0000000f0002";
const SECRET = "test-connector-credential-key";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function fixture(status: "healthy" | "needs_reconnect" | "disabled" = "healthy") {
  const stale = {
    botAccessToken: "xoxb-old",
    refreshToken: "xoxe-one-use",
    expiresAt: "2020-01-01T00:00:00.000Z",
  };
  const encrypted = await encryptString(JSON.stringify(stale), SECRET, CONNECTION);
  return {
    stale,
    ...connectionObjectFixture({
      workspaceId: WORKSPACE,
      connectionId: CONNECTION,
      status,
      credentials: { ciphertext: encrypted.ciphertext, iv: encrypted.iv, keyVersion: 1 },
      env: {
        CONNECTOR_CREDENTIALS_KEY: SECRET,
        CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
      },
      register: (database) => { databases.push(database); },
    }),
  };
}

function connection(credentials: Record<string, unknown>): ConnectorConnectionContext {
  return {
    id: CONNECTION,
    workspaceId: WORKSPACE,
    scope: "workspace",
    ownerUserId: null,
    grantedScopes: [],
    credentials: { ...credentials },
    cursor: {},
  } as ConnectorConnectionContext;
}

describe("connector credential refresh serialization", () => {
  it("uses a rotating refresh token exactly once across concurrent callers", async () => {
    const { env, objectDatabase, stale } = await fixture();
    const refreshCredentials = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        botAccessToken: "xoxb-new",
        refreshToken: "xoxe-next",
        expiresAt: "2099-01-01T00:00:00.000Z",
      };
    });
    const adapter = { refreshCredentials } satisfies CredentialRefreshAdapter;
    const first = connection(stale);
    const second = connection(stale);

    // Above the wait loop's own worst case: ROTATION_WAIT_ATTEMPTS = 8 backoffs
    // of 100/200/400/800/1600/2000/2000/2000ms, ~9.1s cumulative. A backoff
    // sleeps to completion with no early wake, so a deadline inside that ladder
    // aborts the loser mid-sleep and the run fails with an AbortError before any
    // assertion is reached. The budget covers scheduling jitter between two real
    // callers, not the ~20ms of simulated refresh work below it — a caller that
    // genuinely never gets the lease now fails on the loop's own bounded-wait
    // error, which names the reason.
    const budgetMs = 10_000;
    await Promise.all([
      ensureFreshConnectorCredentials(env, first, adapter, AbortSignal.timeout(budgetMs)),
      ensureFreshConnectorCredentials(env, second, adapter, AbortSignal.timeout(budgetMs)),
    ]);

    expect(refreshCredentials).toHaveBeenCalledTimes(1);
    expect(first.credentials).toMatchObject({ botAccessToken: "xoxb-new", refreshToken: "xoxe-next" });
    expect(second.credentials).toMatchObject({ botAccessToken: "xoxb-new", refreshToken: "xoxe-next" });
    const stored = storedConnectionEnvelope(objectDatabase, CONNECTION);
    await expect(decryptString(
      String(stored.encrypted_credentials),
      String(stored.credential_iv),
      SECRET,
      CONNECTION,
    )).resolves.toContain("xoxe-next");
  });

  it("hands the lease back when the refresh fails, so the next caller can take it", async () => {
    // The fake released on any statement mentioning `= NULL`, whoever asked.
    // The object releases only for the holder, and this is the property that
    // matters: a failed refresh must not strand the lease for its full expiry.
    const { env, objectDatabase, stale } = await fixture();
    const refreshCredentials = vi.fn(async () => {
      throw new Error("provider refused");
    });
    await expect(ensureFreshConnectorCredentials(
      env,
      connection(stale),
      { refreshCredentials } satisfies CredentialRefreshAdapter,
      AbortSignal.timeout(5_000),
    )).rejects.toThrow("provider refused");

    expect(storedConnectionLease(objectDatabase, CONNECTION))
      .toEqual({ credential_refresh_lease_id: null });
  });

  it("refuses to claim a lease on a disabled connection", async () => {
    // `status <> 'disabled'` is on the claim, not on a check before it. A
    // disabled row has had its envelope cleared deliberately, and reviving it
    // through a refresh would undo that.
    const { env, stale } = await fixture("disabled");
    await expect(ensureFreshConnectorCredentials(
      env,
      connection(stale),
      { refreshCredentials: async () => ({ botAccessToken: "xoxb-new" }) } satisfies CredentialRefreshAdapter,
      AbortSignal.timeout(5_000),
    )).rejects.toThrow(/unavailable|still being refreshed/);
  });
});
