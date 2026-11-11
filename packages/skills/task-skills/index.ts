import type { HarnessSkill } from "../types";
import { CREATING_AN_APP_SKILL } from "./creating-an-app/skill";
import { DEEP_RESEARCH_SKILL } from "./deep-research/skill";
import { READING_GOOGLE_MEETING_NOTES_SKILL } from "./reading-google-meeting-notes/skill";
import { REPORTING_ON_DATA_SKILL } from "./reporting-on-data/skill";
import { SCHEDULING_A_CALENDAR_EVENT_SKILL } from "./scheduling-a-calendar-event/skill";
import { USING_EXTERNAL_STRUCTURED_DATA_SKILL } from "./using-external-structured-data/skill";
import { WRITING_AN_EMAIL_SKILL } from "./writing-an-email/skill";

export {
  CREATING_AN_APP_SKILL,
  DEEP_RESEARCH_SKILL,
  READING_GOOGLE_MEETING_NOTES_SKILL,
  REPORTING_ON_DATA_SKILL,
  SCHEDULING_A_CALENDAR_EVENT_SKILL,
  USING_EXTERNAL_STRUCTURED_DATA_SKILL,
  WRITING_AN_EMAIL_SKILL,
};

/**
 * Skills for completing requested work, one folder per skill with its `skill.ts`
 * and any resources. Rally's own mechanics stay in the harness's `platform-skills/`.
 * These tasks need no connection-specific binding; the host offers Google
 * meeting notes separately after binding it to an eligible connection.
 * `BUILT_IN_SKILLS` preserves the combined catalog's established order.
 */
export const TASK_SKILLS: readonly HarnessSkill[] = [
  DEEP_RESEARCH_SKILL,
  WRITING_AN_EMAIL_SKILL,
  SCHEDULING_A_CALENDAR_EVENT_SKILL,
  USING_EXTERNAL_STRUCTURED_DATA_SKILL,
  REPORTING_ON_DATA_SKILL,
  CREATING_AN_APP_SKILL,
];
