import type { RallyRegion } from '../common/desktop';
import { workspaceActivationBridgeError } from './api-response-error';

interface WorkspaceActivationTarget {
  region: RallyRegion;
  workspaceId: string;
}

interface WorkspaceActivationRequest {
  path: '/onboarding/workspace/activate';
  body: WorkspaceActivationTarget;
  expectedRegion: RallyRegion;
  expectedWorkspaceId: string;
  operationId: string | undefined;
  selectionIntent: number;
}

interface WorkspaceActivationDependencies<Result> {
  beginChange(target: WorkspaceActivationTarget): number | null;
  finishChange(changeId: number | null): void;
  nextSelectionIntent(): number;
  request(input: WorkspaceActivationRequest): Promise<Result>;
}

/** Every addressed activation crosses the control plane, even when the target
 * matches the cached current workspace. The response is the authorization. */
export async function revalidateWorkspaceActivation<Result>(
  target: WorkspaceActivationTarget,
  operationId: string | undefined,
  dependencies: WorkspaceActivationDependencies<Result>,
): Promise<Result> {
  const changeId = dependencies.beginChange(target);
  try {
    return await dependencies.request({
      path: '/onboarding/workspace/activate',
      body: target,
      expectedRegion: target.region,
      expectedWorkspaceId: target.workspaceId,
      operationId,
      selectionIntent: dependencies.nextSelectionIntent(),
    });
  } catch (error) {
    throw workspaceActivationBridgeError(error);
  } finally {
    dependencies.finishChange(changeId);
  }
}
