import {
  WorkspaceAutomationTemplateListSchema,
  WorkspaceAutomationTemplateOwnershipSchema,
  WorkspaceAutomationTemplateVersionResultSchema,
  type WorkspaceAutomationTemplateList,
  type WorkspaceAutomationTemplateOwnership,
  type WorkspaceAutomationTemplateOwnershipRequest,
  type WorkspaceAutomationTemplatePublishRequest,
  type WorkspaceAutomationTemplateVersionRequest,
  type WorkspaceAutomationTemplateVersionResult,
} from "./workspace-automation-template-protocol";

type VersionInput = WorkspaceAutomationTemplatePublishRequest["version"];

function insertVersion(
  storage: DurableObjectStorage,
  templateId: string,
  versionNumber: number,
  version: VersionInput,
): void {
  storage.sql.exec(
    `INSERT INTO automation_template_versions
       (id, template_id, version_number, overview, instructions, trigger_definitions_json,
        required_capabilities_json, expected_outputs_json, default_behavior_json,
        recommended_plugins_json, memory_tables_json, created_by_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    version.versionId,
    templateId,
    versionNumber,
    version.overview,
    version.instructions,
    version.triggerDefinitionsJson,
    version.requiredCapabilitiesJson,
    version.expectedOutputsJson,
    version.defaultBehaviorJson,
    version.recommendedPluginsJson,
    version.memoryTablesJson,
    version.createdByUserId,
    version.at,
  );
}

/** The shared gallery: workspace-shared templates at their latest version. */
export function listWorkspaceAutomationTemplates(
  storage: DurableObjectStorage,
  workspaceId: string,
): WorkspaceAutomationTemplateList {
  const rows = storage.sql.exec<{
    id: string;
    owner_user_id: string | null;
    name: string;
    description: string;
    latest_version_number: number;
    required_capabilities_json: string;
    trigger_definitions_json: string;
  }>(
    `SELECT template.id, template.owner_user_id, template.name, template.description,
            template.latest_version_number,
            version.required_capabilities_json, version.trigger_definitions_json
       FROM automation_templates template
       JOIN automation_template_versions version
         ON version.template_id = template.id
        AND version.version_number = template.latest_version_number
      WHERE template.workspace_id = ?
        AND template.sharing_state = 'workspace'
        AND template.archived_at IS NULL
      ORDER BY template.name COLLATE NOCASE`,
    workspaceId,
  ).toArray();
  return WorkspaceAutomationTemplateListSchema.parse({
    items: rows.map((row) => ({
      id: row.id,
      ownerUserId: row.owner_user_id,
      name: row.name,
      description: row.description,
      latestVersionNumber: row.latest_version_number,
      requiredCapabilitiesJson: row.required_capabilities_json,
      triggerDefinitionsJson: row.trigger_definitions_json,
    })),
  });
}

/** Whether this person owns an active template with this id. */
export function workspaceAutomationTemplateOwnership(
  storage: DurableObjectStorage,
  request: WorkspaceAutomationTemplateOwnershipRequest,
): WorkspaceAutomationTemplateOwnership {
  const row = storage.sql.exec<{ id: string }>(
    `SELECT id FROM automation_templates
      WHERE id = ? AND workspace_id = ? AND owner_user_id = ? AND archived_at IS NULL`,
    request.templateId,
    request.workspaceId,
    request.ownerUserId,
  ).toArray()[0];
  return WorkspaceAutomationTemplateOwnershipSchema.parse({ owned: row !== undefined });
}

/** Publish a template and its first version, or neither. */
export function publishWorkspaceAutomationTemplate(
  storage: DurableObjectStorage,
  request: WorkspaceAutomationTemplatePublishRequest,
): void {
  storage.transactionSync(() => {
    storage.sql.exec(
      `INSERT INTO automation_templates
         (id, workspace_id, owner_user_id, name, description, sharing_state,
          latest_version_number, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'workspace', 1, ?, ?)`,
      request.templateId,
      request.workspaceId,
      request.ownerUserId,
      request.name,
      request.description,
      request.version.at,
      request.version.at,
    );
    insertVersion(storage, request.templateId, 1, request.version);
  });
}

/**
 * Add the next version, reading and bumping the number in one round trip.
 *
 * Two guarantees, and they are not the same one. What ends the version-number
 * race is that this whole body runs inside a single Durable Object method: the
 * service used to read `latest_version_number` here and write the incremented
 * value in a separate batch, so two people publishing a revision at the same
 * moment read the same number and both wrote it, and
 * `UNIQUE (template_id, version_number)` turned that into a 500 for whichever
 * landed second. The object's input gate is what serializes that now.
 *
 * `transactionSync` earns its place separately: it makes the version insert and
 * the counter bump all-or-nothing, so a failing insert cannot leave
 * `latest_version_number` ahead of the rows it counts.
 */
export function addWorkspaceAutomationTemplateVersion(
  storage: DurableObjectStorage,
  request: WorkspaceAutomationTemplateVersionRequest,
): WorkspaceAutomationTemplateVersionResult {
  return storage.transactionSync(() => {
    const template = storage.sql.exec<{ latest_version_number: number }>(
      `SELECT latest_version_number FROM automation_templates
        WHERE id = ? AND workspace_id = ? AND owner_user_id = ? AND archived_at IS NULL`,
      request.templateId,
      request.workspaceId,
      request.ownerUserId,
    ).toArray()[0];
    if (!template) {
      return WorkspaceAutomationTemplateVersionResultSchema.parse({
        outcome: "template_not_found",
      });
    }
    const versionNumber = template.latest_version_number + 1;
    insertVersion(storage, request.templateId, versionNumber, request.version);
    storage.sql.exec(
      `UPDATE automation_templates SET latest_version_number = ?, updated_at = ? WHERE id = ?`,
      versionNumber,
      request.version.at,
      request.templateId,
    );
    return WorkspaceAutomationTemplateVersionResultSchema.parse({
      outcome: "added",
      versionNumber,
    });
  });
}
