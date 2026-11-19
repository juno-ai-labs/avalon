/**
 * What the wizard saves for the runs: it configures, and does not publish the
 * Canvas's artifacts itself. It may check a row write it saves, since its
 * `write_artifact_data` is held to the same attachment as a run's.
 */
import { CANVAS_DEFINITION } from "./canvas-definition";

export const WIZARD_CANVAS_UPDATING = "This Sidekick is attached to the Canvases above, so its runs may change their artifacts; you configure it and do not publish them yourself. "
  + `${CANVAS_DEFINITION} `
  + "Never save an instruction to publish a file on its own, for delivery or to keep it for a retry: save steps that put each file inside the Canvas's artifact and publish only that artifact, by its filePath with canvas set to the canvasId. "
  + "Save instructions that name the canvasId and each artifact's resourceId. For an artifact with storesData true, have each run change rows with write_artifact_data, "
  + "naming the tables and columns (describe_artifact_data shows them): a row write is safe when runs overlap and makes no new version. "
  + "Only for a change to an artifact's files, have a run import it to its filePath and publish_resource that filePath with canvas set to the canvasId, rebuilding it from its sources. "
  + "Before you report a saved row write ready, run it once with write_artifact_data on a row you can tell is a test, read it back with query_artifact_data, then delete every row your test added, restore any row it changed, and confirm with query_artifact_data that no test data is left: "
  + "the person's first look at the app must show only their own data.";
