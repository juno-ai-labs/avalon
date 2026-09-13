import { ConnectorInstallationSchema, ConnectorRegistrationSchema } from "@rally/contracts";
import { z } from "zod";
const Coordinates = z.strictObject({ workspaceId: z.string().uuid(), connectionId: z.string().uuid() });
export const InstallationReadSchema = Coordinates;
export const InstallationCreateSchema = z.strictObject({
  installation: ConnectorInstallationSchema, userId: z.string().uuid(), inputHash: z.string().min(1),
  credentials: z.strictObject({ ciphertext: z.string().min(1), iv: z.string().min(1), keyVersion: z.number().int().positive() }),
  capability: z.string().min(1), adopt: z.boolean().optional(),
  /** Settings' label for the reserved connection, chosen by the caller that knows the provider. */
  displayName: z.string().min(1).max(180).optional(),
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

/**
 * One verified delivery, and what the provider's own facet says can establish
 * that its registration exists.
 *
 * `registrationSupport` carries the adapter's declaration rather than its name:
 * the caller reads it off the deployed facet and this object decides what it
 * means, so a second all-manual provider needs no code here.
 */
export const InstallationDeliverySchema = InstallationReadSchema.extend({
  receivedAt: z.string().datetime(),
  registrationSupport: z.strictObject({
    create: z.enum(["automatic", "manual", "unsupported"]),
    inspect: z.enum(["automatic", "manual", "unsupported"]),
  }).optional(),
});
export type InstallationDelivery = z.infer<typeof InstallationDeliverySchema>;
