/** How a run changes an attached Canvas: the tools are the run's own. */
export const RUN_CANVAS_UPDATING = "This Sidekick is attached to the Canvases above, so this run may change their artifacts. "
  + "For an artifact with storesData true, change its rows with write_artifact_data (describe_artifact_data shows its tables): "
  + "a row write is safe when runs overlap and makes no new version. "
  + "To change an artifact's files, import_resource it to its filePath, edit, and publish_resource that filePath with canvas set to the canvasId: "
  + "that is a new version, attributed to this Sidekick. A Canvas holds one artifact, so never publish a new filePath into it: when the instructions ask for a new file each run, add this run's output to the artifact, keeping what earlier runs added. Runs can overlap, so a run that republishes rebuilds the whole artifact from its sources rather than patching the last version. "
  + "conversation_post with the canvasId tells the people in that Canvas what changed.";
