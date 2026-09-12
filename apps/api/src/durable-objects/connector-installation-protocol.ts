import { ConnectorInstallationSchema, ConnectorRegistrationSchema } from "@rally/contracts";
import { z } from "zod";
const Coordinates = z.strictObject({ workspaceId: z.string().uuid(), connectionId: z.string().uuid() });
export const InstallationReadSchema = Coordinates;
export const InstallationCreateSchema = z.strictObject({
  installation: ConnectorInstallationSchema, userId: z.string().uuid(), inputHash: z.string().min(1),
  credentials: z.strictObject({ ciphertext: z.string().min(1), iv: z.string().min(1), keyVersion: z.number().int().positive() }),
  capability: z.string().min(1), adopt: z.boolean().optional(),
});
export const InstallationClaimSchema = Coordinates.extend({ generation: z.number().int().positive(), stepId: z.string().uuid() });
export const InstallationSettleSchema = InstallationClaimSchema.extend({ registration: ConnectorRegistrationSchema,
  credentials: z.strictObject({ ciphertext: z.string().min(1), iv: z.string().min(1), keyVersion: z.number().int().positive() }).optional(),
});
export const InstallationChangeSchema = Coordinates.extend({
  action: z.enum(["repair", "disconnect", "forget_cleanup", "reconcile", "rotate"]),
  key: z.string().optional(), providerId: z.string().optional(),
});
export type InstallationCreate = z.infer<typeof InstallationCreateSchema>;
export type InstallationClaim = z.infer<typeof InstallationClaimSchema>;
export type InstallationSettle = z.infer<typeof InstallationSettleSchema>;
export type InstallationChange = z.infer<typeof InstallationChangeSchema>;

export const INSTALLATION_SCHEMA_STATEMENTS = [
  `CREATE TABLE connector_installations (
    connection_id TEXT PRIMARY KEY REFERENCES connector_connections(id),
    workspace_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    document_json TEXT NOT NULL CHECK (json_valid(document_json)),
    cleanup_ciphertext TEXT, cleanup_iv TEXT, cleanup_key_version INTEGER
  ) STRICT`,
  `CREATE TABLE connector_installation_steps (
    step_id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, generation INTEGER NOT NULL,
    state TEXT NOT NULL, intent_json TEXT NOT NULL CHECK (json_valid(intent_json)),
    result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)), created_at TEXT NOT NULL
  ) STRICT`,
  `CREATE INDEX connector_installation_steps_connection ON connector_installation_steps(connection_id, generation)`,
  `CREATE UNIQUE INDEX ashby_personal_connection_unique ON connector_connections(workspace_id, owner_user_id)
    WHERE connector_type = 'ashby' AND scope = 'personal' AND status <> 'disabled'`,
  `CREATE UNIQUE INDEX ashby_workspace_connection_unique ON connector_connections(workspace_id)
    WHERE connector_type = 'ashby' AND scope = 'workspace' AND status <> 'disabled'`,
];

export const InstallationRotationPrepareSchema = InstallationReadSchema.extend({
  generation: z.number().int().positive(), key: z.string().min(1), pendingSecretRef: z.string().min(1),
  verificationPolicy: z.enum(["active", "active_and_pending"]), credentials: InstallationCreateSchema.shape.credentials,
});
export type InstallationRotationPrepare = z.infer<typeof InstallationRotationPrepareSchema>;

export const InstallationMaintenanceSchema = InstallationReadSchema.extend({
  resume: z.boolean().optional(),
  configuration: z.strictObject({ selectedEvents: z.array(z.string()).min(1), registrations: z.array(ConnectorRegistrationSchema) }).optional(),
  credentials: InstallationCreateSchema.shape.credentials.optional(),
  operationId: z.string().uuid(), generation: z.number().int().positive(), version: z.number().int().positive(),
});
export const InstallationMaintenanceCancelSchema = InstallationReadSchema.extend({ operationId: z.string().uuid() });
export type InstallationMaintenance = z.infer<typeof InstallationMaintenanceSchema>;
export type InstallationMaintenanceCancel = z.infer<typeof InstallationMaintenanceCancelSchema>;

export const InstallationCredentialReplaceSchema = InstallationReadSchema.extend({
  generation: z.number().int().positive(), credentials: InstallationCreateSchema.shape.credentials,
});
export type InstallationCredentialReplace = z.infer<typeof InstallationCredentialReplaceSchema>;
