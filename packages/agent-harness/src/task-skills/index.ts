import type { HarnessSkill } from "../index";
import { CREATING_AN_APP_SKILL } from "./creating-an-app/skill";
import { REPORTING_ON_DATA_SKILL } from "./reporting-on-data/skill";

export { CREATING_AN_APP_SKILL, REPORTING_ON_DATA_SKILL };

/**
 * Task skills: one per kind of outcome a person asks for ("a report", "an
 * app"), as opposed to the procedure skills beside `built-in-skills.ts`, which
 * each teach one capability. A task skill interprets the request, settles what
 * must be decided up front, and names the procedure skills that do the work.
 * Add a new one as its own folder here, holding its `skill.ts` (and any
 * resources), and list it below.
 */
export const TASK_SKILLS: readonly HarnessSkill[] = [REPORTING_ON_DATA_SKILL, CREATING_AN_APP_SKILL];
