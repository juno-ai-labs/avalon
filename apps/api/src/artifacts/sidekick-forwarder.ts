import { artifactInvocationInput } from "./sidekick-input";
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  type ArtifactSidekickAddress, type ArtifactSidekickInput, type ArtifactSidekickDispatchBinding,
} from "@rally/contracts";

/** Stateless sites have the same scoped capability, through a narrow API service binding. */
export class ArtifactSidekickLoopback extends WorkerEntrypoint<{
  ARTIFACT_SIDEKICKS: ArtifactSidekickDispatchBinding;
}, ArtifactSidekickAddress> {
  send(bindingName: string, input: ArtifactSidekickInput) {
    return this.env.ARTIFACT_SIDEKICKS.send(artifactInvocationInput(this.ctx.props, bindingName, input));
  }
}
