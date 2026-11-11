import { artifactInvocationInput } from "./sidekick-input";
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  ArtifactSidekickAdmissionSchema, ArtifactSidekickInvocationSchema,
  type ArtifactSidekickAddress, type ArtifactSidekickInvocation, type ArtifactSidekickInput,
} from "@rally/contracts";

import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { workspaceDOName } from "../durable-objects/names";
import { parseRpcInput } from "../lib/rpc-input";

/** Admission only: never call back into the artifact facet while it is awaiting this RPC. */
async function dispatch(env: Env, input: ArtifactSidekickInvocation) {
  const request = parseRpcInput(ArtifactSidekickInvocationSchema, input, "artifact_invocation");
  const workspace = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, request.workspaceId,
    workspaceDOName(env.AVALON_REGION, request.workspaceId));
  return parseRpcInput(ArtifactSidekickAdmissionSchema, await workspace.artifactInvokeSidekick(request), "artifact_invocation_admission");
}

/** Private service entrypoint for the artifact-serving Worker. */
export class ArtifactSidekickDispatcher extends WorkerEntrypoint<Env> {
  send(request: ArtifactSidekickInvocation) { return dispatch(this.env, request); }
}

/** The stateful facet holds a capability addressed to its own app. */
export class ArtifactSidekickLoopback extends WorkerEntrypoint<Env, ArtifactSidekickAddress> {
  send(bindingName: string, input: ArtifactSidekickInput) {
    return dispatch(this.env, artifactInvocationInput(this.ctx.props, bindingName, input));
  }
}
