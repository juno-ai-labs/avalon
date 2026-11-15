import type { HarnessSkill } from "../types";
import { CREATING_A_PODCAST_EPISODE_SKILL } from "./creating-a-podcast-episode/skill";
import { CREATING_AN_APP_SKILL } from "./creating-an-app/skill";
import { DEEP_RESEARCH_SKILL } from "./deep-research/skill";
import { READING_GOOGLE_MEETING_NOTES_SKILL } from "./reading-google-meeting-notes/skill";
import { REPORTING_ON_DATA_SKILL } from "./reporting-on-data/skill";
import { SCHEDULING_A_CALENDAR_EVENT_SKILL } from "./scheduling-a-calendar-event/skill";
import { USING_EXTERNAL_STRUCTURED_DATA_SKILL } from "./using-external-structured-data/skill";
import { WRITING_AN_EMAIL_SKILL } from "./writing-an-email/skill";

export {
  CREATING_A_PODCAST_EPISODE_SKILL,
  CREATING_AN_APP_SKILL,
  DEEP_RESEARCH_SKILL,
  READING_GOOGLE_MEETING_NOTES_SKILL,
  REPORTING_ON_DATA_SKILL,
  SCHEDULING_A_CALENDAR_EVENT_SKILL,
  USING_EXTERNAL_STRUCTURED_DATA_SKILL,
  WRITING_AN_EMAIL_SKILL,
};

/**
 * Request-routing task skills, retained as the original two-entry group used
 * by the harness's default catalog. Other task procedures are registered
 * individually to preserve catalog order; Google meeting notes is bound by
 * the host to an eligible connection.
 */
export const TASK_SKILLS: readonly HarnessSkill[] = [
  REPORTING_ON_DATA_SKILL,
  CREATING_AN_APP_SKILL,
];
