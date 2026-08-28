import type { AutomationAttentionReason } from './types';

export interface AutomationAttentionNotice {
  /** What is wrong, as a heading a person can read at a glance. */
  heading: string;
  /** Why it is wrong and what they can do about it. */
  body: string;
  /** The same thing in three words, for the sidebar row. */
  shortLabel: string;
  /** Whether this automation will not run again until somebody changes it. */
  blocking: boolean;
}

/**
 * The words behind a reason code.
 *
 * The server sends the reason and never the sentence. Two things follow from
 * that: the copy can be rewritten without reprojecting every automation that
 * already carries a reason, and the sentence a person reads is written here,
 * beside the rest of the product's words, rather than in a Durable Object where
 * it would inevitably be written for whoever was debugging the cutover.
 *
 * None of these say what a support engineer would want to know — no codes, no
 * table names, no mention of the migration that caused it. What a person needs
 * is whether the automation still runs and what to do about it.
 */
export function automationAttentionNotice(
  reason: AutomationAttentionReason,
): AutomationAttentionNotice {
  if (reason === 'unsupported_trigger') {
    return {
      heading: 'This automation will not run',
      // The one that has to be unmistakable: the automation is not paused
      // pending somebody's decision, it is over. Nothing in Rally can start it
      // again, and no amount of waiting changes that.
      body: 'Rally was upgraded, and the trigger that used to start this automation did not survive the move. '
        + 'It will not run again on its own. Create it again with a trigger Rally supports to bring it back.',
      shortLabel: 'Will not run',
      blocking: true,
    };
  }
  if (reason === 'legacy_runtime_error') {
    return {
      heading: 'Rally paused this automation',
      body: 'One of its runs ended in an error, so Rally stopped it rather than repeating the failure. '
        + 'Choose Resume when you want it to start running again.',
      shortLabel: 'Needs attention',
      blocking: false,
    };
  }
  return {
    heading: 'A run could not be confirmed',
    body: 'Rally could not confirm how one of this automation\'s runs finished, '
      + 'so what is listed under Recent runs may be incomplete. The automation itself is still running as usual.',
    shortLabel: 'Needs attention',
    blocking: false,
  };
}
