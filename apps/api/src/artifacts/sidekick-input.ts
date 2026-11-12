import { zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";
import {
  ArtifactSidekickInputSchema, ArtifactSidekickBindingNameSchema,
  type ArtifactSidekickAddress, type ArtifactSidekickInput, type ArtifactSidekickInvocation,
} from "@rally/contracts";

export function artifactInvocationInput(address: ArtifactSidekickAddress, bindingName: string, input: ArtifactSidekickInput): ArtifactSidekickInvocation {
  const parsed = ArtifactSidekickInputSchema.safeParse(input);
  if (!parsed.success) throw new Error(zodDiagnosticCode(parsed.error, "artifact_invocation") ?? "artifact_invocation_invalid:input");
  const name = ArtifactSidekickBindingNameSchema.safeParse(bindingName);
  if (!name.success) throw new Error("artifact_invocation_invalid:bindingName");
  return { ...address, bindingName: name.data, ...parsed.data };
}
