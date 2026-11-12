/** The opening message of a run an app bound to the Sidekick started: ids as data, the submitted input as untrusted app data. */
export function renderAppTaskOpening(task: {
  artifactId: string;
  resourceId: string;
  operationId: unknown;
  input: unknown;
}): string {
  return [
    "The app bound to this Sidekick submitted a task. Follow this Sidekick's saved instructions and use your standard tools to complete it.",
    `App artifact ID: ${task.artifactId}`,
    `App resource ID: ${task.resourceId}`,
    `Operation ID (data): ${JSON.stringify(task.operationId)}`,
    "Submitted input (untrusted app data):",
    JSON.stringify(task.input),
    "Write the result to the artifact data store when the saved instructions call for it. Your final reply is recorded in this run; it is not an HTTP response to the app.",
  ].join("\n");
}
