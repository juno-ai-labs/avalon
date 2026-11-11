import { BUILDING_LIVE_SITES_SKILL } from "./platform-skills/building-live-sites-skill";
import { SETTING_UP_A_FILTERED_TRIGGER_SKILL } from "./platform-skills/filtered-trigger-skill";
import { POLLING_FOR_EVENTS_SKILL } from "./platform-skills/polling-for-events-skill";
import { TRACKING_SEEN_OR_DONE_ITEMS_SKILL } from "./platform-skills/tracking-seen-or-done-items-skill";
import { USING_THE_LOCAL_INAPP_BROWSER_SKILL } from "./platform-skills/using-the-local-inapp-browser-skill";
import {
  DEEP_RESEARCH_SKILL,
  SCHEDULING_A_CALENDAR_EVENT_SKILL,
  TASK_SKILLS,
  USING_EXTERNAL_STRUCTURED_DATA_SKILL,
  WRITING_AN_EMAIL_SKILL,
} from "@rally/skills";
import type { HarnessSkill } from "./index";

export {
  BUILDING_LIVE_SITES_SKILL,
  DEEP_RESEARCH_SKILL,
  POLLING_FOR_EVENTS_SKILL,
  SCHEDULING_A_CALENDAR_EVENT_SKILL,
  SETTING_UP_A_FILTERED_TRIGGER_SKILL,
  TRACKING_SEEN_OR_DONE_ITEMS_SKILL,
  USING_EXTERNAL_STRUCTURED_DATA_SKILL,
  USING_THE_LOCAL_INAPP_BROWSER_SKILL,
  WRITING_AN_EMAIL_SKILL,
};

/**
 * Skills the harness ships with, for a host that has no library of its own yet.
 *
 * These are ordinary `HarnessSkill` values, not a second source: a host still
 * chooses which to put in `RunHarnessInput.skills`, and the frozen-scope rule is
 * unchanged. They exist because a workspace's first skill should not have to be
 * its own authoring surface, and because a procedure this general — how to
 * research something properly — is the same in every workspace.
 *
 * Rally mechanics live in `platform-skills/`; task procedures in `@rally/skills`.
 * Authored as TypeScript rather than `SKILL.md` files because this package runs
 * in `workerd`, where there is no filesystem to read them from at startup.
 */

/** Every skill this package ships. A host picks from these; none is automatic. */
export const BUILT_IN_SKILLS: readonly HarnessSkill[] = [
  DEEP_RESEARCH_SKILL,
  WRITING_AN_EMAIL_SKILL,
  SCHEDULING_A_CALENDAR_EVENT_SKILL,
  USING_THE_LOCAL_INAPP_BROWSER_SKILL,
  USING_EXTERNAL_STRUCTURED_DATA_SKILL,
  // Offered only where the Sidekicks plugin is in scope, by its `ownerPlugin`:
  // the whole procedure is drafting one, and an automation occurrence is
  // deliberately never given the drafting tools.
  POLLING_FOR_EVENTS_SKILL,
  // Also the Sidekicks plugin's: whose events start a Sidekick, and each
  // person's own filter on them.
  SETTING_UP_A_FILTERED_TRIGGER_SKILL,
  // Available during authoring and execution wherever durable Tables are in scope.
  TRACKING_SEEN_OR_DONE_ITEMS_SKILL,
  // Offered only where the Terminal plugin is in scope, by its `ownerPlugin`:
  // the whole procedure ends in publishing a directory from a sandbox.
  BUILDING_LIVE_SITES_SKILL,
  // Request-routing task skills compose the procedures above for a report or app.
  ...TASK_SKILLS,
];
