import { z } from "zod";

import { ArtifactIdSchema, IdSchema, WorkspaceIdSchema } from "./identifiers";

/** A server-side name, used as env.SIDEKICKS.shoppingOrganizer. */
export const ArtifactSidekickBindingNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);

export const ArtifactSidekickInputSchema = z.strictObject({
  operationId: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
});
export type ArtifactSidekickInput = z.infer<typeof ArtifactSidekickInputSchema>;

/** Host-minted address. Generated code supplies only the binding name and input. */
export const ArtifactSidekickAddressSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  artifactId: ArtifactIdSchema,
  artifactVersion: z.number().int().positive(),
});
export type ArtifactSidekickAddress = z.infer<typeof ArtifactSidekickAddressSchema>;

export const ArtifactSidekickInvocationSchema = ArtifactSidekickAddressSchema.extend({
  bindingName: ArtifactSidekickBindingNameSchema,
  ...ArtifactSidekickInputSchema.shape,
});
export type ArtifactSidekickInvocation = z.infer<typeof ArtifactSidekickInvocationSchema>;

export const ArtifactSidekickAdmissionSchema = z.strictObject({ runId: IdSchema, reused: z.boolean() });
export type ArtifactSidekickAdmission = z.infer<typeof ArtifactSidekickAdmissionSchema>;

/** The serving Worker's narrow service binding into the regional API. */
export interface ArtifactSidekickDispatchBinding {
  send(request: ArtifactSidekickInvocation): Promise<ArtifactSidekickAdmission>;
}
