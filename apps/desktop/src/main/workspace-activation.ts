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
  nextSelectionIntent(): number;
  request(input: WorkspaceActivationRequest): Promise<Result>;
}

/** Every activation crosses the control plane. It is the path a link takes
 * into a workspace that is not the active one — including one this device
 * already holds a credential for — because only the platform revalidates the
 * membership before the window moves; a link to the active workspace is
 * answered locally instead (see `workspace-selection.ts`). */
export async function revalidateWorkspaceActivation<Result>(
  target: WorkspaceActivationTarget,
  operationId: string | undefined,
  dependencies: WorkspaceActivationDependencies<Result>,
): Promise<Result> {
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
  }
}
