/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { asSubstreamId, asWorkspaceId } from "@rally/contracts";
import { z } from "zod";
import { pollAttemptErrorCode, pollAttemptFailure } from "../src/workflows/connector-poll-result";
import { recordConnectorPollFailure } from "../src/services/connector-poll-failure";
import { withWorkspaceRuntimeDatabase } from "../src/services/workspace-runtime-database";
import { beforeEach, expect, it } from "vitest";
import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import { sha256Hex } from "../src/lib/crypto";
import { readConnectorResourceAttachment } from "../src/services/connector-resource-attachments";
import { boot, seedWorkspaceControlPlane, seedWorkstreamRoot } from "./helpers/substream-fixture";

const WORKSPACE = asWorkspaceId("00000000-0000-7000-8000-00000000f9d0");
const THREAD = "00000000-0000-7000-8000-00000000f9d1";
const USER = "00000000-0000-7000-8000-00000000f9d2";
const RESOURCE = "00000000-0000-7000-8000-00000000f9d3";
const KEY = `attachments/${WORKSPACE}/dossier.pdf`;
const workspace = () => env.WORKSPACE_DOS.getByName(workspaceDOName("global", WORKSPACE));
const conversation = () => env.SUBSTREAM_AGENTS.getByName(conversationObjectName("global", WORKSPACE, THREAD, asSubstreamId("0")));
const scope = { workspaceId: WORKSPACE, workstreamId: THREAD, substreamId: "0", principal: { type: "workspace" as const, workspaceId: WORKSPACE } };

beforeEach(async () => {
  await reset();
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE, userId: USER, sessionId: "pdf-session" });
  await workspace().initializeWorkspace(WORKSPACE, "wnam");
  await boot(conversation());
  await runInDurableObject(conversation(), (_instance, state) => {
    seedWorkstreamRoot(state, 1, { workspaceId: WORKSPACE, workstreamId: THREAD });
    state.storage.sql.exec(`INSERT INTO workstream_resource_links
      (resource_id, attached_by_user_id, watch_enabled, relationship_type, resource_json, attached_at, updated_at)
      VALUES (?, NULL, 0, 'attachment', '{}', 1, 1)`, RESOURCE);
  });
});

it("reads original PDF bytes through current visibility and refuses a detached, missing, changed, or non-PDF file", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.7\nCalm dossier\n%%EOF");
  await env.PAYLOADS.put(KEY, bytes);
  const hash = await sha256Hex(bytes);
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec(`INSERT INTO resources
      (id, workspace_id, resource_type, provider, title, mime_type, content_ref, content_sha256, metadata_json, attachment_status, created_at, updated_at)
      VALUES (?, ?, 'generated_file', 'avalon_generated', 'Calm dossier.pdf', 'application/pdf', ?, ?, '{}', 'attached', '2026-10-19', '2026-10-19')`, RESOURCE, WORKSPACE, KEY, hash);
  });
  const result = await readConnectorResourceAttachment(env, scope, RESOURCE);
  expect(result.fileName).toBe("Calm dossier.pdf");
  expect(new TextDecoder().decode(result.bytes)).toBe("%PDF-1.7\nCalm dossier\n%%EOF");
  expect(result.mimeType).toBe("application/pdf");

  await env.PAYLOADS.put(KEY, "changed bytes");
  await expect(readConnectorResourceAttachment(env, scope, RESOURCE)).rejects.toThrow("original file hash changed");
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec("UPDATE resources SET content_sha256 = NULL WHERE id = ?", RESOURCE);
  });
  await expect(readConnectorResourceAttachment(env, scope, RESOURCE)).rejects.toThrow("resource must be a PDF");
  await env.PAYLOADS.delete(KEY);
  await expect(readConnectorResourceAttachment(env, scope, RESOURCE)).rejects.toThrow("original file is unavailable");
  await runInDurableObject(conversation(), (_instance, state) => {
    state.storage.sql.exec("DELETE FROM workstream_resource_links WHERE resource_id = ?", RESOURCE);
  });
  await expect(readConnectorResourceAttachment(env, scope, RESOURCE)).rejects.toThrow("not readable by this run");
});

it("stores the field-specific terminal poll reason in WorkspaceDO after workflow replay", async () => {
  const connectionId = "00000000-0000-7000-8000-00000000f9d4";
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec(`INSERT INTO connector_connections
      (id, workspace_id, connector_type, scope, display_name, model_plugin_id, created_at, updated_at)
      VALUES (?, ?, 'google', 'workspace', 'Google', 'plugin_google', '2026-10-19', '2026-10-19')`, connectionId, WORKSPACE);
  });
  const rejection = z.object({ externalPeople: z.array(z.string()).max(100) }).safeParse({ externalPeople: Array(101).fill("person") });
  if (rejection.success) throw new Error("expected schema rejection");
  const thrown = pollAttemptFailure(rejection.error, pollAttemptErrorCode(rejection.error));
  const replayed = new Error((thrown as Error).message);
  await recordConnectorPollFailure(withWorkspaceRuntimeDatabase(env, WORKSPACE).DB, { workspaceId: WORKSPACE, connectionId }, replayed, "2026-10-19T23:00:00.000Z");
  const stored = await runInDurableObject(workspace(), (_instance, state) =>
    state.storage.sql.exec<{ status: string; error_json: string }>("SELECT status, error_json FROM connector_connections WHERE id = ?", connectionId).one());
  expect(stored.status).toBe("error");
  expect(JSON.parse(stored.error_json)).toEqual({
    code: "connector_poll_failed:externalPeople:too_big",
    message: "Connector poll failed after retries: connector_poll_failed:externalPeople:too_big",
    source: "connector_poll",
  });
});
