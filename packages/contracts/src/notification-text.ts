/**
 * How much of a notification's text is carried: a push body, an Activity
 * row's preview, and an access request's message. A leaf module so a schema
 * anywhere in this package can bound a field by it without importing
 * `push-notifications.ts`, which imports the package index.
 */
// Product decision in the Apple push PRD; byte fitting is separate.
export const PUSH_BODY_PREVIEW_CHARACTERS = 1000;
