/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { asSubstreamId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";

import {
  substreamAgentName,
  workspaceDOName,
  workstreamDOName,
} from "../src/durable-objects/names";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000ea1");
const WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-000000000ea2");
const SUBSTREAM_ID = asSubstreamId("00000000-0000-7000-8000-000000000ea3");

describe("internal Durable Object SQLite inspection RPC", () => {
  beforeEach(async () => {
    const stubs = [
      env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
        workspaceDOName("global", WORKSPACE_ID),
      )),
      env.WORKSTREAM_DOS.get(env.WORKSTREAM_DOS.idFromName(
        workstreamDOName("global", WORKSPACE_ID, WORKSTREAM_ID),
      )),
      env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
        substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID, SUBSTREAM_ID),
      )),
    ];
    await Promise.all(stubs.map(async (stub) => {
      await stub.runInspectionSql({
        sql: "CREATE TABLE IF NOT EXISTS engineering_inspection_fixture (label TEXT, payload BLOB)",
        bindings: [],
      });
      await stub.runInspectionSql({
        sql: "DELETE FROM engineering_inspection_fixture",
        bindings: [],
      });
    }));
  });

  it("runs bound SQL and returns SQLite metadata for every inspectable authority", async () => {
    const authorities = [
      env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
        workspaceDOName("global", WORKSPACE_ID),
      )),
      env.WORKSTREAM_DOS.get(env.WORKSTREAM_DOS.idFromName(
        workstreamDOName("global", WORKSPACE_ID, WORKSTREAM_ID),
      )),
      env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
        substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID, SUBSTREAM_ID),
      )),
    ];

    for (const [index, authority] of authorities.entries()) {
      const label = `authority-${index}`;
      const inserted = await authority.runInspectionSql({
        sql: "INSERT INTO engineering_inspection_fixture(label, payload) VALUES (?, X'0102')",
        bindings: [label],
      });
      expect(inserted.rowsWritten).toBeGreaterThan(0);

      const selected = await authority.runInspectionSql({
        sql: "SELECT label, payload FROM engineering_inspection_fixture WHERE label = ?",
        bindings: [label],
      });
      expect(selected).toMatchObject({
        columns: ["label", "payload"],
        rows: [{ label, payload: { type: "blob", base64: "AQI=" } }],
      });
      expect(selected.rowsRead).toBeGreaterThan(0);
    }
  });
});
