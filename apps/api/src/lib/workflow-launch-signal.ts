/**
 * Whether a failed harness launch left a Cloudflare Workflow instance running.
 *
 * A caller that undoes its own preparation after a failed launch — the digest
 * scheduler releasing an occurrence's claim and work stream — has to know this,
 * and cannot derive it from anything durable. `startWorkstreamWorkflow` creates
 * the instance *before* the batch that records its id, and `launchWorkstreamHarness`
 * marks its own `harness_runs` row `failed` on the way out of either failure. So
 * both the row's existence and its status say the same thing in both cases,
 * while the correct response is opposite: clean up when nothing started, and
 * touch nothing when a run is executing against the transcript.
 *
 * It lives in its own module rather than beside either function because the two
 * layers that mark and read it sit on opposite sides of a boundary that tests
 * routinely replace — a service that stubs `integrations` or `workstream-service`
 * would otherwise lose the predicate along with the module it came from, and the
 * cleanup would silently take the "nothing started" branch every time.
 *
 * The marker is a registered symbol, so an error crossing a module boundary
 * carries it regardless of how either side was loaded, and it cannot collide
 * with a property any other code sets.
 */
const WORKFLOW_INSTANCE_CREATED = Symbol.for("rally.workflowInstanceCreated");

export function markWorkflowInstanceCreated<T extends Error>(error: T): T {
  return Object.assign(error, { [WORKFLOW_INSTANCE_CREATED]: true });
}

/**
 * Absent reads as `false`, which is the safe default here: every error that can
 * leave an instance running is raised by the launch path and marked there, so an
 * unmarked error means the launch never got that far.
 */
export function workflowInstanceWasCreated(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && (error as Record<symbol, unknown>)[WORKFLOW_INSTANCE_CREATED] === true;
}
