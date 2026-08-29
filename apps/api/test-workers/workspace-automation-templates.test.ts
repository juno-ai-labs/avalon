/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The template gallery's writes, against the object that owns them.
 *
 * Publishing a template writes two rows, and adding a version reads the latest
 * number before writing the next. As statements through the workspace runtime
 * facade those were separate round trips, so two people publishing a revision
 * at the same moment read the same number and `UNIQUE (template_id,
 * version_number)` refused the second — a 500 rather than the next version.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asUserId, asWorkspaceId } from "@rally/contracts";

import { workspaceDOName } from "../src/durable-objects/names";
import {
  WorkspaceAutomationTemplateListSchema,
  WorkspaceAutomationTemplateVersionResultSchema,
} from "../src/durable-objects/workspace-automation-template-protocol";

/** Its own workspace: a shared id makes this file queue behind its siblings. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000ba0");
const OWNER = asUserId("00000000-0000-7000-8000-000000000ba1");
const OTHER_MEMBER = asUserId("00000000-0000-7000-8000-000000000ba2");
const TEMPLATE = "00000000-0000-7000-8000-000000000bb0";
const AT = "2026-08-29T00:00:00.000Z";

function workspace() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
    workspaceDOName("global", WORKSPACE_ID),
  ));
}

let sequence = 0;
function nextId(): string {
  sequence += 1;
  return `00000000-0000-7000-8000-${String(sequence).padStart(12, "0")}`;
}

function version(overrides: { overview?: string } = {}) {
  return {
    versionId: nextId(),
    overview: overrides.overview ?? "An overview",
    instructions: "Do the thing.",
    triggerDefinitionsJson: "[]",
    requiredCapabilitiesJson: "[]",
    expectedOutputsJson: "[]",
    defaultBehaviorJson: "{}",
    recommendedPluginsJson: "[]",
    memoryTablesJson: "[]",
    createdByUserId: OWNER,
    at: AT,
  };
}

async function publish(templateId = TEMPLATE, name = "Weekly digest") {
  await workspace().publishAutomationTemplate({
    workspaceId: WORKSPACE_ID,
    templateId,
    ownerUserId: OWNER,
    name,
    description: "Shared with the workspace.",
    version: version(),
  });
}

async function addVersion(input: { ownerUserId?: string; templateId?: string } = {}) {
  return WorkspaceAutomationTemplateVersionResultSchema.parse(
    await workspace().addAutomationTemplateVersion({
      workspaceId: WORKSPACE_ID,
      templateId: input.templateId ?? TEMPLATE,
      ownerUserId: input.ownerUserId ?? OWNER,
      version: version(),
    }),
  );
}

async function gallery() {
  return WorkspaceAutomationTemplateListSchema.parse(
    await workspace().listAutomationTemplates({ workspaceId: WORKSPACE_ID }),
  );
}

beforeEach(async () => {
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec(`DELETE FROM automation_template_versions`);
    state.storage.sql.exec(`DELETE FROM automation_templates`);
  });
}, 30_000);

describe("automation template gallery", () => {
  it("publishes a template and its first version together", async () => {
    await publish();
    const items = (await gallery()).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: TEMPLATE,
      ownerUserId: OWNER,
      name: "Weekly digest",
      latestVersionNumber: 1,
    });
  });

  it("gives each new version the next number, one at a time", async () => {
    await publish();
    expect((await addVersion()).versionNumber).toBe(2);
    expect((await addVersion()).versionNumber).toBe(3);
    expect((await gallery()).items[0]?.latestVersionNumber).toBe(3);
  });

  it("does not hand two concurrent revisions the same version number", async () => {
    // The defect the round trips allowed: both readers saw the same
    // `latest_version_number`, both wrote it, and the unique constraint
    // refused the second. Inside the object each call is its own critical
    // section, so the numbers are consecutive rather than colliding.
    await publish();
    const results = await Promise.all([addVersion(), addVersion(), addVersion()]);
    expect(results.map((result) => result.versionNumber).sort()).toEqual([2, 3, 4]);
    expect((await gallery()).items[0]?.latestVersionNumber).toBe(4);
  });

  it("refuses a version from somebody who does not own the template", async () => {
    await publish();
    expect(await addVersion({ ownerUserId: OTHER_MEMBER })).toEqual({
      outcome: "template_not_found",
      versionNumber: null,
    });
    expect((await gallery()).items[0]?.latestVersionNumber).toBe(1);
  });

  it("says so rather than writing a version for a template that is not there", async () => {
    expect(await addVersion({ templateId: "00000000-0000-7000-8000-000000000bbe" })).toEqual({
      outcome: "template_not_found",
      versionNumber: null,
    });
  });

  it("serves the gallery at each template's latest version", async () => {
    await publish();
    await addVersion();
    const items = (await gallery()).items;
    expect(items).toHaveLength(1);
    expect(items[0]?.latestVersionNumber).toBe(2);
  });

  it("reports ownership before a caller's draft is looked at", async () => {
    // The preflight the service asks first. Without it, adding a version to a
    // template that is missing, archived, or somebody else's answers with a
    // connector error from validating the draft — a different status than the
    // endpoint has ever given, and one that describes connector state the
    // caller has no claim on.
    await publish();
    const ownership = (input: { templateId?: string; ownerUserId?: string }) =>
      workspace().automationTemplateOwnership({
        workspaceId: WORKSPACE_ID,
        templateId: input.templateId ?? TEMPLATE,
        ownerUserId: input.ownerUserId ?? OWNER,
      });
    expect(await ownership({})).toEqual({ owned: true });
    expect(await ownership({ ownerUserId: OTHER_MEMBER })).toEqual({ owned: false });
    expect(await ownership({ templateId: "00000000-0000-7000-8000-000000000bbf" }))
      .toEqual({ owned: false });
  });

  it("stops reporting ownership once the template is archived", async () => {
    await publish();
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE automation_templates SET archived_at = ? WHERE id = ?`,
        AT,
        TEMPLATE,
      );
    });
    expect(await workspace().automationTemplateOwnership({
      workspaceId: WORKSPACE_ID,
      templateId: TEMPLATE,
      ownerUserId: OWNER,
    })).toEqual({ owned: false });
  });

  it("refuses a request addressed to a different workspace", async () => {
    // Called on the instance rather than through a stub. An RPC call returns a
    // pipelining proxy that rejects separately from the promise the assertion
    // attaches to, so a refusal asserted over RPC leaves that second rejection
    // unhandled — noise in every run of this file, and a failure the day the
    // runner treats those as fatal. The subject is `assertWorkspace`, not the
    // transport.
    const outcome = await runInDurableObject(workspace(), async (instance) =>
      instance.listAutomationTemplates({
        workspaceId: asWorkspaceId("00000000-0000-7000-8000-000000000bae"),
      }).then(() => null, (error: unknown) => error));
    expect(String(outcome)).toContain("workspace_object_identity_mismatch");
  });
});
