/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";
import { ARTIFACT_HOST_SCHEMA_MIGRATIONS } from "../src/durable-objects/artifact-host-do";
import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { canvasArtifactAccessSnapshot, canvasArtifactTargets } from "../src/durable-objects/canvas-artifact-access";

const WORKSPACE = "00000000-0000-7000-8000-0000000ab001";
const CANVAS = "00000000-0000-7000-8000-0000000ab002";
const RESOURCE = "00000000-0000-7000-8000-0000000ab003";
const HOST = "00000000-0000-7000-8000-0000000ab004";
const CAPTURE = "00000000-0000-7000-8000-0000000ab006";
const USER = "00000000-0000-7000-8000-0000000ab005";

it("upgrades committed WorkspaceDO 146 publications without narrowing old public sites; new Canvases default to editors", async () => {
  const probe = env.MIGRATION_PROBE_DO!.getByName(
    "canvas-access-workspace-146",
  );
  await probe.ping();
  await runInDurableObject(probe, (_instance, state) => {
    applyDurableObjectSqliteMigrations({
      storage: state.storage,
      migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS.filter(
        (m) => m.version <= 146,
      ),
      component: "workspace_do",
      workerVersionId: "before",
      now: 1,
    });
    const sql = state.storage.sql;
    sql.exec(
      "INSERT INTO workspace_identity VALUES(1,?,'global','wnam',1,1)",
      WORKSPACE,
    );
    sql.exec(
      "INSERT INTO canvas_directory(canvas_id,workspace_id,title,created_by_user_id,created_at,updated_at,visibility,authority_generation) VALUES(?,?,'Existing',?,1,1,'creator',1)",
      CANVAS,
      WORKSPACE,
      USER,
    );
    sql.exec(
      "INSERT INTO canvas_participants VALUES(?,?,'added',?,1)",
      CANVAS,
      USER,
      USER,
    );
    sql.exec(
      `INSERT INTO resources(id,workspace_id,provider,resource_type,title,mime_type,content_ref,metadata_json,attachment_status,created_at,updated_at)
      VALUES(?,?,'avalon_generated','generated_file','Upgraded site','application/vnd.rally.site-manifest+json','manifest','{}','attached','2026-11-01','2026-11-01')`,
      RESOURCE,
      WORKSPACE,
    );
    sql.exec(`INSERT INTO resources(id,workspace_id,provider,provider_resource_id,resource_type,title,mime_type,content_ref,publication_parent_id,metadata_json,attachment_status,created_at,updated_at)
      VALUES(?,?,'avalon_generated','terminal-command-log:legacy','generated_file','Internal log','text/plain','private-log',?,'{}','attached','2026-11-01','2026-11-01')`, CAPTURE,WORKSPACE,CANVAS);
    sql.exec(
      "INSERT INTO artifact_registry(artifact_id,workspace_id,workstream_id,resource_id,mode,stateful,current_version,manifest_ref,created_at,updated_at) VALUES(?,?,?,?,'static',0,1,'manifest',1,1)",
      HOST,
      WORKSPACE,
      CANVAS,
      RESOURCE,
    );
  });
  // A separate event commits the old graph before applying the upgrade.
  await runInDurableObject(probe, (_instance, state) => {
    applyDurableObjectSqliteMigrations({
      storage: state.storage,
      migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS,
      component: "workspace_do",
      workerVersionId: "after",
      now: 2,
    });
    const sql = state.storage.sql;
    expect(sql.exec("SELECT publication_parent_id,content_ref FROM resources WHERE id=?",CAPTURE).one()).toEqual({publication_parent_id:null,content_ref:'private-log'});
    expect(canvasArtifactTargets(sql,CANVAS)).toEqual([{artifactId:HOST,resourceId:RESOURCE}]);
    expect(canvasArtifactAccessSnapshot(sql, CANVAS)?.public).toBe(true);
    expect(canvasArtifactAccessSnapshot(sql, CANVAS)?.revision).toBeGreaterThan(
      1,
    );
    expect(
      sql
        .exec(
          "SELECT publication_parent_id,content_ref FROM resources WHERE id=?",
          RESOURCE,
        )
        .one(),
    ).toEqual({ publication_parent_id: CANVAS, content_ref: "manifest" });
    expect(
      sql
        .exec(
          "SELECT user_id FROM canvas_participants WHERE canvas_id=?",
          CANVAS,
        )
        .toArray(),
    ).toEqual([{ user_id: USER }]);
    expect(
      sql
        .exec(
          "SELECT alarm_key FROM _internal_durable_alarms WHERE kind='canvas_artifact_access'",
        )
        .toArray(),
    ).toEqual([{ alarm_key: CANVAS }]);
    sql.exec(
      "INSERT INTO canvas_directory(canvas_id,workspace_id,title,created_by_user_id,created_at,updated_at,visibility,authority_generation) VALUES(?,?,'New',?,1,1,'creator',1)",
      RESOURCE,
      WORKSPACE,
      USER,
    );
    expect(canvasArtifactAccessSnapshot(sql, RESOURCE)?.public).toBe(false);
    // An existing Canvas's audience counts as chosen, so an agent's default
    // never widens it (migration 148); a new Canvas's does not.
    expect(
      sql
        .exec(
          "SELECT canvas_id, artifact_visibility, artifact_visibility_chosen FROM canvas_directory WHERE canvas_id IN (?,?) ORDER BY canvas_id = ?",
          CANVAS,
          RESOURCE,
          RESOURCE,
        )
        .toArray(),
    ).toEqual([
      { canvas_id: CANVAS, artifact_visibility: "public", artifact_visibility_chosen: 1 },
      { canvas_id: RESOURCE, artifact_visibility: "editors", artifact_visibility_chosen: 0 },
    ]);
    expect(sql.exec("PRAGMA foreign_key_check").toArray()).toEqual([]);
  });
});

it("upgrades committed ArtifactHostDO 3 with a legacy-only public snapshot and retains old sessions without trusting their incarnation", async () => {
  const probe = env.MIGRATION_PROBE_DO!.getByName("canvas-access-host-3");
  await probe.ping();
  await runInDurableObject(probe, (_instance, state) => {
    applyDurableObjectSqliteMigrations({
      storage: state.storage,
      migrations: ARTIFACT_HOST_SCHEMA_MIGRATIONS.filter((m) => m.version <= 3),
      component: "artifact_host",
      workerVersionId: "before",
      now: 1,
    });
    state.storage.sql.exec(
      "INSERT INTO artifact_state VALUES(1,?,?,?,?,'global',1,'static',0,'{}',1)",
      HOST,
      WORKSPACE,
      CANVAS,
      RESOURCE,
    );
    state.storage.sql.exec(
      "INSERT INTO viewer_sessions(session_sha256,user_id,display_name,issued_at,expires_at,redeemed_at) VALUES('digest',?,'Viewer',1,1000,2)",
      USER,
    );
  });
  await runInDurableObject(probe, (_instance, state) => {
    applyDurableObjectSqliteMigrations({
      storage: state.storage,
      migrations: ARTIFACT_HOST_SCHEMA_MIGRATIONS,
      component: "artifact_host",
      workerVersionId: "after",
      now: 2,
    });
    const row = state.storage.sql
      .exec<{
        snapshot_json: string;
      }>("SELECT snapshot_json FROM artifact_access")
      .one();
    expect(JSON.parse(row.snapshot_json)).toEqual({
      workspaceId: WORKSPACE,
      canvasId: CANVAS,
      revision: 1,
      public: true,
      archived: false,
      users: [],
    });
    expect(
      state.storage.sql
        .exec(
          "SELECT user_id,membership_incarnation,redeemed_at FROM viewer_sessions",
        )
        .toArray(),
    ).toEqual([
      { user_id: USER, membership_incarnation: null, redeemed_at: 2 },
    ]);
    expect(
      state.storage.sql
        .exec("SELECT resource_id,current_version FROM artifact_state")
        .toArray(),
    ).toEqual([{ resource_id: RESOURCE, current_version: 1 }]);
  });
});
