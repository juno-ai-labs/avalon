import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { uuidToBase58 } from "@rally/contracts/uuid-base58";

import { createApp } from "../src/app";
import { linkTitleTarget } from "../src/routes/links";
import type { Env } from "../src/env";
import { createCloudflareTestBinding, createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const WORKSPACE = "00000000-0000-7000-8000-0000000000a1";
const SPACE = "00000000-0000-7000-8000-0000000000a2";
const CHANNEL = "00000000-0000-7000-8000-0000000000a3";
const BREAKOUT = "00000000-0000-7000-8000-0000000000a4";
const base = `/app/global/${uuidToBase58(WORKSPACE)}`;

describe("linkTitleTarget", () => {
  it("reads which resource each canonical link path names", () => {
    expect(linkTitleTarget(`${base}/s/${uuidToBase58(SPACE)}/c/${uuidToBase58(CHANNEL)}`)).toEqual({
      region: "global", request: { workspaceId: WORKSPACE, target: { kind: "channel", workstreamId: CHANNEL } },
    });
    expect(linkTitleTarget(`${base}/s/${uuidToBase58(SPACE)}/c/${uuidToBase58(CHANNEL)}/b/${uuidToBase58(BREAKOUT)}`)).toEqual({
      region: "global",
      request: { workspaceId: WORKSPACE, target: { kind: "breakout", workstreamId: CHANNEL, substreamId: BREAKOUT } },
    });
    expect(linkTitleTarget(`${base}/s/${uuidToBase58(SPACE)}/`)).toEqual({
      region: "global", request: { workspaceId: WORKSPACE, target: { kind: "space", spaceId: SPACE } },
    });
    expect(linkTitleTarget(`${base}/sk/${uuidToBase58(CHANNEL)}/`)).toEqual({
      region: "global", request: { workspaceId: WORKSPACE, target: { kind: "sidekick", sidekickId: CHANNEL } },
    });
  });

  it("names nothing for a link without an Organization or a path that is not a link", () => {
    expect(linkTitleTarget(`/app/workstreams/${CHANNEL}`)).toBeNull();
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
  const channel = `/s/${uuidToBase58(SPACE)}/c/${uuidToBase58(CHANNEL)}`;

  it("answers an Organization this deployment does not hold as not found, before opening any object", async () => {
    await expect(title(`${base}${channel}`)).resolves.toEqual({ status: 404, code: "link_not_found" });
  });

  it("leaves a link minted in another region to that region", async () => {
    await expect(title(`/app/elsewhere/${uuidToBase58(WORKSPACE)}${channel}`)).resolves.toEqual({ status: 404, code: "link_not_found" });
  });

  it("refuses a path that is not a Rally link", async () => {
    await expect(title("/help/")).resolves.toEqual({ status: 400, code: "link_path_invalid" });
  });
});
