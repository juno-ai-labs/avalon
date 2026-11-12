import { sidekickDelegationGuidance } from "./sidekick-delegation-guidance";
import { sidekickSourceGuidance } from "./sidekick-source-guidance";

/**
 * The Sidekick wizard's authoring plugin message: the shared authoring policy,
 * the Sidekick this conversation configures, and the delegation and source
 * guidance when this conversation may manage them.
 */
export function renderSidekickWizardSystemMessage(input: {
  base: string;
  sidekickId: string;
  delegation: boolean;
  sources: boolean;
}): string {
  return `${input.base} This conversation configures Sidekick ${input.sidekickId}. Read its current definition before revising it. ${input.delegation ? `${sidekickDelegationGuidance()}${input.sources ? ` ${sidekickSourceGuidance()}` : ""}` : ""}`;
}
