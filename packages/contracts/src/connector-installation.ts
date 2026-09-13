import { HttpsUrlSchema } from "./url-schemas";
import { z } from "zod";

export const ConnectorInstallationProviderSchema = z.enum(["ashby", "granola"]);
export const ConnectorRegistrationSchema = z.strictObject({
  key: z.string().min(1), providerId: z.string().min(1).nullable(), events: z.array(z.string().min(1)).min(1),
  adoptingExistingDestination: z.boolean().default(false),
  providerIdVerified: z.boolean().default(true),
  destination: HttpsUrlSchema, enabled: z.boolean().nullable(),
  state: z.enum(["pending", "dispatched", "unknown", "current", "failed", "action_required", "removed"]),
  action: z.enum(["create", "inspect", "update", "remove", "rotate"]),
  stepId: z.string().uuid(),
  afterRegistrationKeys: z.array(z.string()).default([]),
  verifiedAt: z.string().datetime().nullable(),
  error: z.string().nullable(),
  rotation: z.enum(["stable", "prepared", "dispatched", "unknown", "verified"]),
  rotationEvidence: z.string().nullable().default(null),
  verificationPolicy: z.enum(["active", "active_and_pending"]).default("active"),
  rotationGeneration: z.number().int().nonnegative(),
  activeSecretRef: z.string().nullable(), pendingSecretRef: z.string().nullable(),
});
export const ConnectorInstallationSchema = z.strictObject({
  connectionId: z.string().uuid(), workspaceId: z.string().uuid(), provider: ConnectorInstallationProviderSchema,
  attemptId: z.string().uuid(), generation: z.number().int().positive(),
  maintenanceOperationId: z.string().uuid().nullable().default(null),
  maintenanceCancelled: z.boolean().default(false),
  cleanupCredentialForgotten: z.boolean().default(false),
  desiredVersion: z.number().int().positive(), appliedVersion: z.number().int().positive().nullable(),
  state: z.enum(["setting_up", "current", "updating", "action_required", "failed", "cleanup_pending", "disconnected"]),
  selectedEvents: z.array(z.string().min(1)).min(1),
  registrations: z.array(ConnectorRegistrationSchema),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), lastReceivedAt: z.string().datetime().nullable(),
  error: z.string().nullable(),
});
export type ConnectorInstallation = z.infer<typeof ConnectorInstallationSchema>;
export type InstallationRegistration = z.infer<typeof ConnectorRegistrationSchema>;
