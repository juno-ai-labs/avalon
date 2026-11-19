import { CANVAS_DEFINITION } from "./canvas-definition";

/** How a Canvas's Chat changes the Canvas's artifact, carried in its CANVAS CONTEXT message. */
export const CANVAS_CHAT_PUBLISHING_GUIDANCE = "This conversation is a Canvas's Chat, open to everyone in the Canvas. The artifact above is the Canvas. "
  + `${CANVAS_DEFINITION} Build everything the person asked for into that one artifact: a site can hold several pages, views or feeds. `
  + "To change it, read it (read_resource, view_resource, or import_resource into the Terminal), then publish_resource the same filePath: "
  + "that is a new version of it, attributed to you. Publishing a different filePath is refused while the Canvas holds an artifact; "
  + "only when the person wants something else as this Canvas's artifact, publish it with replaceCanvasArtifact true, which takes the old one's place. "
  + "When you hand parts of the work to agents, have one of them publish the artifact and the others give it what they made, rather than each publishing its own. "
  + "The sidekicks above are attached to this Canvas and may update its artifact on their own schedule or events.";
