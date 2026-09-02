/**
 * The public-name allocator against the real platform D1 migration.
 *
 * Stubs are security origins, not display labels: a collision must advance,
 * an artifact must keep its first reservation, and an old origin must never be
 * reassigned after deletion.
 */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  artifactHostnameCandidate,
  ensureArtifactHostname,
} from "../src/services/artifact-hostname";
import type { Env } from "../src/env";
import { createTestEnv } from "./helpers/cloudflare-test";
import { sqliteD1 } from "./helpers/sqlite-d1";

const WORKSPACE = "00000000-0000-7000-8000-0000000000a1";
const ARTIFACT_1 = "00000000-0000-7000-8000-0000000000b1";
const ARTIFACT_2 = "00000000-0000-7000-8000-0000000000b2";
const open: DatabaseSync[] = [];

afterEach(() => { for (const database of open.splice(0)) database.close(); });

function fixture(): { database: DatabaseSync; env: Env } {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync(fileURLToPath(new URL(
    "../../../packages/db/platform-migrations/0001_artifact_hostname_routes.sql",
    import.meta.url,
  )), "utf8"));
  database.exec(readFileSync(fileURLToPath(new URL(
    "../../../packages/db/platform-migrations/0002_minimize_artifact_hostname_routes.sql",
    import.meta.url,
  )), "utf8"));
  open.push(database);
  return {
    database,
    env: createTestEnv({
      PLATFORM_DB: sqliteD1(database),
      AVALON_REGION: "global",
      APP_ENV: "test",
      SESSION_SIGNING_KEY: "artifact-hostname-test-secret",
    }),
  };
}

describe("artifact hostname allocation", () => {
  it("keeps one four-word stub as its UUID route", async () => {
    const { database, env } = fixture();
    const first = await ensureArtifactHostname(env, {
      workspaceId: WORKSPACE,
      artifactId: ARTIFACT_1,
    });
    await expect(ensureArtifactHostname(env, {
      workspaceId: WORKSPACE,
      artifactId: ARTIFACT_1,
    })).resolves.toBe(first);

    expect(first.split("-")).toHaveLength(4);
    expect(database.prepare(
      "SELECT hostname_stub FROM artifact_hostname_routes WHERE artifact_id = ?",
    ).get(ARTIFACT_1)).toEqual({ hostname_stub: first });
  });

  it("advances deterministically when another artifact owns its first candidate", async () => {
    const { database, env } = fixture();
    const firstCandidate = await artifactHostnameCandidate(env, WORKSPACE, ARTIFACT_2, 0);
    database.prepare(
      `INSERT INTO artifact_hostname_routes
         (hostname_stub, region, artifact_id, created_at)
       VALUES (?, 'global', ?, '2026-09-01T00:00:00.000Z')`,
    ).run(firstCandidate, ARTIFACT_1);

    const reserved = await ensureArtifactHostname(env, {
      workspaceId: WORKSPACE,
      artifactId: ARTIFACT_2,
    });
    expect(reserved).toBe(await artifactHostnameCandidate(env, WORKSPACE, ARTIFACT_2, 1));
    expect(reserved).not.toBe(firstCandidate);
  });

  it("reports exhaustion when a finite policy value is selected and every candidate collides", async () => {
    const { database, env } = fixture();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      database.prepare(
        `INSERT INTO artifact_hostname_routes
           (hostname_stub, region, artifact_id, created_at)
         VALUES (?, 'global', ?, '2026-09-01T00:00:00.000Z')`,
      ).run(
        await artifactHostnameCandidate(env, WORKSPACE, ARTIFACT_2, attempt),
        attempt === 0 ? ARTIFACT_1 : "00000000-0000-7000-8000-0000000000b3",
      );
    }

    await expect(ensureArtifactHostname(env, {
      workspaceId: WORKSPACE,
      artifactId: ARTIFACT_2,
    }, 2)).rejects.toThrow("artifact_hostname_exhausted");
  });

  it("makes a public origin a permanent, immutable tombstone", async () => {
    const { database, env } = fixture();
    const stub = await ensureArtifactHostname(env, {
      workspaceId: WORKSPACE,
      artifactId: ARTIFACT_1,
    });
    expect(() => database.prepare(
      "UPDATE artifact_hostname_routes SET artifact_id = ? WHERE hostname_stub = ?",
    ).run(ARTIFACT_2, stub)).toThrow(/immutable/iu);
    expect(() => database.prepare(
      "DELETE FROM artifact_hostname_routes WHERE hostname_stub = ?",
    ).run(stub)).toThrow(/permanent tombstones/iu);
  });
});
