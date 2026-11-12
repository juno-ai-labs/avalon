/** The one-time nudge when a run would end with attachment content it could not verify. */
export function renderAttachmentGroundingNudge(identities: string): string {
  return [
    `Attachment content could not be verified for ${identities}.`,
    "Do not state, estimate, or reconstruct any value from those attachments. Use another authorized attachment tool if one can verify the evidence; otherwise finish with an explicit unverified-attachment notice that names the affected resource or tool-call identities and contains no claimed attachment facts.",
  ].join("\n\n");
}
