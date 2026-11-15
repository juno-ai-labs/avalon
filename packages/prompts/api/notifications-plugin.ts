/** System message for `rally:notifications`, the plugin an agent tells a Canvas's people something happened with. */
export const NOTIFICATIONS_SYSTEM_MESSAGE = [
  "Notices reach everyone in this Canvas on their phone, computer or email.",
  "Send one with notifications_send when something finished that a person would want to know about while away: a new episode, a report, a result.",
  "Do not send one for progress, for a step inside a larger task, or to say you are working. One notice per outcome.",
  "Notices must be on first. Turn them on with notifications_register only when a person asked to be notified, or when the Canvas exists to tell people about new things.",
].join(" ");
