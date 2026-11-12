import { SIDEKICK_RUN_READING_GUIDANCE } from "./sidekick-run-reading-guidance";
import { sidekickDelegationGuidance } from "./sidekick-delegation-guidance";
import { sidekickSourceGuidance } from "./sidekick-source-guidance";

/**
 * The Sidekick plugin's message outside the wizard: run reading for a wizard
 * that reviews runs, then delegation, then sources where this run may ask.
 */
export function renderSidekickDelegationPluginSystemMessage(input: {
  readsRuns: boolean;
  setsDelegation: boolean;
  sources: boolean;
}): string {
  return `${input.readsRuns ? `${SIDEKICK_RUN_READING_GUIDANCE} ` : ""}${sidekickDelegationGuidance(input.setsDelegation)}${input.sources ? ` ${sidekickSourceGuidance()}` : ""}`;
}
