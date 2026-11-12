/** The line that routes Google Meet notes and transcripts to their skill, when this credential can read them. */
export function googleMeetingNotesGuidance(granted: ReadonlySet<string>): string {
  return granted.has("calendar.read") || granted.has("docs.read") || granted.has("drive.read")
    ? "For Google Meet notes or transcripts, load the reading-google-meeting-notes skill."
    : "";
}
