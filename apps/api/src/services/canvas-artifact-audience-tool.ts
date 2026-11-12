/**
 * `set_artifact_audience`: a Canvas's Chat changes who can open the Canvas's
 * published artifacts, as the person typing into it.
 *
 * Publishing agents default a site to the most open audience the request
 * allows (`building-live-sites`), and a new Canvas starts with editors-only
 * artifact access, so without this tool a public site stayed private until a
 * manager found the Share screen. It sets only the artifact audience: the
 * editor audience, and naming specific people, stay with the Share screen.
 * Only a Canvas manager may change it, exactly as through Share; anyone else
 * gets a refusal that says who can.
 *
 * See `docs/canvas-artifact-access.md`.
 */
import { asWorkspaceId } from "@rally/contracts";
import type { HarnessTool } from "@rally/agent-harness";
import { z } from "zod";

import { workspaceDOName } from "../durable-objects/names";
import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { ArtifactDataToolError } from "./workstream-artifact-data-tools";

const ArgumentsSchema = z.strictObject({
  audience: z.enum(["public", "workspace", "editors"]).describe(
    "Who can open this Canvas's published sites and files. "
    + "\"public\": anyone with the link, signed in or not. "
    + "\"workspace\": members of this Organization. "
    + "\"editors\": only the people who can open this Canvas's Chat.",
  ),
});

/** What the tool needs from the host; the WorkspaceDO call in production. */
export interface ArtifactAudiencePort {
  set(audience: "public" | "workspace" | "editors"): Promise<
    | { outcome: "set"; artifactVisibility: "editors" | "participants" | "workspace" | "public" }
    | { outcome: "not_manager" }
    | { outcome: "not_found" }
  >;
}

export function createArtifactAudienceTool(port: ArtifactAudiencePort): HarnessTool {
  return {
    definition: {
      name: "set_artifact_audience",
      description: [
        "Set who can open this Canvas's published sites and files. It applies to every artifact this Canvas has",
        "published and every one it publishes later, and takes effect within seconds. It never opens this Canvas's",
        "Chat to anyone. Only the Canvas's creator or an Organization owner or admin can change it.",
        "To share with specific people, ask the person to use the Canvas's Share screen instead.",
      ].join(" "),
      capability: "workstream.artifacts.audience",
      mode: "write",
      // Setting a value twice leaves the same value, but nothing dedupes the
      // call itself, so an interrupted one is recorded rather than replayed.
      idempotency: "record_before_execute",
      inputSchema: z.toJSONSchema(ArgumentsSchema) as Record<string, unknown>,
    },
    execute: async (raw: unknown) => {
      const args = ArgumentsSchema.parse(raw);
      const result = await port.set(args.audience);
      if (result.outcome === "not_manager") {
        const reason = "Only the Canvas's creator or an Organization owner or admin can change who opens its artifacts, from the Canvas's Share screen.";
        throw new ArtifactDataToolError("artifact_audience_not_manager",
          `The artifact audience was not changed: the person you are acting for does not manage this Canvas. ${reason}`, { reason });
      }
      if (result.outcome === "not_found") {
        throw new ArtifactDataToolError("canvas_not_found",
          "This Canvas is archived or no longer exists, so its artifact audience cannot change.",
          { reason: "The Canvas is archived or no longer exists." });
      }
      const raised = result.artifactVisibility !== args.audience;
      return {
        output: {
          audience: result.artifactVisibility,
          ...(raised ? { note: "The Canvas's Chat is open to the whole Organization, so its artifacts cannot be narrower than that." } : {}),
        },
        summary: `Artifacts open to ${result.artifactVisibility === "public" ? "anyone with the link"
          : result.artifactVisibility === "workspace" ? "the Organization" : "the Canvas's editors"}`,
      };
    },
  };
}

/** The production port: the run's own Canvas, as the person the Chat runs as. */
export function artifactAudiencePort(env: Env, input: { workspaceId: string; canvasId: string; userId: string }): ArtifactAudiencePort {
  return {
    async set(audience) {
      const workspaceId = asWorkspaceId(input.workspaceId);
      const workspace = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, workspaceId, workspaceDOName(env.AVALON_REGION, workspaceId));
      return workspace.canvasSetArtifactAudience({ ...input, artifactVisibility: audience });
    },
  };
}
