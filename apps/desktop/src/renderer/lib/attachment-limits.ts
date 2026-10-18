/**
 * How many files one message may carry. Its own module so a surface can read
 * it without importing the attachment hook, which component tests replace.
 */
export const MAX_ATTACHMENTS = 10;
