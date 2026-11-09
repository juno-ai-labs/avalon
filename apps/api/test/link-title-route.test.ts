import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { uuidToBase58 } from "@rally/contracts/uuid-base58";

import { createApp } from "../src/app";
import { linkTitleTarget } from "../src/routes/links";
import type { Env } from "../src/env";
import { createCloudflareTestBinding, createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const WORKSPACE = "00000000-0000-7000-8000-0000000000a1";
const CANVAS = "00000000-0000-7000-8000-0000000000a3";
const ARTIFACT = "00000000-0000-7000-8000-0000000000a4";
const base = `/app/global/${uuidToBase58(WORKSPACE)}`;

describe("linkTitleTarget", () => {
  it("reads which Canvas or Sidekick each canonical link path names", () => {
    expect(linkTitleTarget(`${base}/cv/${uuidToBase58(CANVAS)}/`)).toEqual({
      region: "global", request: { workspaceId: WORKSPACE, target: { kind: "canvas", canvasId: CANVAS } },
    });
    // Opened onto an artifact, the link still names its Canvas.
    expect(linkTitleTarget(`${base}/cv/${uuidToBase58(CANVAS)}/a/${uuidToBase58(ARTIFACT)}/`)).toEqual({
      region: "global", request: { workspaceId: WORKSPACE, target: { kind: "canvas", canvasId: CANVAS } },
    });
    expect(linkTitleTarget(`${base}/sk/${uuidToBase58(CANVAS)}/`)).toEqual({
      region: "global", request: { workspaceId: WORKSPACE, target: { kind: "sidekick", sidekickId: CANVAS } },
    });
  });

  it("names a Thread link's Canvas, which a conversion kept under the Thread's id", () => {
    expect(linkTitleTarget(`${base}/s/${uuidToBase58(ARTIFACT)}/c/${uuidToBase58(CANVAS)}`)).toEqual({
      region: "global", request: { workspaceId: WORKSPACE, target: { kind: "canvas", canvasId: CANVAS } },
    });
  });

  it("names nothing for a retired Space or Breakout link, or a path that is not a link", () => {
    expect(linkTitleTarget(`${base}/s/${uuidToBase58(CANVAS)}/`)).toBeNull();
    expect(linkTitleTarget(`${base}/s/${uuidToBase58(CANVAS)}/c/${uuidToBase58(ARTIFACT)}/b/${uuidToBase58(CANVAS)}`)).toBeNull();
    expect(linkTitleTarget(`/app/workstreams/${CANVAS}`)).toBeNull();
    expect(linkTitleTarget("/help/")).toBeNull();
  });
});

describe("GET /links/title refusals", () => {
  let database: DatabaseSync;
  beforeEach(() => { database = migratedSqliteDatabase(); });
  afterEach(() => { database.close(); });
  // Ids derive as in production; opening an object fails the test, so a 404
  // here proves the refusal came from D1 before any object was reached.
  const workspaces = {
    jurisdiction: () => workspaces,
    idFromName: (name: string) => ({ name, toString: () => name, equals: () => false }),
    get: () => { throw new Error("no Organization object may open for an unknown Organization"); },
  };
  const env = () => createTestEnv({
    DB: sqliteD1(database), ALLOWED_ORIGINS: "https://rallywith.ai", AVALON_REGION: "global",
    APP_ENV: "production", RALLY_DEV_AUTH: "false", LOG_LEVEL: "error",
    WORKSPACE_DOS: createCloudflareTestBinding<Env["WORKSPACE_DOS"]>(workspaces),
  });
  const title = async (path: string) => {
    const response = await createApp().request(`/links/title?${new URLSearchParams({ path })}`, {}, env());
    return { status: response.status, code: ((await response.json()) as { error?: { code?: string } }).error?.code };
  };
  const canvas = `/cv/${uuidToBase58(CANVAS)}/`;

  it("answers an Organization this deployment does not hold as not found, before opening any object", async () => {
    await expect(title(`${base}${canvas}`)).resolves.toEqual({ status: 404, code: "link_not_found" });
  });

  it("leaves a link minted in another region to that region", async () => {
    await expect(title(`/app/elsewhere/${uuidToBase58(WORKSPACE)}${canvas}`)).resolves.toEqual({ status: 404, code: "link_not_found" });
  });

  it("refuses a path that is not a Rally link", async () => {
    await expect(title("/help/")).resolves.toEqual({ status: 400, code: "link_path_invalid" });
  });
});
