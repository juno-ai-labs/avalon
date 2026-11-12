/**
 * `set_artifact_audience`: a Canvas's Chat sets who can open the Canvas's
 * published artifacts, as the person typing into it.
 *
 * Publishing agents default a site to the most open audience the request
 * allows (`building-live-sites`), and a new Canvas starts with editors-only
 * artifact access. See `docs/canvas-artifact-access.md`.
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
    + "\"workspace\": members of this Organization, plus anyone already named in the Canvas's Share screen, guests included; "
    + "remove those people in Share if they must lose access. "
    + "\"editors\": only the people who can open this Canvas's Chat.",
  ),
  personAsked: z.boolean().describe(
    "true only when the person asked in this conversation to change who can open this Canvas's artifacts. "
    + "false when you are choosing a default after publishing; then nothing changes if an audience was already chosen.",
  ),
});

const AUDIENCE_WORDS = { public: "anyone with the link", workspace: "the Organization", participants: "specific people", editors: "the Canvas's editors" } as const;

export function createArtifactAudienceTool(env: Env, input: { workspaceId: string; canvasId: string; userId: string }): HarnessTool {
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
      // Nothing dedupes the call itself, so an interrupted one is recorded rather than replayed.
      idempotency: "record_before_execute",
      inputSchema: z.toJSONSchema(ArgumentsSchema) as Record<string, unknown>,
    },
    execute: async (raw: unknown) => {
      const args = ArgumentsSchema.parse(raw);
      const workspaceId = asWorkspaceId(input.workspaceId);
      const workspace = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, workspaceId, workspaceDOName(env.AVALON_REGION, workspaceId));
      const result = await workspace.canvasSetArtifactAudience({ ...input, artifactVisibility: args.audience, personAsked: args.personAsked });
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
      const words = AUDIENCE_WORDS[result.artifactVisibility];
      if (result.outcome === "kept") {
        return {
          output: {
            audience: result.artifactVisibility,
            changed: false,
            note: `Someone already chose who can open this Canvas's artifacts, so it stays open to ${words}. `
              + "Tell the person, and ask whether they want it changed; call again with personAsked true only if they say so.",
          },
          summary: `Artifacts stay open to ${words}`,
        };
      }
      return {
        output: {
          audience: result.artifactVisibility,
          changed: true,
          ...(result.artifactVisibility !== args.audience
            ? { note: "The Canvas's Chat is open to the whole Organization, so its artifacts cannot be narrower than that." } : {}),
        },
        summary: `Artifacts open to ${words}`,
      };
    },
  };
}
